/*
 * VoiceBank + NoteStack — synth-agnostic voice-allocation mechanics.
 *
 * Extracted from the xd engine for reuse across 'logue-family definitions.
 * The bank owns per-voice bookkeeping (key/note identity, generation aging,
 * released/sustained/stacked flags), hardware-style round-robin allocation,
 * steal-with-kill-ramp + pended restarts, and pair allocation for DUO-style
 * modes. What a voice mode MEANS (poly vs unison vs chord semantics, detune
 * spreads, chord tables) stays in the per-synth engine — the engine decides
 * WHAT to start; the bank tracks WHERE and WHEN it may start.
 *
 * No allocation on the audio thread: all state is preallocated arrays.
 */

/** What the bank needs from a voice. */
export interface BankVoice {
  readonly active: boolean
  /** ~ms-scale kill ramp for steals; bank restarts the voice once inactive. */
  kill(): void
  /** Gate release (enter release stage). */
  noteOff(): void
}

export class VoiceBank<V extends BankVoice> {
  readonly voices: readonly V[]
  private readonly nv: number

  private readonly vKey: Int32Array // external key identity, -1 = none
  private readonly vNote: Int32Array // sounding note (pre-tuning)
  private readonly vGen: Float64Array
  private readonly vReleased: Uint8Array
  private readonly vSustained: Uint8Array
  private readonly vStacked: Uint8Array // stacked-voice marker (e.g. DUO)
  private gen = 0
  private rotor = 0
  private pairRotor = 0

  // Pending restarts after a steal (fired once the kill ramp finishes).
  private readonly pendFlag: Uint8Array
  private readonly pendKey: Int32Array
  private readonly pendNote: Int32Array
  private readonly pendVel: Int32Array
  private readonly pendDet: Float64Array
  private readonly pendGain: Float64Array
  private readonly pendStk: Uint8Array
  private readonly pendGlide: Uint8Array

  constructor(voices: readonly V[]) {
    this.voices = voices
    const nv = voices.length
    this.nv = nv
    this.vKey = new Int32Array(nv).fill(-1)
    this.vNote = new Int32Array(nv)
    this.vGen = new Float64Array(nv)
    this.vReleased = new Uint8Array(nv)
    this.vSustained = new Uint8Array(nv)
    this.vStacked = new Uint8Array(nv)
    this.pendFlag = new Uint8Array(nv)
    this.pendKey = new Int32Array(nv)
    this.pendNote = new Int32Array(nv)
    this.pendVel = new Int32Array(nv)
    this.pendDet = new Float64Array(nv)
    this.pendGain = new Float64Array(nv)
    this.pendStk = new Uint8Array(nv)
    this.pendGlide = new Uint8Array(nv)
  }

  get size(): number {
    return this.nv
  }

  keyOf(i: number): number {
    return this.vKey[i]
  }

  noteOf(i: number): number {
    return this.vNote[i]
  }

  isReleased(i: number): boolean {
    return this.vReleased[i] === 1
  }

  isStacked(i: number): boolean {
    return this.vStacked[i] === 1
  }

  isPending(i: number): boolean {
    return this.pendFlag[i] === 1
  }

  /** Idle voice via hardware-style round-robin, else oldest gate-released
   *  voice; -1 = all busy (caller must steal). */
  alloc(): number {
    for (let j = 0; j < this.nv; j++) {
      const i = (this.rotor + j) % this.nv
      if (!this.voices[i].active && !this.pendFlag[i]) {
        this.rotor = (i + 1) % this.nv
        return i
      }
    }
    let best = -1
    let bestGen = Infinity
    for (let i = 0; i < this.nv; i++) {
      if (this.vReleased[i] && !this.pendFlag[i] && this.vGen[i] < bestGen) {
        bestGen = this.vGen[i]
        best = i
      }
    }
    if (best >= 0) this.rotor = (best + 1) % this.nv
    return best
  }

  /** Oldest voice by generation (steal target when alloc() fails). */
  oldest(): number {
    let best = 0
    let bestGen = Infinity
    for (let i = 0; i < this.nv; i++) {
      if (this.vGen[i] < bestGen) {
        bestGen = this.vGen[i]
        best = i
      }
    }
    return best
  }

  /** Claim `count` consecutive round-robin voice indices (chord-style voice
   *  set rotation); returns the first index, advancing the rotor by count. */
  takeRotor(count: number): number {
    const start = this.rotor
    this.rotor = (this.rotor + count) % this.nv
    return start
  }

  /**
   * DUO-style pair allocation over pairs (0,1)/(2,3)/...: idle pair via the
   * pair rotor, else oldest fully-released pair, else oldest pair to steal.
   */
  allocPair(): { pair: number; kind: 'idle' | 'released' | 'steal' } {
    const pairs = this.nv >> 1
    for (let q = 0; q < pairs; q++) {
      const p = (this.pairRotor + q) % pairs
      const a = p * 2
      if (!this.voices[a].active && !this.voices[a + 1].active && !this.pendFlag[a] && !this.pendFlag[a + 1]) {
        this.pairRotor = (p + 1) % pairs
        return { pair: p, kind: 'idle' }
      }
    }
    let best = 0
    let bestGen = Infinity
    let released = -1
    let relGen = Infinity
    for (let p = 0; p < pairs; p++) {
      const a = p * 2
      const g = Math.max(this.vGen[a], this.vGen[a + 1])
      const rel =
        (this.vReleased[a] || !this.voices[a].active) &&
        (this.vReleased[a + 1] || !this.voices[a + 1].active)
      if (rel && g < relGen) {
        relGen = g
        released = p
      }
      if (g < bestGen) {
        bestGen = g
        best = p
      }
    }
    if (released >= 0) return { pair: released, kind: 'released' }
    return { pair: best, kind: 'steal' }
  }

  /** Steal: kill the voice now, remember the restart for drainPend(). */
  steal(
    i: number, key: number, soundNote: number, vel: number,
    glide: boolean, det: number, gain: number, stacked: boolean,
  ): void {
    this.voices[i].kill()
    this.pendFlag[i] = 1
    this.pendKey[i] = key
    this.pendNote[i] = soundNote
    this.pendVel[i] = vel
    this.pendDet[i] = det
    this.pendGain[i] = gain
    this.pendStk[i] = stacked ? 1 : 0
    this.pendGlide[i] = glide ? 1 : 0
    this.vKey[i] = key
    this.vNote[i] = soundNote
    this.vGen[i] = ++this.gen
    this.vReleased[i] = 0
    this.vSustained[i] = 0
    this.vStacked[i] = stacked ? 1 : 0
  }

  /** Bookkeeping after the engine actually (re)starts voice i. */
  started(i: number, key: number, soundNote: number, stacked: boolean): void {
    this.vKey[i] = key
    this.vNote[i] = soundNote
    this.vGen[i] = ++this.gen
    this.vReleased[i] = 0
    this.vSustained[i] = 0
    this.vStacked[i] = stacked ? 1 : 0
    this.pendFlag[i] = 0
  }

  /**
   * Fire pended (post-steal) restarts whose kill ramp has finished. The
   * callback performs the synth-specific voice start and must end by calling
   * started(i, ...) (which clears the pend flag).
   */
  drainPend(
    cb: (i: number, key: number, note: number, vel: number, glide: boolean, det: number, gain: number, stacked: boolean) => void,
  ): void {
    for (let i = 0; i < this.nv; i++) {
      if (this.pendFlag[i] && !this.voices[i].active) {
        cb(
          i, this.pendKey[i], this.pendNote[i], this.pendVel[i],
          this.pendGlide[i] === 1, this.pendDet[i], this.pendGain[i], this.pendStk[i] === 1,
        )
      }
    }
  }

  /** Gate-release voice i (enters release; stays 'sounding'). */
  gateOff(i: number): void {
    this.voices[i].noteOff()
    this.vReleased[i] = 1
  }

  /**
   * Generic poly key release: releases (or defers, damper down) every voice
   * holding `key`; a pended restart whose key is released before it fired is
   * simply cancelled.
   */
  releaseKey(key: number, sustain: boolean): void {
    for (let i = 0; i < this.nv; i++) {
      if (this.vKey[i] === key && !this.vReleased[i]) {
        if (this.pendFlag[i]) {
          this.pendFlag[i] = 0 // key released before the stolen restart fired
          this.vKey[i] = -1
        } else if (sustain) {
          this.vSustained[i] = 1
        } else if (this.voices[i].active) {
          this.gateOff(i)
        }
      }
    }
  }

  /** Release all gated voices (deferring while the damper is down). */
  releaseAll(sustain: boolean): void {
    for (let i = 0; i < this.nv; i++) {
      this.pendFlag[i] = 0
      if (this.voices[i].active && !this.vReleased[i]) {
        if (sustain) this.vSustained[i] = 1
        else this.gateOff(i)
      }
    }
  }

  /** Hard release (all-notes-off): ignores the damper, clears deferrals. */
  hardReleaseAll(): void {
    for (let i = 0; i < this.nv; i++) {
      this.pendFlag[i] = 0
      this.vSustained[i] = 0
      if (this.voices[i].active && !this.vReleased[i]) this.gateOff(i)
    }
  }

  /** Pedal-up: release voices whose keys are no longer held anywhere. */
  flushSustained(stillHeld: (key: number) => boolean): void {
    for (let i = 0; i < this.nv; i++) {
      if (this.vSustained[i]) {
        this.vSustained[i] = 0
        if (!stillHeld(this.vKey[i])) this.gateOff(i)
      }
    }
  }

  activeCount(): number {
    let c = 0
    for (let i = 0; i < this.nv; i++) if (this.voices[i].active) c++
    return c
  }

  /** Gated (non-released) note keys, deduped, for key/LED feedback. */
  collectActiveNotes(dst: number[]): number {
    dst.length = 0
    for (let i = 0; i < this.nv; i++) {
      if (this.voices[i].active && !this.vReleased[i] && this.vKey[i] >= 0 && !this.vStacked[i]) {
        const k = this.vKey[i]
        let dup = false
        for (let j = 0; j < dst.length; j++) {
          if (dst[j] === k) {
            dup = true
            break
          }
        }
        if (!dup) dst.push(k)
      }
    }
    return dst.length
  }
}

const STACK_CAP = 64

/**
 * NoteStack — gated-key model for legato detection, mono last-note priority
 * and damper-deferred releases: the ordered key stack, the physically-held
 * bitmap, and the mono-mode pedal-deferral bitmap.
 */
export class NoteStack {
  private readonly stackNote = new Int32Array(STACK_CAP)
  private readonly stackVel = new Int32Array(STACK_CAP)
  private _count = 0
  private readonly physHeld = new Uint8Array(128)
  /** Mono-mode keys released while the damper is down (deferred). */
  private readonly monoSustained = new Uint8Array(128)

  get count(): number {
    return this._count
  }

  push(note: number, vel: number): void {
    if (this._count >= STACK_CAP) {
      for (let k = 1; k < STACK_CAP; k++) {
        this.stackNote[k - 1] = this.stackNote[k]
        this.stackVel[k - 1] = this.stackVel[k]
      }
      this._count = STACK_CAP - 1
    }
    this.stackNote[this._count] = note
    this.stackVel[this._count] = vel
    this._count++
  }

  remove(note: number): void {
    for (let k = this._count - 1; k >= 0; k--) {
      if (this.stackNote[k] === note) {
        for (let j = k + 1; j < this._count; j++) {
          this.stackNote[j - 1] = this.stackNote[j]
          this.stackVel[j - 1] = this.stackVel[j]
        }
        this._count--
        return
      }
    }
  }

  contains(note: number): boolean {
    for (let k = 0; k < this._count; k++) if (this.stackNote[k] === note) return true
    return false
  }

  topNote(): number {
    return this._count > 0 ? this.stackNote[this._count - 1] : -1
  }

  topVel(): number {
    return this._count > 0 ? this.stackVel[this._count - 1] : 0
  }

  clear(): void {
    this._count = 0
  }

  // ---- physically-held keys ----

  setHeld(note: number, on: boolean): void {
    this.physHeld[note] = on ? 1 : 0
  }

  isHeld(note: number): boolean {
    return this.physHeld[note] === 1
  }

  /** Clear every held key, invoking cb per formerly-held note. */
  clearHeld(cb?: (note: number) => void): void {
    for (let n = 0; n < 128; n++) {
      if (this.physHeld[n]) {
        this.physHeld[n] = 0
        if (cb) cb(n)
      }
    }
  }

  // ---- mono-mode damper deferrals ----

  setMonoSustained(note: number, on: boolean): void {
    this.monoSustained[note] = on ? 1 : 0
  }

  isMonoSustained(note: number): boolean {
    return this.monoSustained[note] === 1
  }

  clearMonoSustained(): void {
    this.monoSustained.fill(0)
  }

  /**
   * Pedal-up flush of mono-mode deferred releases: invokes release(note) for
   * every deferred, no-longer-held key — the current mono note LAST so a
   * legato fall-back never retriggers a note that is itself being released.
   */
  flushMonoSustained(curMonoNote: number, release: (note: number) => void): void {
    let cur = -1
    for (let n = 0; n < 128; n++) {
      if (this.monoSustained[n]) {
        this.monoSustained[n] = 0
        if (this.physHeld[n]) continue
        if (n === curMonoNote) cur = n
        else release(n)
      }
    }
    if (cur >= 0) release(cur)
  }
}
