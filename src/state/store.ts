/*
 * Central program/state store (main thread). Owns the working Program copy,
 * the 500-slot bank, sequencer/motion editing and recording state, and
 * forwards engine-relevant changes to a message sink (the worklet bridge).
 *
 * Sequence/motion mutations coalesce into at most one {t:'seq'} sink message
 * (and one onSeq listener pass) per microtask.
 */
import type { Program, SeqData, MotionLane } from '../shared/program'
import {
  NUM_STEPS,
  NUM_MOTION_LANES,
  NOTES_PER_STEP,
  MOTION_POINTS,
  initProgram,
  initSeq,
  cloneProgram,
} from '../shared/program'
import type { ToEngine } from '../shared/messages'
import {
  PARAMS,
  PARAM_COUNT,
  clampParam,
  MOTION_PITCH_BEND,
  MOTION_GATE_TIME,
} from '../shared/params'
import { GATE_TIE, STEP_RESOLUTIONS } from '../shared/maps'
import { NUM_SLOTS, loadBank, saveBankSlot, slotName } from './persist'

/** 'ui' = panel control, 'menu' = OLED menu edit (panel controls must resync). */
export type ParamSource = 'ui' | 'menu' | 'midi' | 'load' | 'motion' | 'engine'
export type RecMode = 'off' | 'step' | 'realtime'

function clampInt(v: number, lo: number, hi: number): number {
  const r = Math.round(v)
  return r < lo ? lo : r > hi ? hi : r
}

export class Store {
  private bank: Program[]
  private prog: Program
  private slotIndex = 0
  private isDirty = false
  private sink: ((msg: ToEngine) => void) | null = null

  private paramLs = new Set<(id: number, v: number, source: ParamSource) => void>()
  private programLs = new Set<(p: Program, slot: number) => void>()
  private seqLs = new Set<(seq: SeqData) => void>()
  private playheadLs = new Set<(i: number) => void>()
  private recLs = new Set<() => void>()

  private isPlaying = false
  private playheadIndex = -1

  private rec: RecMode = 'off'
  private stepCursor = -1
  /** Step rec: keys currently held down. */
  private heldNotes: number[] = []
  /** Step rec: notes (and velocities) gathered for the current step. */
  private collectedNotes: number[] = []
  private collectedVels: number[] = []

  /** Realtime motion rec: last step each lane wrote to (point-fill tracking). */
  private motionLastStep: number[] = new Array<number>(NUM_MOTION_LANES).fill(-1)

  /**
   * Realtime note rec: notes currently held, tracked as parallel arrays.
   * Step/time are the step the note currently occupies and the wall-clock
   * time it entered that step (note-on time, then each tie-chain boundary).
   */
  private rtHeldNotes: number[] = []
  private rtHeldVels: number[] = []
  private rtHeldSteps: number[] = []
  private rtHeldTimes: number[] = []

  private seqNotifyQueued = false

  constructor(factory: Program[]) {
    this.bank = loadBank(factory)
    this.prog = cloneProgram(this.bank[0])
  }

  /** Attach the engine sink; immediately syncs it with the current program. */
  connect(sink: (msg: ToEngine) => void): void {
    this.sink = sink
    sink({ t: 'loadProgram', program: this.prog })
    if (this.isPlaying) sink({ t: 'play', on: true })
  }

  private send(msg: ToEngine): void {
    if (this.sink) this.sink(msg)
  }

  // -------------------------------------------------------------- parameters

  getParam(id: number): number {
    const v = this.prog.params[id]
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  }

  setParam(id: number, v: number, source: ParamSource = 'ui'): void {
    if (!Number.isInteger(id) || id < 0 || id >= PARAM_COUNT) return
    if (!Number.isFinite(v)) return
    const cv = clampParam(id, v)
    const changed = this.prog.params[id] !== cv
    this.prog.params[id] = cv
    const userEdit = source === 'ui' || source === 'menu' || source === 'midi'
    if (changed && userEdit) this.isDirty = true
    for (const fn of this.paramLs) fn(id, cv, source)
    if (source !== 'engine') this.send({ t: 'param', id, v: cv })
    if (userEdit && this.rec === 'realtime' && this.isPlaying) {
      this.recKnob(id, cv)
    }
  }

  onParam(fn: (id: number, v: number, source: ParamSource) => void): () => void {
    this.paramLs.add(fn)
    return () => {
      this.paramLs.delete(fn)
    }
  }

  // ----------------------------------------------------------- program/bank

  get program(): Program {
    return this.prog
  }

  get slot(): number {
    return this.slotIndex
  }

  get dirty(): boolean {
    return this.isDirty
  }

  onProgram(fn: (p: Program, slot: number) => void): () => void {
    this.programLs.add(fn)
    return () => {
      this.programLs.delete(fn)
    }
  }

  /** Common post-load path: one loadProgram to the sink, listeners get 'load'. */
  private afterLoad(): void {
    this.motionLastStep.fill(-1)
    this.clearRtHeld()
    this.send({ t: 'loadProgram', program: this.prog })
    for (const fn of this.programLs) fn(this.prog, this.slotIndex)
    for (let id = 0; id < PARAM_COUNT; id++) {
      const v = this.prog.params[id]
      for (const fn of this.paramLs) fn(id, v, 'load')
    }
    for (const fn of this.seqLs) fn(this.prog.seq)
  }

  loadSlot(n: number): void {
    if (!Number.isInteger(n) || n < 0 || n >= NUM_SLOTS) return
    this.slotIndex = n
    this.prog = cloneProgram(this.bank[n])
    this.isDirty = false
    this.afterLoad()
  }

  /**
   * Commit the working program to slot n. Returns false when the write did
   * not persist (localStorage quota): the in-memory bank/name index still
   * updates (the program is live) but the program stays dirty.
   */
  writeSlot(n: number = this.slotIndex): boolean {
    if (!Number.isInteger(n) || n < 0 || n >= NUM_SLOTS) return false
    this.bank[n] = cloneProgram(this.prog)
    const ok = saveBankSlot(n, this.prog)
    this.slotIndex = n
    this.isDirty = !ok
    for (const fn of this.programLs) fn(this.prog, this.slotIndex)
    return ok
  }

  loadProgramData(p: Program): void {
    this.prog = cloneProgram(p)
    this.isDirty = true
    this.afterLoad()
  }

  slotNames(): string[] {
    const out = new Array<string>(NUM_SLOTS)
    for (let i = 0; i < NUM_SLOTS; i++) out[i] = slotName(i)
    return out
  }

  setName(name: string): void {
    this.prog.name = String(name).slice(0, 16)
    this.isDirty = true
    for (const fn of this.programLs) fn(this.prog, this.slotIndex)
  }

  initCurrent(): void {
    this.prog = initProgram()
    this.isDirty = true
    this.afterLoad()
  }

  // -------------------------------------------------------------- sequencer

  private validStep(i: number): boolean {
    return Number.isInteger(i) && i >= 0 && i < NUM_STEPS
  }

  private validLane(i: number): boolean {
    return Number.isInteger(i) && i >= 0 && i < NUM_MOTION_LANES
  }

  private touchSeq(): void {
    this.isDirty = true
    this.scheduleSeqNotify()
  }

  private scheduleSeqNotify(): void {
    if (this.seqNotifyQueued) return
    this.seqNotifyQueued = true
    queueMicrotask(() => {
      this.seqNotifyQueued = false
      for (const fn of this.seqLs) fn(this.prog.seq)
      this.send({ t: 'seq', seq: this.prog.seq })
    })
  }

  setSeqField(field: 'bpm' | 'stepLength' | 'stepResolution' | 'swing' | 'defaultGate', v: number): void {
    if (!Number.isFinite(v)) return
    const s = this.prog.seq
    switch (field) {
      case 'bpm':
        s.bpm = Math.max(10, Math.min(300, Math.round(v * 10) / 10))
        break
      case 'stepLength':
        s.stepLength = clampInt(v, 1, NUM_STEPS)
        break
      case 'stepResolution':
        s.stepResolution = clampInt(v, 0, STEP_RESOLUTIONS.length - 1)
        break
      case 'swing':
        s.swing = clampInt(v, -75, 75)
        break
      case 'defaultGate':
        s.defaultGate = clampInt(v, 0, 72)
        break
    }
    this.touchSeq()
  }

  /** Hardware behavior: on/off only mutes/unmutes existing content. */
  toggleStep(i: number): void {
    if (!this.validStep(i)) return
    const st = this.prog.seq.steps[i]
    if (st.notes.length === 0) return
    st.on = !st.on
    this.touchSeq()
  }

  setStep(i: number, notes: number[], vels: number[], gates: number[]): void {
    if (!this.validStep(i)) return
    const st = this.prog.seq.steps[i]
    const dg = this.prog.seq.defaultGate
    st.notes.length = 0
    st.vels.length = 0
    st.gates.length = 0
    for (let k = 0; k < notes.length && st.notes.length < NOTES_PER_STEP; k++) {
      const note = notes[k]
      if (!Number.isFinite(note)) continue
      st.notes.push(clampInt(note, 0, 127))
      st.vels.push(Number.isFinite(vels[k]) ? clampInt(vels[k], 1, 127) : 100)
      st.gates.push(Number.isFinite(gates[k]) ? clampInt(gates[k], 0, 127) : dg)
    }
    st.on = st.notes.length > 0
    this.touchSeq()
  }

  clearStep(i: number): void {
    if (!this.validStep(i)) return
    const st = this.prog.seq.steps[i]
    st.on = false
    st.notes.length = 0
    st.vels.length = 0
    st.gates.length = 0
    this.touchSeq()
  }

  toggleActiveStep(i: number): void {
    if (!this.validStep(i)) return
    const a = this.prog.seq.activeSteps
    a[i] = !a[i]
    this.touchSeq()
  }

  /** Clears notes, active-step mask and motion; keeps bpm/length/res/swing/gate. */
  clearSequence(): void {
    const s = this.prog.seq
    const fresh = initSeq()
    fresh.bpm = s.bpm
    fresh.stepLength = s.stepLength
    fresh.stepResolution = s.stepResolution
    fresh.swing = s.swing
    fresh.defaultGate = s.defaultGate
    this.prog.seq = fresh
    this.motionLastStep.fill(-1)
    this.touchSeq()
  }

  onSeq(fn: (seq: SeqData) => void): () => void {
    this.seqLs.add(fn)
    return () => {
      this.seqLs.delete(fn)
    }
  }

  // ----------------------------------------------------------------- motion

  setMotionLane(lane: number, cfg: Partial<Pick<MotionLane, 'paramId' | 'on' | 'smooth'>>): void {
    if (!this.validLane(lane)) return
    const l = this.prog.seq.motion[lane]
    if (cfg.paramId !== undefined && Number.isFinite(cfg.paramId)) l.paramId = cfg.paramId
    if (cfg.on !== undefined) l.on = cfg.on === true
    if (cfg.smooth !== undefined) l.smooth = cfg.smooth === true
    this.touchSeq()
  }

  /** Motion values for virtual targets pass through unclamped. */
  private clampMotionValue(paramId: number, v: number): number {
    if (paramId >= 0 && paramId < PARAM_COUNT) return clampParam(paramId, v)
    return v
  }

  writeMotionStep(lane: number, step: number, points: number[]): void {
    if (!this.validLane(lane) || !this.validStep(step)) return
    const l = this.prog.seq.motion[lane]
    const src: number[] = []
    for (const p of points) if (Number.isFinite(p)) src.push(p)
    if (src.length === 0) {
      l.data[step] = null
    } else {
      const pts = new Array<number>(MOTION_POINTS)
      for (let k = 0; k < MOTION_POINTS; k++) {
        pts[k] = this.clampMotionValue(l.paramId, src[Math.min(k, src.length - 1)])
      }
      l.data[step] = pts
    }
    this.touchSeq()
  }

  clearMotionLane(lane: number): void {
    if (!this.validLane(lane)) return
    const l = this.prog.seq.motion[lane]
    l.paramId = -1
    l.on = false
    l.smooth = false
    for (let i = 0; i < NUM_STEPS; i++) l.data[i] = null
    this.motionLastStep[lane] = -1
    this.touchSeq()
  }

  findMotionLane(paramId: number, allocate = false): number {
    const lanes = this.prog.seq.motion
    for (let i = 0; i < NUM_MOTION_LANES; i++) {
      if (lanes[i].paramId === paramId) return i
    }
    if (!allocate) return -1
    for (let i = 0; i < NUM_MOTION_LANES; i++) {
      if (lanes[i].paramId === -1) {
        const l = lanes[i]
        l.paramId = paramId
        for (let j = 0; j < NUM_STEPS; j++) l.data[j] = null
        this.motionLastStep[i] = -1
        this.touchSeq()
        return i
      }
    }
    return -1
  }

  // -------------------------------------------------------------- transport

  setPlaying(on: boolean): void {
    const next = on === true
    if (next && this.rec === 'step') this.setRecMode('off')
    this.isPlaying = next
    this.send({ t: 'play', on: next })
    if (!next) {
      if (this.rec === 'realtime') this.setRecMode('off')
      this.setPlayhead(-1)
    }
  }

  get playing(): boolean {
    return this.isPlaying
  }

  /** Called by the app from engine 'step' messages. */
  setPlayhead(i: number): void {
    const v = Number.isFinite(i) ? Math.trunc(i) : -1
    this.playheadIndex = v >= 0 && v < NUM_STEPS ? v : -1
    // Every step message is a step boundary: the next motion-rec write in any
    // lane refills all points (matters when the loop wraps back to the same
    // step index — a new pass must overwrite, not continue the shift-in).
    this.motionLastStep.fill(-1)
    if (this.rec === 'realtime' && this.isPlaying && this.playheadIndex >= 0) {
      this.chainRtHeld(this.playheadIndex)
    }
    for (const fn of this.playheadLs) fn(this.playheadIndex)
  }

  get playhead(): number {
    return this.playheadIndex
  }

  onPlayhead(fn: (i: number) => void): () => void {
    this.playheadLs.add(fn)
    return () => {
      this.playheadLs.delete(fn)
    }
  }

  // -------------------------------------------------------------- recording

  setRecMode(m: RecMode): void {
    if (m !== 'off' && m !== 'step' && m !== 'realtime') return
    if (this.rec === m) return
    // Leaving realtime rec (rec stop / playback stop): finalize held notes
    // with whatever gate time has elapsed so far.
    if (this.rec === 'realtime') this.finalizeRtHeld()
    this.rec = m
    this.heldNotes.length = 0
    this.collectedNotes.length = 0
    this.collectedVels.length = 0
    this.clearRtHeld()
    this.stepCursor = m === 'step' ? 0 : -1
    this.motionLastStep.fill(-1)
    for (const fn of this.recLs) fn()
  }

  get recMode(): RecMode {
    return this.rec
  }

  get stepRecCursor(): number {
    return this.stepCursor
  }

  onRecChange(fn: () => void): () => void {
    this.recLs.add(fn)
    return () => {
      this.recLs.delete(fn)
    }
  }

  private notifyRec(): void {
    for (const fn of this.recLs) fn()
  }

  /** Write the collected chord to the cursor step and advance (step rec). */
  private commitStepRec(tie: boolean): void {
    const st = this.prog.seq.steps[this.stepCursor]
    const dg = this.prog.seq.defaultGate
    st.notes = this.collectedNotes.slice()
    st.vels = this.collectedVels.slice()
    st.gates = st.notes.map((n) => (tie && this.heldNotes.indexOf(n) >= 0 ? GATE_TIE : dg))
    st.on = st.notes.length > 0
    this.collectedNotes.length = 0
    this.collectedVels.length = 0
    this.touchSeq()
    this.advanceStepRec()
  }

  private advanceStepRec(): void {
    this.stepCursor++
    if (this.stepCursor >= this.prog.seq.stepLength) {
      this.setRecMode('off') // resets cursor, notifies rec listeners
    } else {
      this.notifyRec()
    }
  }

  recNoteOn(note: number, vel: number): void {
    if (!Number.isFinite(note)) return
    const n = clampInt(note, 0, 127)
    const v = Number.isFinite(vel) ? clampInt(vel, 1, 127) : 100
    if (this.rec === 'step' && this.stepCursor >= 0) {
      if (this.heldNotes.indexOf(n) < 0) this.heldNotes.push(n)
      const ci = this.collectedNotes.indexOf(n)
      if (ci >= 0) {
        this.collectedVels[ci] = v
      } else if (this.collectedNotes.length < NOTES_PER_STEP) {
        this.collectedNotes.push(n)
        this.collectedVels.push(v)
      }
      this.notifyRec()
    } else if (this.rec === 'realtime' && this.isPlaying) {
      const i = this.playheadIndex
      if (i < 0 || i >= NUM_STEPS) return
      const st = this.prog.seq.steps[i]
      const idx = st.notes.indexOf(n)
      if (idx >= 0) {
        st.vels[idx] = v // overdub same note: refresh velocity
      } else if (st.notes.length < NOTES_PER_STEP) {
        st.notes.push(n)
        st.vels.push(v)
        st.gates.push(this.prog.seq.defaultGate)
      } else {
        return // step full
      }
      st.on = true
      // Track the hold so note-off (or a step boundary) sets the real gate.
      const hi = this.rtHeldNotes.indexOf(n)
      const t = Date.now()
      if (hi >= 0) {
        this.rtHeldVels[hi] = v
        this.rtHeldSteps[hi] = i
        this.rtHeldTimes[hi] = t
      } else {
        this.rtHeldNotes.push(n)
        this.rtHeldVels.push(v)
        this.rtHeldSteps.push(i)
        this.rtHeldTimes.push(t)
      }
      this.touchSeq()
    }
  }

  recNoteOff(note: number): void {
    if (!Number.isFinite(note)) return
    const n = clampInt(note, 0, 127)
    if (this.rec === 'step' && this.stepCursor >= 0) {
      const hi = this.heldNotes.indexOf(n)
      if (hi >= 0) this.heldNotes.splice(hi, 1)
      if (this.heldNotes.length === 0 && this.collectedNotes.length > 0) {
        this.commitStepRec(false)
      }
    } else if (this.rec === 'realtime') {
      const k = this.rtHeldNotes.indexOf(n)
      if (k >= 0) this.finalizeRtNote(k, Date.now())
    }
  }

  /** Step duration estimate from the current bpm/resolution (spec §11). */
  private stepDurationMs(): number {
    const s = this.prog.seq
    const beats = STEP_RESOLUTIONS[s.stepResolution]?.beatsPerStep ?? 0.25
    return (beats * 60000) / s.bpm
  }

  /**
   * Realtime rec, step boundary: every note still held gets gate TIE in the
   * step it occupied and is re-added to the new step (hardware tie-chaining,
   * capped at NOTES_PER_STEP). Note-off then writes the remaining fraction.
   */
  private chainRtHeld(step: number): void {
    const t = Date.now()
    for (let k = this.rtHeldNotes.length - 1; k >= 0; k--) {
      if (this.rtHeldSteps[k] === step) continue
      const n = this.rtHeldNotes[k]
      const prev = this.prog.seq.steps[this.rtHeldSteps[k]]
      const pi = prev.notes.indexOf(n)
      if (pi >= 0) prev.gates[pi] = GATE_TIE
      const st = this.prog.seq.steps[step]
      let idx = st.notes.indexOf(n)
      if (idx < 0) {
        if (st.notes.length >= NOTES_PER_STEP) {
          // new step full: the chain ends at the boundary (TIE holds it there)
          this.dropRtNote(k)
          this.touchSeq()
          continue
        }
        idx = st.notes.length
        st.notes.push(n)
        st.vels.push(this.rtHeldVels[k])
        st.gates.push(this.prog.seq.defaultGate)
        st.on = true
      }
      this.rtHeldSteps[k] = step
      this.rtHeldTimes[k] = t
      this.touchSeq()
    }
  }

  /** Write the elapsed-fraction gate for held note k and stop tracking it. */
  private finalizeRtNote(k: number, t: number): void {
    const st = this.prog.seq.steps[this.rtHeldSteps[k]]
    const idx = st.notes.indexOf(this.rtHeldNotes[k])
    if (idx >= 0) {
      const dur = this.stepDurationMs()
      const g = dur > 0 ? Math.round((72 * (t - this.rtHeldTimes[k])) / dur) : 72
      st.gates[idx] = g < 1 ? 1 : g > 72 ? 72 : g
      this.touchSeq()
    }
    this.dropRtNote(k)
  }

  /** Notes still held when rec/playback stops: finalize with what elapsed. */
  private finalizeRtHeld(): void {
    const t = Date.now()
    while (this.rtHeldNotes.length > 0) this.finalizeRtNote(this.rtHeldNotes.length - 1, t)
  }

  private dropRtNote(k: number): void {
    this.rtHeldNotes.splice(k, 1)
    this.rtHeldVels.splice(k, 1)
    this.rtHeldSteps.splice(k, 1)
    this.rtHeldTimes.splice(k, 1)
  }

  private clearRtHeld(): void {
    this.rtHeldNotes.length = 0
    this.rtHeldVels.length = 0
    this.rtHeldSteps.length = 0
    this.rtHeldTimes.length = 0
  }

  recRest(): void {
    if (this.rec === 'step' && this.stepCursor >= 0) {
      if (this.heldNotes.length > 0) {
        // Tie: write held notes with gate TIE, keep recording them next step.
        const keepN: number[] = []
        const keepV: number[] = []
        for (const n of this.heldNotes) {
          const ci = this.collectedNotes.indexOf(n)
          keepN.push(n)
          keepV.push(ci >= 0 ? this.collectedVels[ci] : 100)
        }
        this.commitStepRec(true)
        if (this.rec === 'step') {
          for (let k = 0; k < keepN.length && this.collectedNotes.length < NOTES_PER_STEP; k++) {
            this.collectedNotes.push(keepN[k])
            this.collectedVels.push(keepV[k])
          }
        }
      } else {
        // Rest: clear the step and advance.
        const st = this.prog.seq.steps[this.stepCursor]
        st.on = false
        st.notes.length = 0
        st.vels.length = 0
        st.gates.length = 0
        this.touchSeq()
        this.advanceStepRec()
      }
    } else if (this.rec === 'realtime' && this.isPlaying) {
      const i = this.playheadIndex
      if (i < 0 || i >= NUM_STEPS) return
      const st = this.prog.seq.steps[i]
      if (st.on || st.notes.length > 0) {
        st.on = false
        st.notes.length = 0
        st.vels.length = 0
        st.gates.length = 0
        this.touchSeq()
      }
    }
  }

  /**
   * Motion capture during realtime rec: first write in a step fills all 5
   * points with v; further writes in the same step shift the new value in so
   * the points trace the knob movement. Returns false if nothing was
   * recorded (not recording, param not motion-recordable, or lanes full).
   */
  recKnob(paramId: number, v: number): boolean {
    if (this.rec !== 'realtime' || !this.isPlaying) return false
    if (!Number.isFinite(v)) return false
    const step = this.playheadIndex
    if (step < 0 || step >= NUM_STEPS) return false

    let smooth: boolean
    if (paramId === MOTION_PITCH_BEND || paramId === MOTION_GATE_TIME) {
      smooth = true
    } else {
      const meta = PARAMS[paramId]
      if (!meta || meta.motion !== true) return false
      smooth = meta.motionSmooth === true
    }

    const lane = this.findMotionLane(paramId, true)
    if (lane < 0) return false
    const l = this.prog.seq.motion[lane]
    const val = this.clampMotionValue(paramId, v)

    let pts = l.data[step]
    if (!pts || this.motionLastStep[lane] !== step) {
      if (!pts) {
        pts = new Array<number>(MOTION_POINTS)
        l.data[step] = pts
      }
      for (let k = 0; k < MOTION_POINTS; k++) pts[k] = val
      this.motionLastStep[lane] = step
    } else {
      for (let k = 0; k < MOTION_POINTS - 1; k++) pts[k] = pts[k + 1]
      pts[MOTION_POINTS - 1] = val
    }
    l.on = true
    l.smooth = smooth
    this.touchSeq()
    return true
  }

  /** Press a step button during step rec: move the cursor there. */
  jumpStepRec(i: number): void {
    if (this.rec !== 'step') return
    if (!this.validStep(i)) return
    this.stepCursor = Math.min(i, this.prog.seq.stepLength - 1)
    this.heldNotes.length = 0
    this.collectedNotes.length = 0
    this.collectedVels.length = 0
    this.notifyRec()
  }
}
