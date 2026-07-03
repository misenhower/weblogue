/*
 * Worklet-side arpeggiator. Plain TS class — the audio processor calls
 * process() once per render block; note events fire through ArpHooks,
 * block-quantized. See docs/xd-spec.md §3 (arp types + knob zones).
 *
 * Split from the step sequencer (dsp/stepseq.ts): the 'logue family divides
 * exactly there (monologue: seq, no arp; prologue: arp, no seq). The 13 type
 * behaviors are the family superset (xd's list); the rate arrives as beats
 * per step so this core has no dependency on any synth's rate menu.
 *
 * No allocation happens in process(); setConfig()/keyDown/keyUp are
 * control-path calls.
 */
import { clamp, fin, clampInt } from '../shared/maps'

export interface ArpHooks {
  noteOn(note: number, vel: number): void
  noteOff(note: number): void
}

export interface ArpConfig {
  enabled: boolean
  /** 0..12: MANUAL 1/2, RISE 1/2, FALL 1/2, RISE FALL 1/2, POLY 1/2, RANDOM 1/2/3. */
  typeIndex: number
  latch: boolean
  /** Arp step length in beats (quarter note = 1 beat). */
  rateBeats: number
  gate01: number
  swing: number
}

const NUM_ARP_TYPES = 13

const MAX_KEYS = 32 // arp key buffer
const PAT_CAP = 128 // RISE FALL 2 worst case: 4*MAX_KEYS - 2 = 126
const RNG_SEED = 0x1d872b41 // deterministic PRNG seed (stable tests)

export class Arp {
  private readonly sr: number
  private readonly hooks: ArpHooks

  private readonly cfg: ArpConfig = { enabled: false, typeIndex: 0, latch: false, rateBeats: 0.25, gate01: 0.75, swing: 0 }
  private readonly kNote = new Int32Array(MAX_KEYS) // insertion order
  private readonly kVel = new Int32Array(MAX_KEYS)
  private readonly kDown = new Uint8Array(MAX_KEYS) // physically held?
  private kCount = 0
  private readonly patNote = new Int32Array(PAT_CAP)
  private readonly patVel = new Int32Array(PAT_CAP)
  private patLen = 0
  private patDirty = true
  private readonly sortNote = new Int32Array(MAX_KEYS) // sort scratch
  private readonly sortVel = new Int32Array(MAX_KEYS)
  private active = false
  private phase = 0 // 0..1 inside the current arp step
  private pos = 0 // position in pattern
  private count = 0 // arp steps fired since start (swing parity, POLY 2 octave)
  private readonly aNote = new Int32Array(MAX_KEYS + 1) // sounding arp notes
  private readonly aOff = new Float64Array(MAX_KEYS + 1)
  private aCount = 0
  private rngState = RNG_SEED

  constructor(sampleRate: number, hooks: ArpHooks) {
    this.sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
    this.hooks = hooks
  }

  setConfig(cfg: ArpConfig): void {
    const c = this.cfg
    c.enabled = cfg.enabled === true
    c.typeIndex = clampInt(cfg.typeIndex, 0, NUM_ARP_TYPES - 1, 0)
    c.latch = cfg.latch === true
    const beats = fin(cfg.rateBeats, 0.25)
    c.rateBeats = beats > 0 ? beats : 0.25
    c.gate01 = clamp(fin(cfg.gate01, 0.75), 0, 1)
    c.swing = clamp(fin(cfg.swing, 0), -75, 75)
    if (!c.latch) {
      // Latch off: drop keys that are no longer physically held (keep order).
      let w = 0
      for (let k = 0; k < this.kCount; k++) {
        if (this.kDown[k]) {
          this.kNote[w] = this.kNote[k]
          this.kVel[w] = this.kVel[k]
          this.kDown[w] = 1
          w++
        }
      }
      this.kCount = w
    }
    this.patDirty = true
    if (this.active && (!c.enabled || this.kCount === 0)) this.stop()
  }

  keyDown(note: number, vel: number): void {
    if (!Number.isFinite(note) || !Number.isFinite(vel)) return
    const n = clampInt(note, 0, 127, 60)
    const v = clampInt(vel, 1, 127, 100)
    // Latch re-arms on the next press set: if every latched key is physically
    // up, a new press starts a fresh set.
    if (this.cfg.latch && this.kCount > 0 && this.downCount() === 0) this.kCount = 0
    const idx = this.keyIndex(n)
    if (idx >= 0) {
      this.kDown[idx] = 1
      this.kVel[idx] = v
    } else if (this.kCount < MAX_KEYS) {
      this.kNote[this.kCount] = n
      this.kVel[this.kCount] = v
      this.kDown[this.kCount] = 1
      this.kCount++
    }
    this.patDirty = true
  }

  keyUp(note: number): void {
    if (!Number.isFinite(note)) return
    const idx = this.keyIndex(Math.round(note))
    if (idx < 0) return
    if (this.cfg.latch) {
      this.kDown[idx] = 0 // keeps contributing (latched)
    } else {
      for (let k = idx; k < this.kCount - 1; k++) {
        this.kNote[k] = this.kNote[k + 1]
        this.kVel[k] = this.kVel[k + 1]
        this.kDown[k] = this.kDown[k + 1]
      }
      this.kCount--
      this.patDirty = true
      if (this.kCount === 0 && this.active) this.stop()
    }
  }

  heldCount(): number {
    return this.kCount
  }

  process(nFrames: number, bpm: number): void {
    if (!Number.isFinite(nFrames) || nFrames <= 0) return
    const b = clamp(fin(bpm, 120), 10, 300)
    const cfg = this.cfg
    if (this.active && (!cfg.enabled || this.kCount === 0)) this.stop()
    if (!this.active && cfg.enabled && this.kCount > 0) {
      this.active = true
      this.phase = 0
      this.pos = 0
      this.count = 0
      this.fireStep() // first note lands at the start of this block
    }
    if (!this.active) return
    let left = nFrames
    let guard = 0
    while (left > 0 && this.active && guard++ < 100000) {
      const dur = this.stepDurSamples(b)
      const target = this.phase + left / dur
      if (target < 1) {
        this.fireGateOffs(target)
        this.phase = target
        left = 0
      } else {
        left -= (1 - this.phase) * dur
        this.phase = 0
        this.fireStep()
      }
    }
  }

  /** Full silent reset (no hooks fired): clears keys and playback state. */
  reset(): void {
    this.kCount = 0
    this.patLen = 0
    this.patDirty = true
    this.active = false
    this.phase = 0
    this.pos = 0
    this.count = 0
    this.aCount = 0
    this.rngState = RNG_SEED
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private keyIndex(note: number): number {
    for (let k = 0; k < this.kCount; k++) if (this.kNote[k] === note) return k
    return -1
  }

  private downCount(): number {
    let c = 0
    for (let k = 0; k < this.kCount; k++) if (this.kDown[k]) c++
    return c
  }

  private stepDurSamples(bpm: number): number {
    const base = (60 / bpm) * this.cfg.rateBeats * this.sr
    const sw = this.cfg.swing / 100
    const idx = this.count > 0 ? this.count - 1 : 0 // current step index
    const mult = (idx & 1) === 0 ? 1 + sw * 0.5 : 1 - sw * 0.5
    const d = base * mult
    return d > 1 && Number.isFinite(d) ? d : 1
  }

  /**
   * Fire one arp step. Hardware "1/2" variant semantics are not officially
   * documented; these follow the accepted community interpretations:
   *   MANUAL 1 key press order; MANUAL 2 same over 2 octaves; RISE/FALL 1
   *   ascending/descending 1 octave, 2 = over 2 octaves (FALL 2 starts from
   *   the upper octave); RISE FALL up-then-down without repeating top/bottom;
   *   POLY 1 whole chord each step, POLY 2 chord alternating +0/+12 per step;
   *   RANDOM 1 random held note, RANDOM 2 random over 2 octaves, RANDOM 3
   *   random over 2 octaves plus random octave displacement and occasional
   *   velocity variation (deterministic PRNG so tests are stable).
   */
  private fireStep(): void {
    this.releaseAll()
    const n = this.kCount
    if (n === 0) {
      this.stop()
      return
    }
    const cfg = this.cfg
    const t = cfg.typeIndex
    const gate = cfg.gate01
    if (t <= 7) {
      if (this.patDirty) this.buildPattern()
      if (this.patLen > 0) {
        if (this.pos >= this.patLen) this.pos = 0
        this.trigger(this.patNote[this.pos], this.patVel[this.pos], gate)
        this.pos++
      }
    } else if (t === 8 || t === 9) {
      const shift = t === 9 && (this.count & 1) === 1 ? 12 : 0
      for (let k = 0; k < n; k++) this.trigger(this.kNote[k] + shift, this.kVel[k], gate)
    } else {
      const idx = Math.min(n - 1, Math.floor(this.rng01() * n))
      let note = this.kNote[idx]
      let vel = this.kVel[idx]
      if (t >= 11) note += this.rng01() < 0.5 ? 0 : 12 // RANDOM 2/3: 2 octaves
      if (t === 12) {
        const r = this.rng01()
        if (r < 0.15) note += 12
        else if (r < 0.3) note -= 12
        if (this.rng01() < 0.25) vel = Math.max(1, Math.floor(vel * 0.6))
      }
      this.trigger(note, vel, gate)
    }
    this.count++
  }

  private trigger(note: number, vel: number, gate01: number): void {
    let nn = note
    while (nn > 127) nn -= 12 // fold octave shifts back into MIDI range
    while (nn < 0) nn += 12
    this.hooks.noteOn(nn, vel)
    if (this.aCount < this.aNote.length) {
      this.aNote[this.aCount] = nn
      this.aOff[this.aCount] = gate01
      this.aCount++
    }
  }

  private fireGateOffs(phaseLimit: number): void {
    for (let k = this.aCount - 1; k >= 0; k--) {
      if (this.aOff[k] <= phaseLimit) {
        this.hooks.noteOff(this.aNote[k])
        const last = this.aCount - 1
        this.aNote[k] = this.aNote[last]
        this.aOff[k] = this.aOff[last]
        this.aCount = last
      }
    }
  }

  private releaseAll(): void {
    for (let k = this.aCount - 1; k >= 0; k--) this.hooks.noteOff(this.aNote[k])
    this.aCount = 0
  }

  private stop(): void {
    this.releaseAll()
    this.active = false
    this.phase = 0
    this.pos = 0
    this.count = 0
  }

  /** Build the note pattern for MANUAL/RISE/FALL/RISE FALL types. */
  private buildPattern(): void {
    this.patLen = 0
    this.patDirty = false
    const n = this.kCount
    if (n === 0) return
    const t = this.cfg.typeIndex
    switch (t) {
      case 0: // MANUAL 1
        this.pushKeys(0)
        break
      case 1: // MANUAL 2
        this.pushKeys(0)
        this.pushKeys(12)
        break
      case 2: // RISE 1
        this.sortKeysAsc()
        this.pushSorted(0, false)
        break
      case 3: // RISE 2
        this.sortKeysAsc()
        this.pushSorted(0, false)
        this.pushSorted(12, false)
        break
      case 4: // FALL 1
        this.sortKeysAsc()
        this.pushSorted(0, true)
        break
      case 5: // FALL 2 (upper octave first, then base)
        this.sortKeysAsc()
        this.pushSorted(12, true)
        this.pushSorted(0, true)
        break
      case 6: // RISE FALL 1
      case 7: {
        // RISE FALL 2
        this.sortKeysAsc()
        this.pushSorted(0, false)
        if (t === 7) this.pushSorted(12, false)
        // Down leg: interior only (no repeated top/bottom).
        const m = this.patLen
        for (let k = m - 2; k >= 1; k--) this.pushPat(this.patNote[k], this.patVel[k])
        break
      }
      default:
        break
    }
  }

  private pushPat(note: number, vel: number): void {
    if (this.patLen < PAT_CAP) {
      this.patNote[this.patLen] = note
      this.patVel[this.patLen] = vel
      this.patLen++
    }
  }

  private pushKeys(shift: number): void {
    for (let k = 0; k < this.kCount; k++) this.pushPat(this.kNote[k] + shift, this.kVel[k])
  }

  private sortKeysAsc(): void {
    const n = this.kCount
    for (let k = 0; k < n; k++) {
      this.sortNote[k] = this.kNote[k]
      this.sortVel[k] = this.kVel[k]
    }
    for (let a = 1; a < n; a++) {
      const nt = this.sortNote[a]
      const vl = this.sortVel[a]
      let b = a - 1
      while (b >= 0 && this.sortNote[b] > nt) {
        this.sortNote[b + 1] = this.sortNote[b]
        this.sortVel[b + 1] = this.sortVel[b]
        b--
      }
      this.sortNote[b + 1] = nt
      this.sortVel[b + 1] = vl
    }
  }

  private pushSorted(shift: number, reverse: boolean): void {
    const n = this.kCount
    if (reverse) {
      for (let k = n - 1; k >= 0; k--) this.pushPat(this.sortNote[k] + shift, this.sortVel[k])
    } else {
      for (let k = 0; k < n; k++) this.pushPat(this.sortNote[k] + shift, this.sortVel[k])
    }
  }

  /** xorshift32, constant seed: deterministic RANDOM arp for stable tests. */
  private rng01(): number {
    let x = this.rngState | 0
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.rngState = x | 0
    return (x >>> 0) / 4294967296
  }
}
