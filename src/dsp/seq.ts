/*
 * Worklet-side sequencer + arpeggiator + motion-sequence playback engine.
 *
 * Plain TS class — no worklet globals; the audio processor calls process()
 * once per render block (<= 128 frames) and receives note/motion/step events
 * through SeqHooks callbacks, block-quantized (tighter than the hardware
 * needs). See docs/xd-spec.md §11 (sequencer/motion) and §3 (arpeggiator).
 *
 * No allocation happens in process(); all per-block state lives in fixed
 * arrays. setSeq()/setArp()/arpKey* are control-path calls and may allocate.
 */
import type { SeqData } from '../shared/program'
import {
  initSeq,
  NUM_STEPS,
  NUM_MOTION_LANES,
  NOTES_PER_STEP,
  MOTION_POINTS,
  STEP_RESOLUTIONS,
  gateTo01,
  isTie,
} from '../shared/program'
import { MOTION_PITCH_BEND, MOTION_GATE_TIME } from '../shared/paramdef'
import { PARAMS } from '../synths/xd/params'
import { ARP_RATES, ARP_TYPES } from '../synths/xd/curves'
import { clamp } from '../shared/maps'

export interface SeqHooks {
  noteOn(note: number, vel: number): void
  noteOff(note: number): void
  motionValue(paramId: number, value: number): void // raw param units; MOTION_PITCH_BEND value is -1..1 (MOTION_GATE_TIME never emits: consumed internally as a gate override)
  stepChanged(i: number): void // playhead for UI (-1 when stopped)
}

// ---------------------------------------------------------------------------
// helpers (module-private)
// ---------------------------------------------------------------------------

function fin(v: number, def: number): number {
  return Number.isFinite(v) ? v : def
}

function clampInt(v: number, lo: number, hi: number, def: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : def
}

/** Deep-copy + sanitize a SeqData into a fully-shaped, finite structure. */
function sanitizeSeq(src: SeqData): SeqData {
  const defaultGate = clampInt(src.defaultGate, 0, 72, 54)
  const activeSteps: boolean[] = []
  const steps: SeqData['steps'] = []
  for (let i = 0; i < NUM_STEPS; i++) {
    activeSteps.push(src.activeSteps ? src.activeSteps[i] !== false : true)
    const st = src.steps ? src.steps[i] : undefined
    const notes: number[] = []
    const vels: number[] = []
    const gates: number[] = []
    if (st && Array.isArray(st.notes)) {
      for (let j = 0; j < st.notes.length && notes.length < NOTES_PER_STEP; j++) {
        const n = st.notes[j]
        if (!Number.isFinite(n)) continue
        notes.push(clampInt(n, 0, 127, 60))
        vels.push(clampInt(Array.isArray(st.vels) ? st.vels[j] : 100, 1, 127, 100))
        gates.push(clampInt(Array.isArray(st.gates) ? st.gates[j] : defaultGate, 0, 127, defaultGate))
      }
    }
    steps.push({ on: !!st && st.on === true && notes.length > 0, notes, vels, gates })
  }
  const motion: SeqData['motion'] = []
  for (let l = 0; l < NUM_MOTION_LANES; l++) {
    const lane = src.motion ? src.motion[l] : undefined
    const data: (number[] | null)[] = []
    for (let i = 0; i < NUM_STEPS; i++) {
      const d = lane && Array.isArray(lane.data) ? lane.data[i] : null
      if (Array.isArray(d) && d.length > 0 && Number.isFinite(d[0])) {
        const pts: number[] = []
        for (let k = 0; k < MOTION_POINTS; k++) {
          const v = d[k]
          pts.push(typeof v === 'number' && Number.isFinite(v) ? v : pts[pts.length - 1] ?? 0)
        }
        data.push(pts)
      } else {
        data.push(null)
      }
    }
    motion.push({
      paramId: lane && Number.isFinite(lane.paramId) ? Math.round(lane.paramId) : -1,
      on: !!lane && lane.on === true,
      smooth: !!lane && lane.smooth === true,
      data,
    })
  }
  return {
    bpm: clamp(fin(src.bpm, 120), 10, 300),
    stepLength: clampInt(src.stepLength, 1, NUM_STEPS, NUM_STEPS),
    stepResolution: clampInt(src.stepResolution, 0, STEP_RESOLUTIONS.length - 1, 0),
    swing: clampInt(src.swing, -75, 75, 0),
    defaultGate,
    activeSteps,
    steps,
    motion,
  }
}

/** Is this a valid motion target (real param id or virtual bend/gate-time)? */
function isMotionTarget(pid: number): boolean {
  if (pid === MOTION_PITCH_BEND || pid === MOTION_GATE_TIME) return true
  return pid >= 0 && pid < PARAMS.length && !!PARAMS[pid]
}

/** Continuous (smoothable) target? Switch-type params never interpolate. */
function isSmoothTarget(pid: number): boolean {
  if (pid === MOTION_PITCH_BEND || pid === MOTION_GATE_TIME) return true
  const m = PARAMS[pid]
  return !!m && !!m.motionSmooth
}

const SND_CAP = 16 // sounding seq notes (hardware max 8/step; headroom for safety)
const MAX_KEYS = 32 // arp key buffer
const PAT_CAP = 128 // RISE FALL 2 worst case: 4*MAX_KEYS - 2 = 126
const RNG_SEED = 0x1d872b41 // deterministic PRNG seed (stable tests)

// ---------------------------------------------------------------------------
// Sequencer
// ---------------------------------------------------------------------------

export class Sequencer {
  private readonly sr: number
  private readonly hooks: SeqHooks

  /** Live sequence (owned deep copy). bpm/swing/defaultGate are read live. */
  private seq: SeqData

  // Timing fields latched at step boundaries (setSeq while playing defers these).
  private stepLength = NUM_STEPS
  private resIndex = 0
  private readonly activeMask = new Uint8Array(NUM_STEPS)

  private _playing = false
  private stepIdx = -1 // ORIGINAL step index (0..15), -1 = stopped/idle
  private phase = 0 // 0..1 inside the current step (bpm-change safe)
  private playedCount = 0 // played-step counter since cycle start (swing parity)

  // Sounding sequencer notes.
  private readonly sNote = new Int32Array(SND_CAP)
  private readonly sTie = new Uint8Array(SND_CAP)
  private readonly sOff = new Float64Array(SND_CAP) // gate-off phase (0..1)
  private sCount = 0
  private readonly contMask = new Uint8Array(NOTES_PER_STEP) // TIE-continuation scratch

  // GATE TIME modifiers (spec §11/§12): per-step lane override + live joystick offset.
  private gateOverride = -1 // this step's GATE TIME lane value (0..127), -1 = none
  private gateOffset = 0 // joystick GATE TIME offset, raw gate units -72..72

  // Motion lane playback state (points reference our owned deep copy).
  private readonly mPts: (number[] | null)[]
  private readonly mSmooth = new Uint8Array(NUM_MOTION_LANES)
  private readonly mLast = new Float64Array(NUM_MOTION_LANES) // NaN = nothing sent

  // Arpeggiator.
  private readonly arpCfg = { enabled: false, typeIndex: 0, latch: false, rateIndex: 4, gate01: 0.75, swing: 0 }
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
  private arpActive = false
  private arpPhase = 0 // 0..1 inside the current arp step
  private arpPos = 0 // position in pattern
  private arpCount = 0 // arp steps fired since start (swing parity, POLY 2 octave)
  private readonly aNote = new Int32Array(MAX_KEYS + 1) // sounding arp notes
  private readonly aOff = new Float64Array(MAX_KEYS + 1)
  private aCount = 0
  private rngState = RNG_SEED

  constructor(sampleRate: number, hooks: SeqHooks) {
    this.sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
    this.hooks = hooks
    this.seq = sanitizeSeq(initSeq())
    this.mPts = new Array<number[] | null>(NUM_MOTION_LANES).fill(null)
    this.mLast.fill(NaN)
    this.latchTiming()
  }

  get playing(): boolean {
    return this._playing
  }

  get currentStep(): number {
    return this._playing ? this.stepIdx : -1
  }

  /**
   * Deep-copies; safe while playing. Note/motion content, bpm, swing and
   * default gate apply immediately; stepLength / stepResolution / activeSteps
   * latch at the next step boundary (clock phase stays continuous).
   */
  setSeq(seq: SeqData): void {
    const copy = sanitizeSeq(seq)
    this.seq = copy
    if (this._playing && this.stepIdx >= 0) {
      // Re-point in-flight smooth motion lanes at the new content.
      for (let l = 0; l < NUM_MOTION_LANES; l++) {
        if (!this.mSmooth[l]) continue
        const lane = copy.motion[l]
        const d = lane && lane.on ? lane.data[this.stepIdx] : null
        if (lane && d && lane.smooth && isMotionTarget(lane.paramId) && isSmoothTarget(lane.paramId)) {
          this.mPts[l] = d
        } else {
          this.mSmooth[l] = 0
          this.mPts[l] = null
        }
      }
    } else {
      this.latchTiming()
    }
  }

  /** Stopping releases all seq-held notes and fires stepChanged(-1). */
  setPlaying(on: boolean): void {
    if (on === this._playing) return
    if (on) {
      this._playing = true
      this.stepIdx = -1
      this.phase = 0
      this.playedCount = 0
      this.resetMotionState()
      this.tryStart()
    } else {
      this._playing = false
      this.releaseAllSeq()
      this.stepIdx = -1
      this.phase = 0
      this.resetMotionState()
      this.hooks.stepChanged(-1)
    }
  }

  setArp(cfg: { enabled: boolean; typeIndex: number; latch: boolean; rateIndex: number; gate01: number; swing: number }): void {
    const c = this.arpCfg
    c.enabled = cfg.enabled === true
    c.typeIndex = clampInt(cfg.typeIndex, 0, ARP_TYPES.length - 1, 0)
    c.latch = cfg.latch === true
    c.rateIndex = clampInt(cfg.rateIndex, 0, ARP_RATES.length - 1, 4)
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
    if (this.arpActive && (!c.enabled || this.kCount === 0)) this.stopArp()
  }

  arpKeyDown(note: number, vel: number): void {
    if (!Number.isFinite(note) || !Number.isFinite(vel)) return
    const n = clampInt(note, 0, 127, 60)
    const v = clampInt(vel, 1, 127, 100)
    // Latch re-arms on the next press set: if every latched key is physically
    // up, a new press starts a fresh set.
    if (this.arpCfg.latch && this.kCount > 0 && this.downCount() === 0) this.kCount = 0
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

  arpKeyUp(note: number): void {
    if (!Number.isFinite(note)) return
    const idx = this.keyIndex(Math.round(note))
    if (idx < 0) return
    if (this.arpCfg.latch) {
      this.kDown[idx] = 0 // keeps contributing (latched)
    } else {
      for (let k = idx; k < this.kCount - 1; k++) {
        this.kNote[k] = this.kNote[k + 1]
        this.kVel[k] = this.kVel[k + 1]
        this.kDown[k] = this.kDown[k + 1]
      }
      this.kCount--
      this.patDirty = true
      if (this.kCount === 0 && this.arpActive) this.stopArp()
    }
  }

  arpHeldCount(): number {
    return this.kCount
  }

  /** Live GATE TIME joystick offset in raw gate units (-72..72); applied to
   *  non-TIE gates as steps trigger (spec §12 Y assign "GATE TIME"). */
  setGateTimeOffset(off: number): void {
    this.gateOffset = clamp(fin(off, 0), -72, 72)
  }

  process(nFrames: number): void {
    if (!Number.isFinite(nFrames) || nFrames <= 0) return
    const bpm = this.seq.bpm // sanitized 10..300; applies immediately
    this.processSeq(nFrames, bpm)
    this.processArp(nFrames, bpm)
  }

  /** Full silent reset (no hooks fired): stops playback, clears keys/state. */
  reset(): void {
    this._playing = false
    this.stepIdx = -1
    this.phase = 0
    this.playedCount = 0
    this.sCount = 0
    this.resetMotionState()
    this.kCount = 0
    this.patLen = 0
    this.patDirty = true
    this.arpActive = false
    this.arpPhase = 0
    this.arpPos = 0
    this.arpCount = 0
    this.aCount = 0
    this.rngState = RNG_SEED
    this.latchTiming()
  }

  // -------------------------------------------------------------------------
  // Sequencer internals
  // -------------------------------------------------------------------------

  private latchTiming(): void {
    const s = this.seq
    this.stepLength = clampInt(s.stepLength, 1, NUM_STEPS, NUM_STEPS)
    this.resIndex = clampInt(s.stepResolution, 0, STEP_RESOLUTIONS.length - 1, 0)
    for (let i = 0; i < NUM_STEPS; i++) this.activeMask[i] = s.activeSteps[i] ? 1 : 0
  }

  private resetMotionState(): void {
    this.gateOverride = -1
    for (let l = 0; l < NUM_MOTION_LANES; l++) {
      this.mPts[l] = null
      this.mSmooth[l] = 0
      this.mLast[l] = NaN
    }
  }

  /**
   * Swing -75..+75 shifts every second played step later by swing% of half a
   * step: even played index lasts base*(1+s/200), odd lasts base*(1-s/200).
   */
  private seqStepDurSamples(bpm: number): number {
    const res = STEP_RESOLUTIONS[this.resIndex] ?? STEP_RESOLUTIONS[0]
    const base = (60 / bpm) * res.beatsPerStep * this.sr
    const sw = this.seq.swing / 100
    const mult = (this.playedCount & 1) === 0 ? 1 + sw * 0.5 : 1 - sw * 0.5
    const d = base * mult
    return d > 1 && Number.isFinite(d) ? d : 1
  }

  private processSeq(nFrames: number, bpm: number): void {
    if (!this._playing) return
    if (this.stepIdx < 0 && !this.tryStart()) return
    let left = nFrames
    let guard = 0
    while (left > 0 && this._playing && this.stepIdx >= 0 && guard++ < 100000) {
      const dur = this.seqStepDurSamples(bpm)
      const target = this.phase + left / dur
      if (target < 1) {
        this.fireSeqGateOffs(target)
        this.phase = target
        left = 0
      } else {
        left -= (1 - this.phase) * dur
        this.fireSeqGateOffs(1) // every non-tie gate ends at or before step end
        this.phase = 0
        this.advanceStep()
      }
    }
    if (this._playing && this.stepIdx >= 0) this.emitSmoothMotion(this.phase)
  }

  /** Enter the first active step (used at start and when re-armed idle). */
  private tryStart(): boolean {
    this.latchTiming()
    for (let i = 0; i < this.stepLength; i++) {
      if (this.activeMask[i]) {
        this.playedCount = 0
        this.phase = 0
        this.enterStep(i)
        return true
      }
    }
    return false
  }

  private advanceStep(): void {
    this.latchTiming() // deferred timing fields apply at the boundary
    const len = this.stepLength
    let next = -1
    let wrapped = false
    for (let k = 1; k <= len; k++) {
      const pos = this.stepIdx + k
      const i = pos % len
      if (this.activeMask[i]) {
        next = i
        wrapped = pos >= len
        break
      }
    }
    if (next < 0) {
      // No active steps at all: go idle (re-starts if steps get re-enabled).
      this.releaseAllSeq()
      this.stepIdx = -1
      this.hooks.stepChanged(-1)
      return
    }
    this.playedCount = wrapped ? 0 : this.playedCount + 1
    this.enterStep(next)
  }

  private enterStep(i: number): void {
    this.stepIdx = i
    this.hooks.stepChanged(i) // ORIGINAL index for the step LEDs
    const st = this.seq.steps[i]
    const noteStep = !!st && st.on && st.notes.length > 0
    // Motion lanes first: a GATE TIME lane sets this step's gate override.
    this.gateOverride = -1
    for (let l = 0; l < NUM_MOTION_LANES; l++) this.laneStepStart(l, i)
    // A step that contains notes releases everything still sounding — except
    // sounding TIED notes that reappear in this step, which continue without
    // retriggering under the new step's gate (spec §11: "TIE + next-step
    // trigger 0 ⇒ note continues"). Rest steps let ties keep ringing.
    if (noteStep && st) {
      const n = Math.min(st.notes.length, NOTES_PER_STEP)
      this.contMask.fill(0)
      for (let k = this.sCount - 1; k >= 0; k--) {
        let cont = -1
        if (this.sTie[k]) {
          for (let j = 0; j < n; j++) {
            if (!this.contMask[j] && st.notes[j] === this.sNote[k]) {
              cont = j
              break
            }
          }
        }
        if (cont >= 0) {
          // Continuation: adopt the new gate (which may chain another TIE).
          this.contMask[cont] = 1
          const gate = this.effGate(st.gates[cont])
          this.sTie[k] = isTie(gate) ? 1 : 0
          this.sOff[k] = gateTo01(gate)
        } else {
          this.hooks.noteOff(this.sNote[k])
          this.removeSeqSound(k)
        }
      }
      for (let j = 0; j < n; j++) {
        if (this.contMask[j]) continue
        const gate = this.effGate(st.gates[j])
        this.hooks.noteOn(st.notes[j], st.vels[j])
        if (this.sCount < SND_CAP) {
          this.sNote[this.sCount] = st.notes[j]
          this.sTie[this.sCount] = isTie(gate) ? 1 : 0
          this.sOff[this.sCount] = gateTo01(gate)
          this.sCount++
        }
      }
    }
  }

  /** Effective per-note gate: GATE TIME lane override, then joystick offset
   *  (offsets never turn a gate into a TIE, and TIEs stay TIEs). */
  private effGate(gate: number): number {
    let g = this.gateOverride >= 0 ? this.gateOverride : gate
    if (!isTie(g) && this.gateOffset !== 0) {
      g = Math.max(0, Math.min(72, Math.round(g + this.gateOffset)))
    }
    return g
  }

  private fireSeqGateOffs(phaseLimit: number): void {
    for (let k = this.sCount - 1; k >= 0; k--) {
      if (!this.sTie[k] && this.sOff[k] <= phaseLimit) {
        this.hooks.noteOff(this.sNote[k])
        this.removeSeqSound(k)
      }
    }
  }

  private releaseAllSeq(): void {
    for (let k = this.sCount - 1; k >= 0; k--) this.hooks.noteOff(this.sNote[k])
    this.sCount = 0
  }

  private removeSeqSound(k: number): void {
    const last = this.sCount - 1
    this.sNote[k] = this.sNote[last]
    this.sTie[k] = this.sTie[last]
    this.sOff[k] = this.sOff[last]
    this.sCount = last
  }

  // ---- motion lanes ----

  private laneStepStart(l: number, i: number): void {
    const lane = this.seq.motion[l]
    this.mPts[l] = null
    this.mSmooth[l] = 0
    if (!lane || !lane.on) return
    const pid = lane.paramId
    if (!isMotionTarget(pid)) return
    const d = lane.data[i]
    if (!d) return // no data recorded: parameter stays wherever it is
    const v0 = d[0]
    if (!Number.isFinite(v0)) return
    if (pid === MOTION_GATE_TIME) {
      // Consumed here, not by the engine: overrides this step's note gates
      // (0..72 = 0-100%, >= GATE_TIE = TIE), spec §11.
      this.gateOverride = Math.max(0, Math.min(127, Math.round(v0)))
      return
    }
    if (lane.smooth && isSmoothTarget(pid)) {
      // p1→p2 over the first quarter of the step, p2→p3, p3→p4, p4→p5 [OM]
      this.mPts[l] = d
      this.mSmooth[l] = 1
    }
    // Smooth off (or switch-type param): just point 1, once, at step start.
    this.sendMotion(l, pid, v0)
  }

  /** Once per process() call: interpolate active smooth lanes, deduped. */
  private emitSmoothMotion(phase: number): void {
    const p = phase < 0 ? 0 : phase > 1 ? 1 : phase
    for (let l = 0; l < NUM_MOTION_LANES; l++) {
      if (!this.mSmooth[l]) continue
      const pts = this.mPts[l]
      const lane = this.seq.motion[l]
      if (!pts || !lane) continue
      const pid = lane.paramId
      const seg = p >= 1 ? 3 : Math.floor(p * 4)
      const t = p * 4 - seg
      const a = pts[seg]
      const b = pts[seg + 1]
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue
      const v = a + (b - a) * t
      const last = this.mLast[l]
      // Dedupe: bend re-emits on any change; others need >= 0.5 raw units.
      const changed = pid === MOTION_PITCH_BEND ? v !== last : !(Math.abs(v - last) < 0.5)
      if (changed) this.sendMotion(l, pid, v)
    }
  }

  private sendMotion(l: number, pid: number, v: number): void {
    this.mLast[l] = v
    let out = v
    if (pid === MOTION_PITCH_BEND) out = clamp(v, -1, 1)
    else if (pid === MOTION_GATE_TIME) out = clamp(v, 0, 72)
    this.hooks.motionValue(pid, out)
  }

  // -------------------------------------------------------------------------
  // Arpeggiator internals
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

  private arpStepDurSamples(bpm: number): number {
    const rate = ARP_RATES[this.arpCfg.rateIndex] ?? ARP_RATES[4]
    const base = (60 / bpm) * rate.beats * this.sr
    const sw = this.arpCfg.swing / 100
    const idx = this.arpCount > 0 ? this.arpCount - 1 : 0 // current step index
    const mult = (idx & 1) === 0 ? 1 + sw * 0.5 : 1 - sw * 0.5
    const d = base * mult
    return d > 1 && Number.isFinite(d) ? d : 1
  }

  private processArp(nFrames: number, bpm: number): void {
    const cfg = this.arpCfg
    if (this.arpActive && (!cfg.enabled || this.kCount === 0)) this.stopArp()
    if (!this.arpActive && cfg.enabled && this.kCount > 0) {
      this.arpActive = true
      this.arpPhase = 0
      this.arpPos = 0
      this.arpCount = 0
      this.fireArpStep() // first note lands at the start of this block
    }
    if (!this.arpActive) return
    let left = nFrames
    let guard = 0
    while (left > 0 && this.arpActive && guard++ < 100000) {
      const dur = this.arpStepDurSamples(bpm)
      const target = this.arpPhase + left / dur
      if (target < 1) {
        this.fireArpGateOffs(target)
        this.arpPhase = target
        left = 0
      } else {
        left -= (1 - this.arpPhase) * dur
        this.arpPhase = 0
        this.fireArpStep()
      }
    }
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
  private fireArpStep(): void {
    this.releaseArpAll()
    const n = this.kCount
    if (n === 0) {
      this.stopArp()
      return
    }
    const cfg = this.arpCfg
    const t = cfg.typeIndex
    const gate = cfg.gate01
    if (t <= 7) {
      if (this.patDirty) this.buildPattern()
      if (this.patLen > 0) {
        if (this.arpPos >= this.patLen) this.arpPos = 0
        this.triggerArp(this.patNote[this.arpPos], this.patVel[this.arpPos], gate)
        this.arpPos++
      }
    } else if (t === 8 || t === 9) {
      const shift = t === 9 && (this.arpCount & 1) === 1 ? 12 : 0
      for (let k = 0; k < n; k++) this.triggerArp(this.kNote[k] + shift, this.kVel[k], gate)
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
      this.triggerArp(note, vel, gate)
    }
    this.arpCount++
  }

  private triggerArp(note: number, vel: number, gate01: number): void {
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

  private fireArpGateOffs(phaseLimit: number): void {
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

  private releaseArpAll(): void {
    for (let k = this.aCount - 1; k >= 0; k--) this.hooks.noteOff(this.aNote[k])
    this.aCount = 0
  }

  private stopArp(): void {
    this.releaseArpAll()
    this.arpActive = false
    this.arpPhase = 0
    this.arpPos = 0
    this.arpCount = 0
  }

  /** Build the note pattern for MANUAL/RISE/FALL/RISE FALL types. */
  private buildPattern(): void {
    this.patLen = 0
    this.patDirty = false
    const n = this.kCount
    if (n === 0) return
    const t = this.arpCfg.typeIndex
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
