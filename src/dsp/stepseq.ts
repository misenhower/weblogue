/*
 * Worklet-side step sequencer + motion-sequence playback engine.
 *
 * Plain TS class — no worklet globals; the audio processor calls process()
 * once per render block (<= 128 frames) and receives note/motion/step events
 * through StepSeqHooks callbacks, block-quantized (tighter than the hardware
 * needs). See docs/xd-spec.md §11 (sequencer/motion). The arpeggiator is a
 * separate class (dsp/arp.ts) — the 'logue family splits there (monologue:
 * seq, no arp; prologue: arp, no seq).
 *
 * Motion-target validity is injected as MotionTargetMeta so this core has no
 * dependency on any synth's parameter table.
 *
 * No allocation happens in process(); all per-block state lives in fixed
 * arrays. setSeq() is a control-path call and may allocate.
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
import { MOTION_PITCH_BEND, MOTION_GATE_TIME, type MotionTargetMeta } from '../shared/paramdef'
import { clamp, fin, clampInt } from '../shared/maps'

export interface StepSeqHooks {
  /** `slide` (monologue spec §8): the previous played step had its SLIDE
   *  flag set, so this note starts with a glide INTO it. Engines without
   *  slide simply omit the parameter. */
  noteOn(note: number, vel: number, slide?: boolean): void
  noteOff(note: number): void
  motionValue(paramId: number, value: number): void // raw param units; MOTION_PITCH_BEND value is -1..1 (MOTION_GATE_TIME never emits: consumed internally as a gate override)
  stepChanged(i: number): void // playhead for UI (-1 when stopped)
}

const SND_CAP = 16 // sounding seq notes (hardware max 8/step; headroom for safety)

export class StepSeq {
  private readonly sr: number
  private readonly hooks: StepSeqHooks
  private readonly motion: MotionTargetMeta

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

  // SLIDE (monologue spec §8): a flagged step glides INTO the next step, so
  // this holds the flag of the step just left (skips/wrap respected) and is
  // passed to the entered step's noteOns. Sequence start = no slide.
  private slideIn = false

  // Motion lane playback state (points reference our owned deep copy).
  private readonly mPts: (number[] | null)[]
  private readonly mSmooth = new Uint8Array(NUM_MOTION_LANES)
  private readonly mLast = new Float64Array(NUM_MOTION_LANES) // NaN = nothing sent

  constructor(sampleRate: number, hooks: StepSeqHooks, motion: MotionTargetMeta) {
    this.sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
    this.hooks = hooks
    this.motion = motion
    this.seq = this.sanitizeSeq(initSeq())
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

  /** Deep-copy + sanitize a SeqData into a fully-shaped, finite structure. */
  private sanitizeSeq(src: SeqData): SeqData {
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
      steps.push({ on: !!st && st.on === true && notes.length > 0, notes, vels, gates, slide: !!st && st.slide === true })
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

  /**
   * Deep-copies; safe while playing. Note/motion content, bpm, swing and
   * default gate apply immediately; stepLength / stepResolution / activeSteps
   * latch at the next step boundary (clock phase stays continuous).
   */
  setSeq(seq: SeqData): void {
    const copy = this.sanitizeSeq(seq)
    this.seq = copy
    if (this._playing && this.stepIdx >= 0) {
      // Re-point in-flight smooth motion lanes at the new content.
      for (let l = 0; l < NUM_MOTION_LANES; l++) {
        if (!this.mSmooth[l]) continue
        const lane = copy.motion[l]
        const d = lane && lane.on ? lane.data[this.stepIdx] : null
        if (lane && d && lane.smooth && this.motion.isTarget(lane.paramId) && this.motion.isSmooth(lane.paramId)) {
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

  /** Live GATE TIME joystick offset in raw gate units (-72..72); applied to
   *  non-TIE gates as steps trigger (spec §12 Y assign "GATE TIME"). */
  setGateTimeOffset(off: number): void {
    this.gateOffset = clamp(fin(off, 0), -72, 72)
  }

  process(nFrames: number): void {
    if (!Number.isFinite(nFrames) || nFrames <= 0) return
    this.processSeq(nFrames, this.seq.bpm) // sanitized 10..300; applies immediately
  }

  /** Full silent reset (no hooks fired): stops playback, clears state. */
  reset(): void {
    this._playing = false
    this.stepIdx = -1
    this.phase = 0
    this.playedCount = 0
    this.sCount = 0
    this.resetMotionState()
    this.latchTiming()
  }

  // -------------------------------------------------------------------------
  // internals
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
        this.slideIn = false // no previous step to glide from
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
    this.slideIn = this.seq.steps[this.stepIdx]?.slide === true // step just left
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
        // TIE continuations above never retrigger, so slide never applies to them.
        this.hooks.noteOn(st.notes[j], st.vels[j], this.slideIn)
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
    if (!this.motion.isTarget(pid)) return
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
    if (lane.smooth && this.motion.isSmooth(pid)) {
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
}
