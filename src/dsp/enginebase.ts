/*
 * EngineBase — the 'logue-family synth-engine skeleton (worklet-side,
 * DOM-free), extracted from the xd + og engines once both existed so a third
 * definition doesn't paste the shared core a third time.
 *
 * The base owns what every family engine shares:
 *   - the raw parameter store and the layered parameter model
 *       effective raw = (motion override ?? knob raw) + offset layers
 *     mapping raw -> physical ONCE per change (push model) through the
 *     subclass's applyParam switch;
 *   - offset layers (the xd joystick-Y/aftertouch, the og slider):
 *     non-destructive deflections resolved at block rate into a param or
 *     sequencer GATE TIME offset, registered per-synth with a resolver;
 *   - pitch bend + the MotionOverlay wiring (param ids via config);
 *   - VoiceBank/NoteStack note machinery with the shared noteOn/noteOff
 *     skeleton — voice-mode SEMANTICS stay per-synth (modeNoteOn/modeNoteOff/
 *     monoStart/startVoice) over the shared poly/duo/chord start helpers;
 *   - StepSeq + optional Arp transport (a synth without an arpeggiator —
 *     the monologue — simply omits the arp config) and the process()
 *     skeleton: layer flushes, pended voice restarts, the preProcess hook,
 *     LFO voice-sync phase share, the voice sum, the per-synth FX stage
 *     (processFx) and the final soft limiter;
 *   - SERVICE MODE tap plumbing (dsp/servicetaps.ts) + telemetry accessors.
 *
 * dsp/ never imports from synths/: everything synth-specific is injected via
 * EngineBaseConfig or implemented by the subclass.
 */
import { clamp } from '../shared/maps'
import type { ParamMeta, MotionTargetMeta } from '../shared/paramdef'
import type { Program, SeqData } from '../shared/program'
import { VoiceBank, NoteStack, type BankVoice } from './voicebank'
import { StepSeq } from './stepseq'
import { Arp } from './arp'
import { ServiceTaps, type TapVoice } from './servicetaps'
import { MotionOverlay } from './motionoverlay'

/**
 * Samples per SERVICE-MODE tap frame: the panel shows a 512-sample window
 * center-triggered within the frame, so the trigger search span is
 * DBG_TAP_SIZE - 512 ≈ 16 ms at 48 kHz — a guaranteed lock down to ~C2.
 */
export const DBG_TAP_SIZE = 1280

/** Unison detune spread per voice index, x detune cents. */
export const UNI_OFF = [-1, -1 / 3, 1 / 3, 1]

/** Per-voice headroom into the mono sum (4 voices stay mostly linear). */
const VOICE_MIX = 0.35

/** PORTAMENTO BPM quantization grid, in beats. */
const PORTA_BEATS = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1]

/** Transparent soft limiter: identity below |0.7|, tanh knee, bounded at 1. */
function softLimit(x: number): number {
  if (x > 0.7) return 0.7 + 0.3 * Math.tanh((x - 0.7) / 0.3)
  if (x < -0.7) return -0.7 - 0.3 * Math.tanh((-x - 0.7) / 0.3)
  return x
}

/** What the base needs from a synth voice (superset of the bank/tap views). */
export interface EngineVoice extends BankVoice, TapVoice {
  /** SERVICE MODE tap recording enabled (mirrors ServiceTaps.on). */
  tapOn: boolean
  tick(): number
  tickIdle(): void
  noteOn(note: number, freqHz: number, vel: number, retrigger: boolean, glide: boolean): void
  setBendMult(m: number): void
  setGlideTime(sec: number): void
  /** Seed the glide start point (poly portamento glides from the last note). */
  setGlideStart(freqHz: number): void
  setDetuneCents(c: number): void
  setVoiceGain(g: number): void
  /** Free-running LFO phase (block-rate Voice Sync sharing). */
  readonly lfoPhase: number
  setLfoPhase(p: number): void
  // Telemetry for the debug panel's voice lanes (debugVoiceInfo).
  readonly note: number
  readonly lastAmp: number
  readonly lastDrift1: number
  readonly lastDrift2: number
  readonly lastModEg: number
  readonly lastLfo: number
  readonly lastHz: number
}

/** An offset-layer resolution (reused scratch — resolvers must not keep it). */
export interface OffsetResolution {
  /** Destination param id, -1 = none. */
  dest: number
  /** Offset in the destination's raw units. */
  offset: number
  /** GATE TIME offset in raw gate units 0..72 (routed to the sequencer). */
  gateOffset: number
}

/**
 * A non-destructive parameter offset layer (the xd joystick-Y / aftertouch,
 * the og slider): a deflection value resolved at block rate into a param
 * offset or a sequencer GATE TIME offset. The synth registers its layers
 * with addOffsetLayer and owns the resolver (assign/range params, dest
 * tables); the base owns the dirty-flush, commit and re-push mechanics.
 */
export class OffsetLayer {
  /** Deflection (set by the synth's setter; the range is the synth's business). */
  value = 0
  dirty = false
  /** Committed destination + offset (consumed by effectiveParam). */
  dest = -1
  offset = 0
  /** Committed GATE TIME offset (summed across layers into the sequencer). */
  gateOff = 0
  /** Resolve a significant deflection into `out` (no allocation). */
  readonly resolve: (v: number, out: OffsetResolution) => void

  constructor(resolve: (v: number, out: OffsetResolution) => void) {
    this.resolve = resolve
  }
}

/** Param ids the base needs (each synth's table has its own numbering). */
export interface EngineBaseIds {
  voiceMode: number
  bendRangePlus: number
  bendRangeMinus: number
  portamento: number
  portamentoBpm: number
  portamentoMode: number
}

export interface EngineBaseConfig<V extends EngineVoice> {
  /** Param metadata table (dense, id-indexed; params.ts). */
  params: readonly ParamMeta[]
  /** Motion-lane target metadata for the step sequencer (MOTION_META). */
  motionMeta: MotionTargetMeta
  numVoices: number
  createVoice(sr: number, index: number): V
  ids: EngineBaseIds
  /** PORTAMENTO raw -> seconds (per-synth curve). */
  portamentoToSec(raw: number): number
  /** Arpeggiator wiring, if the synth has one (the monologue has none):
   *  `voiceMode` is the VOICE MODE value that routes live keys to the arp. */
  arp?: { voiceMode: number }
}

export abstract class EngineBase<V extends EngineVoice> {
  protected readonly sr: number
  protected readonly nv: number
  private readonly paramTable: readonly ParamMeta[]
  private readonly ids: EngineBaseIds
  private readonly portamentoToSec: (raw: number) => number

  /** Raw knob/menu values, indexed by param id. */
  protected readonly params: Float64Array

  // Motion-sequence override layer (dsp/motionoverlay.ts).
  protected readonly motion: MotionOverlay

  // Pitch bend (xd joystick X / og slider in PITCH BEND mode / MIDI bend).
  private bendX = 0

  // Offset layers (registered by the subclass via addOffsetLayer).
  private readonly layers: OffsetLayer[] = []
  private readonly res: OffsetResolution = { dest: -1, offset: 0, gateOffset: 0 }

  // Voices + allocation mechanics (dsp/voicebank.ts) + gated-key model.
  protected readonly voices: V[] = []
  protected readonly bank: VoiceBank<V>
  protected readonly stack = new NoteStack()
  protected curMonoNote = -1
  protected sustainOn = false
  /** Pended-restart callback (hoisted: no closure allocation in process()). */
  private readonly pendCb = (
    i: number, key: number, note: number, vel: number,
    glide: boolean, det: number, gain: number, stacked: boolean,
  ): void => this.startVoice(i, key, note, vel, true, glide, det, gain, stacked)
  protected curMode: number
  protected glideSec = 0
  protected lastStartHz = 0

  // Sequencer / arpeggiator.
  readonly stepSeq: StepSeq
  readonly arp: Arp | null
  private readonly arpVoiceMode: number
  /** Playhead callback for the processor ({t:'step'} messages). */
  onStep: ((i: number) => void) | null = null

  protected bpm = 120
  protected swing = 0

  // Output stage.
  protected gainT = 1
  private gainSm = 1
  private readonly gainCoef: number

  // --- CHORD-mode voice set (rotated via the bank's rotor) ----------------
  private readonly chordMap: Int8Array
  private chordTones = 0

  // --- SERVICE MODE (debug panel) taps (dsp/servicetaps.ts) ---------------
  protected dbgVoice = 0 // most recently triggered voice index
  protected readonly taps: ServiceTaps

  constructor(sampleRate: number, cfg: EngineBaseConfig<V>) {
    const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
    this.sr = sr
    this.gainCoef = 1 - Math.exp(-1 / (0.005 * sr))
    this.nv = cfg.numVoices
    this.paramTable = cfg.params
    this.ids = cfg.ids
    this.portamentoToSec = cfg.portamentoToSec
    this.params = new Float64Array(cfg.params.length)
    this.motion = new MotionOverlay(cfg.params, {
      applyParam: (id) => this.applyParam(id),
      refreshBend: () => this.refreshBend(),
    })
    for (let i = 0; i < this.nv; i++) this.voices.push(cfg.createVoice(sr, i))
    this.bank = new VoiceBank(this.voices)
    this.chordMap = new Int8Array(this.nv).fill(-1)
    this.taps = new ServiceTaps(this.nv, DBG_TAP_SIZE)
    this.stepSeq = new StepSeq(
      sr,
      {
        noteOn: (note, vel, slide) => this.hookNoteOn(note, vel, slide),
        noteOff: (note) => this.hookNoteOff(note),
        motionValue: (id, v) => this.applyMotion(id, v),
        stepChanged: (i) => {
          if (this.onStep) this.onStep(i)
        },
      },
      cfg.motionMeta,
    )
    this.arp = cfg.arp
      ? new Arp(sr, {
          noteOn: (note, vel) => this.hookNoteOn(note, vel),
          noteOff: (note) => this.hookNoteOff(note),
        })
      : null
    this.arpVoiceMode = cfg.arp ? cfg.arp.voiceMode : -1
    for (const m of cfg.params) this.params[m.id] = m.def
    this.curMode = Math.round(this.params[cfg.ids.voiceMode])
  }

  /** Subclass constructor tail: once per-synth state (FX, offset layers)
   *  exists, push every default and configure the arp. */
  protected finishInit(): void {
    this.applyAllParams()
    this.syncArp()
  }

  /* --------------------------------------------------------- parameters -- */

  /** Store a raw knob/menu value and push its mapped physical value(s). */
  setParam(id: number, v: number): void {
    if (!Number.isFinite(v)) return
    const m = this.paramTable[id]
    if (!m) return
    this.params[id] = clamp(v, m.min, m.max)
    this.applyParam(id)
  }

  /** Raw knob value (no overrides). */
  getParam(id: number): number {
    return id >= 0 && id < this.params.length ? this.params[id] : 0
  }

  /** Effective raw value including motion override + offset layers. */
  effectiveParam(id: number): number {
    const m = this.paramTable[id]
    if (!m) return 0
    let v = this.motion.effective(id, this.params[id])
    for (let k = 0; k < this.layers.length; k++) {
      if (this.layers[k].dest === id) v += this.layers[k].offset
    }
    return clamp(v, m.min, m.max)
  }

  /** Motion-lane value into the non-destructive override layer. */
  applyMotion(paramId: number, v: number): void {
    this.motion.applyMotion(paramId, v)
  }

  /** Raw -> physical push for one param: the synth's big binding switch. */
  protected abstract applyParam(id: number): void

  protected applyAllParams(): void {
    for (let id = 0; id < this.params.length; id++) this.applyParam(id)
  }

  /* ------------------------------------------------- bend / offset layers -- */

  /** Pitch bend, -1..1, scaled by BEND RANGE +/- (semitones). */
  setBend(v: number): void {
    if (!Number.isFinite(v)) return
    this.bendX = clamp(v, -1, 1)
    this.refreshBend()
  }

  protected refreshBend(): void {
    const v = this.motion.bendOn ? this.motion.bend : this.bendX
    const range = v >= 0 ? this.params[this.ids.bendRangePlus] : this.params[this.ids.bendRangeMinus]
    const mult = Math.pow(2, (v * range) / 12) // range 0 = Off
    for (let i = 0; i < this.nv; i++) this.voices[i].setBendMult(mult)
  }

  /** Register an offset layer (subclass constructor, before finishInit). */
  protected addOffsetLayer(resolve: (v: number, out: OffsetResolution) => void): OffsetLayer {
    const layer = new OffsetLayer(resolve)
    this.layers.push(layer)
    return layer
  }

  /** Re-resolve a dirty layer: commit its GATE TIME share (the sequencer
   *  gets the sum over all layers) and re-push the previous + new dest. */
  private applyOffsetLayer(layer: OffsetLayer): void {
    layer.dirty = false
    const v = layer.value
    const res = this.res
    res.dest = -1
    res.offset = 0
    res.gateOffset = 0
    if (v > 1e-3 || v < -1e-3) layer.resolve(v, res)
    layer.gateOff = res.gateOffset
    let gate = 0
    for (let k = 0; k < this.layers.length; k++) gate += this.layers[k].gateOff
    this.stepSeq.setGateTimeOffset(gate)
    if (res.dest === layer.dest && res.offset === layer.offset) return
    const prev = layer.dest
    layer.dest = res.dest
    layer.offset = res.offset
    if (prev >= 0 && prev !== layer.dest) this.applyParam(prev)
    if (layer.dest >= 0) this.applyParam(layer.dest)
  }

  /* ------------------------------------------------------ shared refresh -- */

  /** VOICE MODE switch: flush voices/stack so modes never leak notes.
   *  Returns whether the mode actually changed (per-synth extra flushes). */
  protected changeVoiceMode(m: number): boolean {
    if (m === this.curMode) return false
    this.curMode = m
    this.bank.releaseAll(this.sustainOn)
    this.stack.clear()
    this.curMonoNote = -1
    this.stack.clearMonoSustained()
    return true
  }

  protected refreshGlide(): void {
    let sec = this.portamentoToSec(this.effectiveParam(this.ids.portamento))
    if (sec > 0 && this.params[this.ids.portamentoBpm] >= 0.5) {
      // Quantize to the nearest of [1/16,1/8,1/4,1/2,1] beats at the seq bpm.
      const beat = 60 / this.bpm
      let best = PORTA_BEATS[0] * beat
      let bd = Infinity
      for (let k = 0; k < PORTA_BEATS.length; k++) {
        const t = PORTA_BEATS[k] * beat
        const d = Math.abs(t - sec)
        if (d < bd) {
          bd = d
          best = t
        }
      }
      sec = best
    }
    this.glideSec = sec
    for (let i = 0; i < this.nv; i++) this.voices[i].setGlideTime(sec)
  }

  protected glideFor(legato: boolean): boolean {
    if (this.glideSec <= 0) return false
    // Portamento Mode: Auto = only when played legato, On = always.
    return this.params[this.ids.portamentoMode] >= 0.5 || legato
  }

  /** Push the current arp config (rate/type/latch); no-op without an arp. */
  protected syncArp(): void {}

  /* ---------------------------------------------------------- notes ------ */

  private isArpMode(): boolean {
    return this.arp !== null && this.curMode === this.arpVoiceMode
  }

  noteOn(note: number, vel: number): void {
    if (!Number.isFinite(note) || !Number.isFinite(vel)) return
    const n = Math.max(0, Math.min(127, Math.round(note)))
    const v = Math.max(1, Math.min(127, Math.round(vel)))
    this.stack.setHeld(n, true)
    if (this.arp && this.curMode === this.arpVoiceMode) {
      this.arp.keyDown(n, v)
      return
    }
    this.noteOnInternal(n, v, false)
  }

  noteOff(note: number): void {
    if (!Number.isFinite(note)) return
    const n = Math.max(0, Math.min(127, Math.round(note)))
    this.stack.setHeld(n, false)
    if (this.arp) {
      // Always release the arp key buffer: a key registered in ARP mode may
      // be let go after a voice-mode switch and would otherwise linger
      // forever.
      this.arp.keyUp(n)
      if (this.curMode === this.arpVoiceMode) return
    }
    this.noteOffInternal(n, false)
  }

  allNotesOff(): void {
    this.bank.hardReleaseAll()
    this.stack.clear()
    this.curMonoNote = -1
    this.stack.clearMonoSustained()
    const arp = this.arp
    this.stack.clearHeld(arp ? (n) => arp.keyUp(n) : undefined)
    this.onAllNotesOff()
    if (arp) {
      // Drop latched arp keys: momentary latch-off flush, then restore config.
      arp.setConfig({
        enabled: false,
        typeIndex: 0,
        latch: false,
        rateBeats: 0.25,
        gate01: 0.75,
        swing: this.swing,
      })
      this.syncArp()
    }
  }

  /** allNotesOff extras for per-synth queues (og: echo queue + ducks). */
  protected onAllNotesOff(): void {}

  sustain(on: boolean): void {
    this.sustainOn = on === true
    if (!this.sustainOn) {
      // Mono modes: flush key releases deferred while the damper was down
      // (current note last so the legato fall-back never retriggers it).
      this.stack.flushMonoSustained(this.curMonoNote, (n) => this.noteOffInternal(n, false))
      this.bank.flushSustained((key) => this.stack.contains(key))
    }
  }

  /** Sequencer / arpeggiator hook notes re-enter the allocator here. `slide`
   *  is the sequencer's SLIDE flag (monologue spec §8); ignored by default. */
  protected hookNoteOn(note: number, vel: number, _slide?: boolean): void {
    const n = Math.max(0, Math.min(127, Math.round(note)))
    const v = Math.max(1, Math.min(127, Math.round(vel)))
    this.noteOnInternal(n, v, this.isArpMode())
  }

  protected hookNoteOff(note: number): void {
    const n = Math.max(0, Math.min(127, Math.round(note)))
    this.noteOffInternal(n, this.isArpMode())
  }

  protected noteOnInternal(note: number, vel: number, forcePoly: boolean): void {
    if (this.stack.isMonoSustained(note)) {
      // Re-press of a pedal-sustained key: drop the stale stack entry first.
      this.stack.setMonoSustained(note, false)
      this.stack.remove(note)
    }
    const legato = this.stack.count > 0
    this.stack.push(note, vel)
    this.modeNoteOn(note, vel, legato, forcePoly)
  }

  protected noteOffInternal(note: number, forcePoly: boolean): void {
    this.modeNoteOff(note, forcePoly)
  }

  /** Voice-mode dispatch for a key press (after the stack bookkeeping). */
  protected abstract modeNoteOn(note: number, vel: number, legato: boolean, forcePoly: boolean): void

  /** Voice-mode dispatch for a key release (stack removal is mode business:
   *  mono modes defer it to monoNoteOff, poly modes remove + releaseKey). */
  protected abstract modeNoteOff(note: number, forcePoly: boolean): void

  /** Mono-family (UNISON/CHORD/...) start; last-note priority. */
  protected abstract monoStart(note: number, vel: number, legato: boolean): void

  /** Mono-family key release: CC64 deferral, empty-stack release-all, and
   *  the last-note-priority legato fall-back. */
  protected monoNoteOff(note: number): void {
    if (this.sustainOn) {
      // Damper down: defer the release entirely (CC64 semantics) — the key
      // stays on the stack so the pitch does not fall back mid-pedal.
      this.stack.setMonoSustained(note, true)
      return
    }
    this.stack.remove(note)
    if (this.stack.count === 0) {
      this.bank.releaseAll(this.sustainOn)
      this.curMonoNote = -1
    } else if (note === this.curMonoNote) {
      // Return to the previous held note (legato).
      this.monoStart(this.stack.topNote(), this.stack.topVel(), true)
    }
  }

  /* ------------------------------------------------- shared mode starts -- */

  /** Poly allocation; returns the started voice index (-1 = stolen/pended). */
  protected polyStart(key: number, soundNote: number, vel: number, legato: boolean): number {
    const glide = this.glideFor(legato)
    const i = this.bank.alloc()
    if (i >= 0) {
      this.startVoice(i, key, soundNote, vel, true, glide, 0, 1, false)
      return i
    }
    // Steal the oldest: kill now, restart at the next block.
    this.bank.steal(this.bank.oldest(), key, soundNote, vel, glide, 0, 1, false)
    return -1
  }

  /** DUO-style start into a pair (0,1)/(2,3): main + detuned stacked voice;
   *  the bank rotates pairs like the hardware rotates voices. */
  protected duoStart(note: number, vel: number, legato: boolean, det: number, stackGain: number): void {
    const glide = this.glideFor(legato)
    const { pair, kind } = this.bank.allocPair()
    const a = pair * 2
    if (kind === 'steal') {
      this.bank.steal(a, note, note, vel, glide, 0, 1, false)
      this.bank.steal(a + 1, note, note, vel, glide, det, stackGain, true)
      return
    }
    this.startVoice(a, note, note, vel, true, glide, 0, 1, false)
    this.startVoice(a + 1, note, note, vel, true, glide, det, stackGain, true)
  }

  /**
   * CHORD-mode strike over the chord's interval list. Rotates the chord's
   * voice set on each fresh strike (family behavior: voices cycle even in
   * mono-style modes, letting tails ring); a legato transition re-pitches
   * the SAME voices so glide/EGs stay continuous.
   */
  protected chordStart(intervals: readonly number[], note: number, vel: number, retrig: boolean, glide: boolean): void {
    const nv = this.nv
    const tones = Math.min(intervals.length, nv)
    const reuse = !retrig && this.chordTones === tones && this.chordMap[0] >= 0
    if (!reuse) {
      const base = this.bank.takeRotor(tones)
      for (let t = 0; t < tones; t++) this.chordMap[t] = (base + t) % nv
      for (let t = tones; t < nv; t++) this.chordMap[t] = -1
      this.chordTones = tones
    }
    for (let t = 0; t < tones; t++) {
      this.startVoice(this.chordMap[t], note, note + intervals[t], vel, retrig, glide, 0, 1, false)
    }
    for (let i = 0; i < nv; i++) {
      let used = false
      for (let t = 0; t < tones; t++) if (this.chordMap[t] === i) used = true
      if (!used && this.voices[i].active && !this.bank.isReleased(i)) this.bank.gateOff(i)
    }
  }

  /** Per-synth voice start: pitch mapping, per-mode voice pokes, then
   *  voice.noteOn + bank.started(i, ...) + lastStartHz bookkeeping. */
  protected abstract startVoice(
    i: number, key: number, soundNote: number, vel: number,
    retrig: boolean, glide: boolean, det: number, gain: number, stacked: boolean,
  ): void

  /* -------------------------------------------------- transport / data --- */

  setPlaying(on: boolean): void {
    this.stepSeq.setPlaying(on === true)
    if (!on) this.motion.clearOverrides()
  }

  setSeqData(seq: SeqData): void {
    this.stepSeq.setSeq(seq)
    this.updateTiming(seq.bpm, seq.swing)
    this.motion.releaseStale(seq.motion ?? [])
  }

  loadProgram(p: Program): void {
    this.allNotesOff()
    this.motion.reset()
    for (let k = 0; k < this.layers.length; k++) {
      const layer = this.layers[k]
      layer.value = 0
      layer.dirty = false
      layer.dest = -1
      layer.offset = 0
      layer.gateOff = 0
    }
    this.stepSeq.setGateTimeOffset(0)
    for (const meta of this.paramTable) {
      const v = p.params[meta.id]
      this.params[meta.id] = clamp(Number.isFinite(v) ? v : meta.def, meta.min, meta.max)
    }
    this.curMode = Math.round(this.params[this.ids.voiceMode])
    this.stepSeq.setSeq(p.seq)
    this.updateTiming(p.seq.bpm, p.seq.swing, true)
    this.applyAllParams()
    this.refreshBend()
    this.syncArp()
  }

  private updateTiming(bpm: number, swing: number, force = false): void {
    const b = clamp(Number.isFinite(bpm) ? bpm : 120, 10, 300)
    const sw = clamp(Number.isFinite(swing) ? swing : 0, -75, 75)
    if (!force && b === this.bpm && sw === this.swing) return
    this.bpm = b
    this.swing = sw
    this.onTimingChanged()
    this.refreshGlide()
    this.syncArp()
  }

  /** bpm/swing changed: re-push tempo-derived params (LFO BPM sync, tempo-
   *  synced FX). refreshGlide/syncArp run after this in updateTiming. */
  protected onTimingChanged(): void {}

  /* ------------------------------------------------------------ audio ---- */

  process(outL: Float32Array, outR: Float32Array, n: number): void {
    let frames = n | 0
    if (frames > outL.length) frames = outL.length
    if (frames > outR.length) frames = outR.length
    if (frames <= 0) return

    const layers = this.layers
    for (let k = 0; k < layers.length; k++) {
      if (layers[k].dirty) this.applyOffsetLayer(layers[k])
    }

    // Stolen-voice restarts: fire only once the ~1.5 ms kill ramp has fully
    // faded the old note (live steals arrive between blocks, before the ramp
    // has run — restarting immediately would skip the fade and click).
    this.bank.drainPend(this.pendCb)

    this.preProcess(frames)

    // LFO Voice Sync: "phase shared across voices" — follow voice 0's
    // free-running phase at block rate. (Voice 0 always ticks, idle or
    // active, so its phase is the shared clock; the gate is per-synth.)
    if (this.lfoVoiceSyncOn()) {
      const ph = this.voices[0].lfoPhase
      for (let i = 1; i < this.nv; i++) this.voices[i].setLfoPhase(ph)
    }

    // Sequencer/arp first: their hooks fire noteOn/noteOff/motion into the
    // engine. The arp runs at the engine's transport bpm (same value the
    // sequence carries; hardware shares one tempo).
    this.stepSeq.process(frames)
    if (this.arp) this.arp.process(frames, this.bpm)

    const vs = this.voices
    const nv = this.nv
    const gc = this.gainCoef
    for (let s = 0; s < frames; s++) {
      this.gainSm += gc * (this.gainT - this.gainSm)
      let sum = 0
      for (let i = 0; i < nv; i++) {
        if (vs[i].active) sum += vs[i].tick()
        else vs[i].tickIdle()
      }
      sum *= VOICE_MIX * this.gainSm
      if (!Number.isFinite(sum)) sum = 0
      outL[s] = sum
      outR[s] = sum
      if (this.taps.on) this.taps.writeVoiceSample(vs[this.dbgVoice], vs)
    }

    this.processFx(outL, outR, frames)

    // Final transparent safety limiter.
    for (let s = 0; s < frames; s++) {
      let l = outL[s]
      let r = outR[s]
      if (!Number.isFinite(l)) l = 0
      if (!Number.isFinite(r)) r = 0
      outL[s] = softLimit(l)
      outR[s] = softLimit(r)
    }
    if (this.taps.on) this.taps.writeFxTap(10, outL, outR, frames, true) // final output
  }

  /** Pre-voice work after pended restarts (og: echo queue + duck recovery). */
  protected preProcess(_frames: number): void {}

  /** Whether to share voice 0's LFO phase this block (per-synth predicate;
   *  engines without Voice Sync keep the default false). */
  protected lfoVoiceSyncOn(): boolean {
    return false
  }

  /** The per-synth FX stage: run the chain over the block and place the
   *  SERVICE-MODE FX taps (rings 6..9); the base writes the final ring pair
   *  (10/11) after the limiter. */
  protected abstract processFx(outL: Float32Array, outR: Float32Array, frames: number): void

  /* -------------------------------------------------------- telemetry ---- */

  /** Enable/disable SERVICE MODE taps (all voices record their stages). */
  setDebug(on: boolean): void {
    this.taps.on = on
    for (let i = 0; i < this.nv; i++) this.voices[i].tapOn = on
  }

  get debugOn(): boolean {
    return this.taps.on
  }

  /** 4-voice tap mode (SERVICE MODE '4V'): record every voice's stages. */
  setDebugAll(all: boolean): void {
    this.taps.all = all
  }

  get debugAll(): boolean {
    return this.taps.all
  }

  /** Copy the per-voice tap rings (voice-major) into dst[0..nv*6-1]. */
  copyDebugVoiceTaps(dst: Float32Array[]): void {
    this.taps.copyDebugVoiceTaps(dst)
  }

  get debugVoice(): number {
    return this.dbgVoice
  }

  /** Copy the twelve tap rings (chronological order) into dst[0..11]. */
  copyDebugTaps(dst: Float32Array[]): void {
    this.taps.copyDebugTaps(dst)
  }

  /** Per-voice state for the debug panel's voice lanes. */
  debugVoiceInfo(i: number): {
    note: number
    on: boolean
    amp: number
    drift1: number
    drift2: number
    modEg: number
    lfo: number
    hz: number
  } {
    const v = this.voices[i]
    return {
      note: v.note,
      on: v.active,
      amp: v.lastAmp,
      drift1: v.lastDrift1,
      drift2: v.lastDrift2,
      modEg: v.lastModEg,
      lfo: v.lastLfo,
      hz: v.lastHz,
    }
  }

  activeVoiceCount(): number {
    return this.bank.activeCount()
  }

  /** Gated (non-released) note keys, deduped, for key/LED feedback. */
  collectActiveNotes(dst: number[]): number {
    return this.bank.collectActiveNotes(dst)
  }
}
