/*
 * Engine — the original minilogue replica's synth core (worklet-side,
 * DOM-free). See docs/og-spec.md; UNCONFIRMED behaviors are marked and are
 * hardware-calibration targets.
 *
 * Owns the raw parameter store, 4 Voices, the HI PASS + DELAY block, a
 * StepSeq and an Arp (hooks feed notes/motion back in), and the OG's eight
 * voice modes (spec §3) built on the shared VoiceBank/NoteStack mechanics:
 *
 *   POLY       poly + DEPTH = chord Invert 0..8 (k lowest held notes +1 oct)
 *   DUO        2-voice poly in detuned pairs (DEPTH = detune)
 *   UNISON     4-voice mono stack (DEPTH = detune spread)
 *   MONO       mono + sub oscillator voices (DEPTH ramps -1 oct, then -2 oct)
 *   CHORD      DEPTH selects one of 14 chords
 *   DELAY      voices 2-4 replay voice 1 at DEPTH-selected note divisions
 *   ARP        keys feed the arpeggiator (DEPTH = type; hold = latch)
 *   SIDE CHAIN each new note ducks older voices by DEPTH, with recovery
 *
 * Layered parameter model like the xd engine: effective raw =
 * (motion override ?? knob raw) + slider offset; raw -> physical mapping
 * happens ONCE per change (push model). The slider is the xd joystick-Y
 * machinery with a single bipolar axis (SLIDER_ASSIGN / SLIDER_RANGE);
 * PITCH BEND assignment is handled app-side as real bend messages.
 */
import { P, PARAMS, PARAM_COUNT, MOTION_META, sliderDestParam, SLIDER_DEST_PITCH_BEND, SLIDER_DEST_GATE_TIME } from './params'
import { clamp, dbToGain } from '../../shared/maps'
import {
  pitchToCents,
  pitchEgIntToCents,
  egIntToPercent,
  attackToSec,
  decayToSec,
  releaseToSec,
  cutoffToHz,
  resonanceTo01,
  KEYTRACK_AMOUNT,
  CUTOFF_VELOCITY_AMOUNT,
  lfoRateToHz,
  lfoBpmToHz,
  lfoIntTo01,
  levelTo01,
  programLevelToDb,
  portamentoToSec,
  polyInvert,
  duoDetuneCents,
  unisonDetuneCents,
  monoSubMix,
  sideChainDepth01,
  CHORDS,
  chordIndex,
  arpTypeIndex,
  ARP_TYPES,
  delayModeDivision,
  delayFeedback01,
  delayHipassHz,
} from './curves'
import type { Program, SeqData } from '../../shared/program'
import { VoiceBank, NoteStack } from '../../dsp/voicebank'
import { StepSeq } from '../../dsp/stepseq'
import { Arp } from '../../dsp/arp'
import { ServiceTaps } from '../../dsp/servicetaps'
import { MotionOverlay } from '../../dsp/motionoverlay'
import { Voice } from './voice'
import { OgDelayFx } from './delayfx'

const NV = 4
export const DBG_TAP_SIZE = 1280

/** Voice modes (params.ts / spec §3 order). */
const VM_POLY = 0
const VM_DUO = 1
const VM_UNISON = 2
const VM_MONO = 3
const VM_CHORD = 4
const VM_DELAY = 5
const VM_ARP = 6
const VM_SIDECHAIN = 7

/** Unison detune spread per voice index, x detune cents. */
const UNI_OFF = [-1, -1 / 3, 1 / 3, 1]

/** Per-voice headroom into the mono sum. */
const VOICE_MIX = 0.35

/** PORTAMENTO BPM quantization grid, in beats. */
const PORTA_BEATS = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1]

/** Arp rate: the OG has no rate menu; 16th notes. UNCONFIRMED. */
const ARP_RATE_BEATS = 0.25
const ARP_GATE = 0.75

/** SIDE CHAIN duck recovery time constant, seconds. UNCONFIRMED. */
const DUCK_RECOVERY_SEC = 0.35

/** DELAY-mode echo scheduling capacity (3 echoes x queued strikes). */
const ECHO_CAP = 24

/** Transparent soft limiter: identity below |0.7|, tanh knee, bounded at 1. */
function softLimit(x: number): number {
  if (x > 0.7) return 0.7 + 0.3 * Math.tanh((x - 0.7) / 0.3)
  if (x < -0.7) return -0.7 - 0.3 * Math.tanh((-x - 0.7) / 0.3)
  return x
}

export class Engine {
  private readonly sr: number

  /** Raw knob/menu values, indexed by param id. */
  private readonly params = new Float64Array(PARAM_COUNT)

  // Motion-sequence override layer (dsp/motionoverlay.ts).
  private readonly motion = new MotionOverlay(PARAMS, {
    applyParam: (id) => this.applyParam(id),
    refreshBend: () => this.refreshBend(),
  })

  // Slider (assignable single axis; PITCH BEND assignment arrives as bend).
  private bendX = 0
  private slider = 0
  private sliderDirty = false
  private sliderDest = -1
  private sliderOffset = 0
  private sliderGateOff = 0

  // Voices + allocation mechanics + gated-key model.
  private readonly voices: Voice[] = []
  private readonly bank: VoiceBank<Voice>
  private readonly stack = new NoteStack()
  private curMonoNote = -1
  private sustainOn = false
  private readonly pendCb = (
    i: number, key: number, note: number, vel: number,
    glide: boolean, det: number, gain: number, stacked: boolean,
  ): void => this.startVoice(i, key, note, vel, true, glide, det, gain, stacked)

  // CHORD-mode voice set (rotated via the bank's rotor).
  private readonly chordMap = new Int8Array(NV).fill(-1)
  private chordTones = 0

  // DELAY-mode echo queue (sample countdowns; fired in process()).
  private readonly eLeft = new Float64Array(ECHO_CAP)
  private readonly eKey = new Int32Array(ECHO_CAP)
  private readonly eVel = new Int32Array(ECHO_CAP)
  private eCount = 0

  // SIDE CHAIN duck state (per voice; block-rate recovery).
  private readonly duck = new Float64Array(NV).fill(1)
  private duckActive = false

  // FX + sequencer/arp.
  private readonly delay: OgDelayFx
  private readonly fxChain: ReadonlyArray<{ process(l: Float32Array, r: Float32Array, n: number): void }>
  readonly stepSeq: StepSeq
  readonly arp: Arp
  /** Playhead callback for the processor ({t:'step'} messages). */
  onStep: ((i: number) => void) | null = null

  private bpm = 120
  private swing = 0
  private curMode = VM_POLY
  private glideSec = 0
  private lastStartHz = 0

  // Output stage.
  private gainT = 1
  private gainSm = 1
  private readonly gainCoef: number

  // --- SERVICE MODE taps (dsp/servicetaps.ts; same layout as the xd) -----
  private dbgVoice = 0
  private readonly taps = new ServiceTaps(NV, DBG_TAP_SIZE)

  constructor(sampleRate: number) {
    const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
    this.sr = sr
    this.gainCoef = 1 - Math.exp(-1 / (0.005 * sr))
    for (let i = 0; i < NV; i++) this.voices.push(new Voice(sr, i))
    this.bank = new VoiceBank(this.voices)
    this.delay = new OgDelayFx(sr)
    this.fxChain = [this.delay]
    this.stepSeq = new StepSeq(
      sr,
      {
        noteOn: (note, vel) => this.hookNoteOn(note, vel),
        noteOff: (note) => this.hookNoteOff(note),
        motionValue: (id, v) => this.applyMotion(id, v),
        stepChanged: (i) => {
          if (this.onStep) this.onStep(i)
        },
      },
      MOTION_META,
    )
    this.arp = new Arp(sr, {
      noteOn: (note, vel) => this.hookNoteOn(note, vel),
      noteOff: (note) => this.hookNoteOff(note),
    })
    for (const m of PARAMS) this.params[m.id] = m.def
    this.curMode = Math.round(this.params[P.VOICE_MODE])
    this.applyAllParams()
    this.syncArp()
  }

  /* --------------------------------------------------------- parameters -- */

  setParam(id: number, v: number): void {
    if (!Number.isFinite(v)) return
    const m = PARAMS[id]
    if (!m) return
    this.params[id] = clamp(v, m.min, m.max)
    this.applyParam(id)
  }

  getParam(id: number): number {
    return id >= 0 && id < PARAM_COUNT ? this.params[id] : 0
  }

  /** Effective raw value including motion override + slider offset. */
  effectiveParam(id: number): number {
    const m = PARAMS[id]
    if (!m) return 0
    let v = this.motion.effective(id, this.params[id])
    if (this.sliderDest === id) v += this.sliderOffset
    return clamp(v, m.min, m.max)
  }

  /** Motion-lane value into the non-destructive override layer. */
  applyMotion(paramId: number, v: number): void {
    this.motion.applyMotion(paramId, v)
  }

  /* ------------------------------------------------------------- slider -- */

  /** Pitch bend, -1..1 (slider in PITCH BEND mode, or MIDI bend). */
  setBend(v: number): void {
    if (!Number.isFinite(v)) return
    this.bendX = clamp(v, -1, 1)
    this.refreshBend()
  }

  /** Slider deflection -1..1 for assignable (non-bend) destinations. */
  setJoyY(v: number): void {
    if (!Number.isFinite(v)) return
    this.slider = clamp(v, -1, 1)
    this.sliderDirty = true
  }

  /** The OG has no aftertouch; accepted for protocol compatibility. */
  setPressure(_v: number): void {}

  private refreshBend(): void {
    const v = this.motion.bendOn ? this.motion.bend : this.bendX
    const range = v >= 0 ? this.params[P.BEND_RANGE_PLUS] : this.params[P.BEND_RANGE_MINUS]
    const mult = Math.pow(2, (v * range) / 12)
    for (let i = 0; i < NV; i++) this.voices[i].setBendMult(mult)
  }

  private applySlider(): void {
    this.sliderDirty = false
    const v = this.slider
    let dest = -1
    let offset = 0
    let gateOffset = 0
    if (v > 1e-3 || v < -1e-3) {
      const idx = Math.round(this.params[P.SLIDER_ASSIGN])
      const destId = sliderDestParam(idx)
      const rangePct = (this.params[P.SLIDER_RANGE] - 100) / 100
      if (destId === SLIDER_DEST_GATE_TIME) {
        gateOffset = v * rangePct * 72
      } else if (destId !== SLIDER_DEST_PITCH_BEND && destId >= 0) {
        const meta = PARAMS[destId]
        dest = destId
        offset = v * rangePct * (meta.max - meta.min)
      }
    }
    this.sliderGateOff = gateOffset
    this.stepSeq.setGateTimeOffset(gateOffset)
    if (dest === this.sliderDest && offset === this.sliderOffset) return
    const prev = this.sliderDest
    this.sliderDest = dest
    this.sliderOffset = offset
    if (prev >= 0 && prev !== dest) this.applyParam(prev)
    if (dest >= 0) this.applyParam(dest)
  }

  /* ----------------------------------------------- raw -> physical push -- */

  private applyAllParams(): void {
    for (let id = 0; id < PARAM_COUNT; id++) this.applyParam(id)
  }

  private applyParam(id: number): void {
    const meta = PARAMS[id]
    if (!meta) return
    const e = this.effectiveParam(id)
    const vs = this.voices
    switch (id) {
      case P.VCO1_WAVE:
        for (let i = 0; i < NV; i++) vs[i].setVcoWave(0, Math.round(e))
        break
      case P.VCO2_WAVE:
        for (let i = 0; i < NV; i++) vs[i].setVcoWave(1, Math.round(e))
        break
      case P.VCO1_OCTAVE:
        for (let i = 0; i < NV; i++) vs[i].setVcoOctave(0, Math.pow(2, Math.round(e) - 1))
        break
      case P.VCO2_OCTAVE:
        for (let i = 0; i < NV; i++) vs[i].setVcoOctave(1, Math.pow(2, Math.round(e) - 1))
        break
      case P.VCO1_PITCH: {
        const c = pitchToCents(e)
        for (let i = 0; i < NV; i++) vs[i].setVcoPitchCents(0, c)
        break
      }
      case P.VCO2_PITCH: {
        const c = pitchToCents(e)
        for (let i = 0; i < NV; i++) vs[i].setVcoPitchCents(1, c)
        break
      }
      case P.VCO1_SHAPE:
        for (let i = 0; i < NV; i++) vs[i].setVcoShape(0, e / 1023)
        break
      case P.VCO2_SHAPE:
        for (let i = 0; i < NV; i++) vs[i].setVcoShape(1, e / 1023)
        break
      case P.CROSS_MOD:
        for (let i = 0; i < NV; i++) vs[i].setXmod(e / 1023)
        break
      case P.PITCH_EG_INT: {
        const c = pitchEgIntToCents(e)
        for (let i = 0; i < NV; i++) vs[i].setPitchEgCents(c)
        break
      }
      case P.SYNC:
        for (let i = 0; i < NV; i++) vs[i].setSync(e >= 0.5)
        break
      case P.RING:
        for (let i = 0; i < NV; i++) vs[i].setRing(e >= 0.5)
        break
      case P.VCO1_LEVEL: {
        const l = levelTo01(e)
        for (let i = 0; i < NV; i++) vs[i].setVcoLevel(0, l)
        break
      }
      case P.VCO2_LEVEL: {
        const l = levelTo01(e)
        for (let i = 0; i < NV; i++) vs[i].setVcoLevel(1, l)
        break
      }
      case P.NOISE_LEVEL: {
        const l = levelTo01(e)
        for (let i = 0; i < NV; i++) vs[i].setNoiseLevel(l)
        break
      }
      case P.CUTOFF: {
        const hz = cutoffToHz(e)
        for (let i = 0; i < NV; i++) vs[i].setCutoff(hz)
        break
      }
      case P.RESONANCE: {
        const r = resonanceTo01(e)
        for (let i = 0; i < NV; i++) vs[i].setResonance(r)
        break
      }
      case P.EG_INT: {
        const pct = egIntToPercent(e)
        for (let i = 0; i < NV; i++) vs[i].setEgInt(pct)
        break
      }
      case P.FILTER_TYPE:
        for (let i = 0; i < NV; i++) vs[i].setFilterPoles(Math.round(e) === 1 ? 4 : 2)
        break
      case P.KEYTRACK: {
        const k = KEYTRACK_AMOUNT[Math.round(e)] ?? 0
        for (let i = 0; i < NV; i++) vs[i].setKeytrack(k)
        break
      }
      case P.CUTOFF_VELOCITY: {
        const k = CUTOFF_VELOCITY_AMOUNT[Math.round(e)] ?? 0
        for (let i = 0; i < NV; i++) vs[i].setCutoffVelocity(k)
        break
      }
      case P.AMP_ATTACK:
      case P.AMP_DECAY:
      case P.AMP_SUSTAIN:
      case P.AMP_RELEASE: {
        const a = attackToSec(this.effectiveParam(P.AMP_ATTACK))
        const d = decayToSec(this.effectiveParam(P.AMP_DECAY))
        const s = this.effectiveParam(P.AMP_SUSTAIN) / 1023
        const r = releaseToSec(this.effectiveParam(P.AMP_RELEASE))
        for (let i = 0; i < NV; i++) vs[i].setAmpEg(a, d, s, r)
        break
      }
      case P.EG_ATTACK:
      case P.EG_DECAY:
      case P.EG_SUSTAIN:
      case P.EG_RELEASE: {
        const a = attackToSec(this.effectiveParam(P.EG_ATTACK))
        const d = decayToSec(this.effectiveParam(P.EG_DECAY))
        const s = this.effectiveParam(P.EG_SUSTAIN) / 1023
        const r = releaseToSec(this.effectiveParam(P.EG_RELEASE))
        for (let i = 0; i < NV; i++) vs[i].setModEg(a, d, s, r)
        break
      }
      case P.LFO_WAVE:
        for (let i = 0; i < NV; i++) vs[i].setLfoWave(Math.round(e))
        break
      case P.LFO_EG_MOD:
        for (let i = 0; i < NV; i++) vs[i].setLfoEgMod(Math.round(e))
        break
      case P.LFO_RATE:
      case P.LFO_BPM_SYNC:
        this.refreshLfoFreq()
        break
      case P.LFO_INT: {
        const l = lfoIntTo01(e)
        for (let i = 0; i < NV; i++) vs[i].setLfoInt(l)
        break
      }
      case P.LFO_TARGET:
        for (let i = 0; i < NV; i++) vs[i].setLfoTarget(Math.round(e))
        break
      case P.LFO_KEY_SYNC:
        for (let i = 0; i < NV; i++) vs[i].setLfoKeySync(e >= 0.5)
        break
      case P.LFO_VOICE_SYNC:
        break // read at noteOn time
      case P.DELAY_HIPASS:
        this.delay.setHipassHz(delayHipassHz(e))
        break
      case P.DELAY_TIME:
        this.delay.setTime(e / 1023)
        break
      case P.DELAY_FEEDBACK:
        this.delay.setFeedback(delayFeedback01(e))
        break
      case P.DELAY_ROUTING:
        this.delay.setRouting(Math.round(e))
        break
      case P.VOICE_MODE: {
        const m = Math.round(e)
        if (m !== this.curMode) {
          this.curMode = m
          this.bank.releaseAll(this.sustainOn)
          this.stack.clear()
          this.curMonoNote = -1
          this.stack.clearMonoSustained()
          this.eCount = 0
          this.resetDucks()
        }
        this.syncArp()
        break
      }
      case P.VM_DEPTH: {
        // Live knob semantics per mode (spec §3).
        if (this.curMode === VM_UNISON) {
          const det = unisonDetuneCents(e)
          for (let i = 0; i < NV; i++) {
            if (vs[i].active) vs[i].setDetuneCents(UNI_OFF[i] * det)
          }
        } else if (this.curMode === VM_DUO) {
          const det = duoDetuneCents(e)
          for (let i = 0; i < NV; i++) {
            if (this.bank.isStacked(i) && vs[i].active) vs[i].setDetuneCents(det)
          }
        } else if (this.curMode === VM_MONO) {
          this.refreshMonoSubGains()
        } else if (this.curMode === VM_POLY) {
          this.applyPolyInvert()
        }
        this.syncArp()
        break
      }
      case P.ARP_LATCH:
        this.syncArp()
        break
      case P.OCTAVE:
        break // keyboard-side transpose (UI emits shifted notes)
      case P.PORTAMENTO:
      case P.PORTAMENTO_BPM:
        this.refreshGlide()
        break
      case P.PORTAMENTO_MODE:
        break // read at noteOn time
      case P.PROGRAM_LEVEL:
        this.gainT = dbToGain(programLevelToDb(e))
        break
      case P.BEND_RANGE_PLUS:
      case P.BEND_RANGE_MINUS:
        this.refreshBend()
        break
      case P.SLIDER_ASSIGN:
      case P.SLIDER_RANGE:
        this.sliderDirty = true
        break
      case P.AMP_VELOCITY:
        for (let i = 0; i < NV; i++) vs[i].setAmpVelocity(e)
        break
      default:
        break
    }
  }

  private refreshLfoFreq(): void {
    const raw = this.effectiveParam(P.LFO_RATE)
    const hz = this.params[P.LFO_BPM_SYNC] >= 0.5 ? lfoBpmToHz(raw, this.bpm) : lfoRateToHz(raw)
    for (let i = 0; i < NV; i++) this.voices[i].setLfoFreq(hz)
  }

  private refreshGlide(): void {
    let sec = portamentoToSec(this.effectiveParam(P.PORTAMENTO))
    if (sec > 0 && this.params[P.PORTAMENTO_BPM] >= 0.5) {
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
    for (let i = 0; i < NV; i++) this.voices[i].setGlideTime(sec)
  }

  private syncArp(): void {
    this.arp.setConfig({
      enabled: this.curMode === VM_ARP,
      typeIndex: arpTypeIndex(this.effectiveParam(P.VM_DEPTH)),
      latch: this.params[P.ARP_LATCH] >= 0.5,
      rateBeats: ARP_RATE_BEATS,
      gate01: ARP_GATE,
      swing: this.swing,
    })
  }

  /* --------------------------------------------------- pitch ------------- */

  /** note -> Hz (no microtuning/transpose menus on the OG). */
  private noteHz(note: number): number {
    return 440 * Math.pow(2, (note - 69) / 12)
  }

  /* ---------------------------------------------------------- notes ------ */

  noteOn(note: number, vel: number): void {
    if (!Number.isFinite(note) || !Number.isFinite(vel)) return
    const n = Math.max(0, Math.min(127, Math.round(note)))
    const v = Math.max(1, Math.min(127, Math.round(vel)))
    this.stack.setHeld(n, true)
    if (this.curMode === VM_ARP) {
      this.arp.keyDown(n, v)
      return
    }
    this.noteOnInternal(n, v, false)
  }

  noteOff(note: number): void {
    if (!Number.isFinite(note)) return
    const n = Math.max(0, Math.min(127, Math.round(note)))
    this.stack.setHeld(n, false)
    this.arp.keyUp(n)
    if (this.curMode === VM_ARP) return
    this.noteOffInternal(n, false)
  }

  allNotesOff(): void {
    this.bank.hardReleaseAll()
    this.stack.clear()
    this.curMonoNote = -1
    this.stack.clearMonoSustained()
    this.stack.clearHeld((n) => this.arp.keyUp(n))
    this.eCount = 0
    this.resetDucks()
    this.arp.setConfig({
      enabled: false,
      typeIndex: 0,
      latch: false,
      rateBeats: ARP_RATE_BEATS,
      gate01: ARP_GATE,
      swing: this.swing,
    })
    this.syncArp()
  }

  sustain(on: boolean): void {
    this.sustainOn = on === true
    if (!this.sustainOn) {
      this.stack.flushMonoSustained(this.curMonoNote, (n) => this.noteOffInternal(n, false))
      this.bank.flushSustained((key) => this.stack.contains(key))
    }
  }

  private hookNoteOn(note: number, vel: number): void {
    const n = Math.max(0, Math.min(127, Math.round(note)))
    const v = Math.max(1, Math.min(127, Math.round(vel)))
    this.noteOnInternal(n, v, this.curMode === VM_ARP)
  }

  private hookNoteOff(note: number): void {
    const n = Math.max(0, Math.min(127, Math.round(note)))
    this.noteOffInternal(n, this.curMode === VM_ARP)
  }

  private isMonoMode(mode: number): boolean {
    return mode === VM_UNISON || mode === VM_CHORD || mode === VM_MONO
  }

  private noteOnInternal(note: number, vel: number, forcePoly: boolean): void {
    if (this.stack.isMonoSustained(note)) {
      this.stack.setMonoSustained(note, false)
      this.stack.remove(note)
    }
    const legato = this.stack.count > 0
    this.stack.push(note, vel)
    const mode = forcePoly ? VM_POLY : this.curMode
    if (this.isMonoMode(mode)) {
      this.monoStart(note, vel, legato)
      return
    }
    if (mode === VM_DUO) {
      this.duoNoteOn(note, vel, legato)
      return
    }
    if (mode === VM_DELAY) {
      this.polyNoteOn(note, note, vel, legato)
      this.scheduleEchoes(note, vel)
      return
    }
    if (mode === VM_SIDECHAIN) {
      const i = this.polyNoteOn(note, note, vel, legato)
      this.duckOthers(i)
      return
    }
    // POLY: chord-invert voicing of the held set (spec §3, UNCONFIRMED).
    // Arp hook notes are plain poly — their VM DEPTH selects the arp type.
    const sound = forcePoly ? note : this.invertedNote(note)
    this.polyNoteOn(note, sound, vel, legato)
    if (!forcePoly) this.applyPolyInvert()
  }

  private noteOffInternal(note: number, forcePoly: boolean): void {
    const mode = forcePoly ? VM_POLY : this.curMode
    if (this.isMonoMode(mode)) {
      if (this.sustainOn) {
        this.stack.setMonoSustained(note, true)
        return
      }
      this.stack.remove(note)
      if (this.stack.count === 0) {
        this.bank.releaseAll(this.sustainOn)
        this.curMonoNote = -1
      } else if (note === this.curMonoNote) {
        this.monoStart(this.stack.topNote(), this.stack.topVel(), true)
      }
      return
    }
    this.stack.remove(note)
    this.bank.releaseKey(note, this.sustainOn)
    if (mode === VM_POLY && !forcePoly) this.applyPolyInvert()
  }

  /* ------------------------------------------------ mode implementations - */

  /** UNISON / CHORD / MONO start (last-note priority, legato = no retrig). */
  private monoStart(note: number, vel: number, legato: boolean): void {
    const retrig = !legato // UNCONFIRMED: classic auto-legato (no menu on OG)
    const glide = this.glideFor(legato)
    this.curMonoNote = note
    if (this.curMode === VM_UNISON) {
      const det = unisonDetuneCents(this.effectiveParam(P.VM_DEPTH))
      for (let i = 0; i < NV; i++) {
        this.startVoice(i, note, note, vel, retrig, glide, UNI_OFF[i] * det, 1, false)
      }
    } else if (this.curMode === VM_MONO) {
      // Voice roles (spec §3): v0 main; v1+v2 sub -1 oct; v3 sub -2 oct,
      // levels from the DEPTH crossfade (UNCONFIRMED curve).
      const mix = monoSubMix(this.effectiveParam(P.VM_DEPTH))
      this.startVoice(0, note, note, vel, retrig, glide, 0, 1, false)
      this.startVoice(1, note, note - 12, vel, retrig, glide, 0, mix.sub1, true)
      this.startVoice(2, note, note - 12, vel, retrig, glide, 0, mix.sub1, true)
      this.startVoice(3, note, note - 24, vel, retrig, glide, 0, mix.sub2, true)
    } else {
      const chord = CHORDS[chordIndex(this.effectiveParam(P.VM_DEPTH))]
      const tones = Math.min(chord.notes.length, NV)
      const reuse = !retrig && this.chordTones === tones && this.chordMap[0] >= 0
      if (!reuse) {
        const base = this.bank.takeRotor(tones)
        for (let t = 0; t < tones; t++) this.chordMap[t] = (base + t) % NV
        for (let t = tones; t < NV; t++) this.chordMap[t] = -1
        this.chordTones = tones
      }
      for (let t = 0; t < tones; t++) {
        this.startVoice(this.chordMap[t], note, note + chord.notes[t], vel, retrig, glide, 0, 1, false)
      }
      for (let i = 0; i < NV; i++) {
        let used = false
        for (let t = 0; t < tones; t++) if (this.chordMap[t] === i) used = true
        if (!used && this.voices[i].active && !this.bank.isReleased(i)) this.bank.gateOff(i)
      }
    }
  }

  /** Poly allocation; returns the started voice index (-1 = stolen/pended). */
  private polyNoteOn(key: number, soundNote: number, vel: number, legato: boolean): number {
    const glide = this.glideFor(legato)
    const i = this.bank.alloc()
    if (i >= 0) {
      this.startVoice(i, key, soundNote, vel, true, glide, 0, 1, false)
      return i
    }
    this.bank.steal(this.bank.oldest(), key, soundNote, vel, glide, 0, 1, false)
    return -1
  }

  /** DUO: detuned pairs, 2-voice poly (spec §3). */
  private duoNoteOn(note: number, vel: number, legato: boolean): void {
    const glide = this.glideFor(legato)
    const det = duoDetuneCents(this.effectiveParam(P.VM_DEPTH))
    const { pair, kind } = this.bank.allocPair()
    const a = pair * 2
    if (kind === 'steal') {
      this.bank.steal(a, note, note, vel, glide, 0, 1, false)
      this.bank.steal(a + 1, note, note, vel, glide, det, 1, true)
      return
    }
    this.startVoice(a, note, note, vel, true, glide, 0, 1, false)
    this.startVoice(a + 1, note, note, vel, true, glide, det, 1, true)
  }

  /** DELAY mode: schedule voices 2-4 as delayed replays (spec §3). */
  private scheduleEchoes(note: number, vel: number): void {
    const beats = delayModeDivision(this.effectiveParam(P.VM_DEPTH)).beats
    const step = beats * (60 / this.bpm) * this.sr
    for (let k = 1; k <= 3; k++) {
      if (this.eCount >= ECHO_CAP) break
      this.eLeft[this.eCount] = step * k
      this.eKey[this.eCount] = note
      this.eVel[this.eCount] = vel
      this.eCount++
    }
  }

  private fireEchoes(frames: number): void {
    for (let k = this.eCount - 1; k >= 0; k--) {
      this.eLeft[k] -= frames
      if (this.eLeft[k] > 0) continue
      const key = this.eKey[k]
      const vel = this.eVel[k]
      // remove entry (swap-with-last)
      const last = this.eCount - 1
      this.eLeft[k] = this.eLeft[last]
      this.eKey[k] = this.eKey[last]
      this.eVel[k] = this.eVel[last]
      this.eCount = last
      const held = this.stack.isHeld(key) || this.sustainOn
      const i = this.bank.alloc()
      if (i >= 0) {
        this.startVoice(i, key, key, vel, true, false, 0, 1, false)
        // Key already up: the echo plays as a release tail (UNCONFIRMED).
        if (!held) this.bank.gateOff(i)
      } else if (held) {
        this.bank.steal(this.bank.oldest(), key, key, vel, false, 0, 1, false)
      }
    }
  }

  /** MONO: live DEPTH knob re-levels the sub voices (spec §3). */
  private refreshMonoSubGains(): void {
    const mix = monoSubMix(this.effectiveParam(P.VM_DEPTH))
    if (this.voices[1].active) this.voices[1].setVoiceGain(mix.sub1)
    if (this.voices[2].active) this.voices[2].setVoiceGain(mix.sub1)
    if (this.voices[3].active) this.voices[3].setVoiceGain(mix.sub2)
  }

  /* SIDE CHAIN ducking ----------------------------------------------------- */

  private duckOthers(startedVoice: number): void {
    const depth = sideChainDepth01(this.effectiveParam(P.VM_DEPTH))
    if (depth <= 0) return
    const floor = 1 - depth
    for (let i = 0; i < NV; i++) {
      if (i === startedVoice) continue
      if (this.voices[i].active && this.duck[i] > floor) this.duck[i] = floor
    }
    this.duckActive = true
  }

  private resetDucks(): void {
    this.duck.fill(1)
    if (this.duckActive) {
      for (let i = 0; i < NV; i++) this.voices[i].setVoiceGain(1)
      this.duckActive = false
    }
  }

  private tickDucks(frames: number): void {
    if (!this.duckActive) return
    const a = 1 - Math.exp(-frames / (DUCK_RECOVERY_SEC * this.sr))
    let anyBelow = false
    for (let i = 0; i < NV; i++) {
      let d = this.duck[i]
      if (d < 1) {
        d += a * (1 - d)
        if (d > 0.9995) d = 1
        this.duck[i] = d
        if (d < 1) anyBelow = true
      }
      this.voices[i].setVoiceGain(d)
    }
    if (!anyBelow && this.curMode !== VM_SIDECHAIN) this.duckActive = false
  }

  /* POLY invert ------------------------------------------------------------ */

  /** Sound note for a key under the current invert amount (k lowest +1 oct). */
  private invertedNote(key: number): number {
    const k = polyInvert(this.effectiveParam(P.VM_DEPTH))
    if (k <= 0) return key
    return key + (this.heldRank(key) < k ? 12 : 0)
  }

  /** Rank of `key` among gated stack keys, ascending (0 = lowest). */
  private heldRank(key: number): number {
    let rank = 0
    for (let i = 0; i < 128; i++) {
      if (i === key) break
      if (this.stack.contains(i)) rank++
    }
    return rank
  }

  /** Re-voice sounding POLY notes after the held set / depth changes. */
  private applyPolyInvert(): void {
    if (this.curMode !== VM_POLY) return
    for (let i = 0; i < NV; i++) {
      const key = this.bank.keyOf(i)
      if (key < 0 || !this.voices[i].active || this.bank.isReleased(i)) continue
      const cur = this.bank.noteOf(i)
      const sound = this.stack.contains(key) ? this.invertedNote(key) : cur
      if (sound !== cur) {
        this.bank.setNote(i, sound)
        this.voices[i].setPitch(sound, this.noteHz(sound), false)
      }
    }
  }

  /* voice start ------------------------------------------------------------ */

  private startVoice(
    i: number, key: number, soundNote: number, vel: number,
    retrig: boolean, glide: boolean, det: number, gain: number, stacked: boolean,
  ): void {
    const v = this.voices[i]
    this.dbgVoice = i
    const hz = this.noteHz(soundNote)
    v.setDetuneCents(det)
    v.setVoiceGain(this.curMode === VM_SIDECHAIN ? this.duck[i] * gain : gain)
    if (this.curMode === VM_SIDECHAIN) this.duck[i] = 1 // new strike plays full
    if (glide && !v.active && this.lastStartHz > 0) v.setGlideStart(this.lastStartHz)
    let syncP = -1
    if (this.params[P.LFO_VOICE_SYNC] >= 0.5) {
      for (let k = 0; k < NV; k++) {
        if (k !== i && this.voices[k].active) {
          syncP = this.voices[k].lfoPhase
          break
        }
      }
    }
    v.noteOn(soundNote, hz, vel, retrig, glide)
    if (syncP >= 0) v.setLfoPhase(syncP)
    this.bank.started(i, key, soundNote, stacked)
    this.lastStartHz = hz
  }

  private glideFor(legato: boolean): boolean {
    if (this.glideSec <= 0) return false
    return this.params[P.PORTAMENTO_MODE] >= 0.5 || legato
  }

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
    this.sliderDest = -1
    this.sliderOffset = 0
    this.slider = 0
    this.sliderDirty = false
    this.sliderGateOff = 0
    this.stepSeq.setGateTimeOffset(0)
    for (const meta of PARAMS) {
      const v = p.params[meta.id]
      this.params[meta.id] = clamp(Number.isFinite(v) ? v : meta.def, meta.min, meta.max)
    }
    this.curMode = Math.round(this.params[P.VOICE_MODE])
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
    this.refreshLfoFreq()
    this.refreshGlide()
    this.syncArp()
  }

  /* ------------------------------------------------------------ audio ---- */

  process(outL: Float32Array, outR: Float32Array, n: number): void {
    let frames = n | 0
    if (frames > outL.length) frames = outL.length
    if (frames > outR.length) frames = outR.length
    if (frames <= 0) return

    if (this.sliderDirty) this.applySlider()

    this.bank.drainPend(this.pendCb)
    if (this.eCount > 0) this.fireEchoes(frames)
    this.tickDucks(frames)

    // Sequencer/arp first: their hooks fire notes/motion into the engine.
    this.stepSeq.process(frames)
    this.arp.process(frames, this.bpm)

    const vs = this.voices
    const gc = this.gainCoef
    for (let s = 0; s < frames; s++) {
      this.gainSm += gc * (this.gainT - this.gainSm)
      let sum = 0
      if (vs[0].active) sum += vs[0].tick()
      else vs[0].tickIdle()
      if (vs[1].active) sum += vs[1].tick()
      else vs[1].tickIdle()
      if (vs[2].active) sum += vs[2].tick()
      else vs[2].tickIdle()
      if (vs[3].active) sum += vs[3].tick()
      else vs[3].tickIdle()
      sum *= VOICE_MIX * this.gainSm
      if (!Number.isFinite(sum)) sum = 0
      outL[s] = sum
      outR[s] = sum
      if (this.taps.on) this.taps.writeVoiceSample(vs[this.dbgVoice], vs)
    }

    // FX: pre-delay tap, the HPF+DELAY block, post-delay tap.
    if (this.taps.on) this.taps.writeFxTap(6, outL, outR, frames, false)
    for (let f = 0; f < this.fxChain.length; f++) this.fxChain[f].process(outL, outR, frames)
    if (this.taps.on) this.taps.writeFxTap(8, outL, outR, frames, false)

    // Final transparent safety limiter.
    for (let s = 0; s < frames; s++) {
      let l = outL[s]
      let r = outR[s]
      if (!Number.isFinite(l)) l = 0
      if (!Number.isFinite(r)) r = 0
      outL[s] = softLimit(l)
      outR[s] = softLimit(r)
    }
    if (this.taps.on) this.taps.writeFxTap(10, outL, outR, frames, true)
  }

  /* -------------------------------------------------------- telemetry ---- */

  setDebug(on: boolean): void {
    this.taps.on = on
    for (let i = 0; i < NV; i++) this.voices[i].tapOn = on
  }

  get debugOn(): boolean {
    return this.taps.on
  }

  setDebugAll(all: boolean): void {
    this.taps.all = all
  }

  get debugAll(): boolean {
    return this.taps.all
  }

  copyDebugVoiceTaps(dst: Float32Array[]): void {
    this.taps.copyDebugVoiceTaps(dst)
  }

  get debugVoice(): number {
    return this.dbgVoice
  }

  copyDebugTaps(dst: Float32Array[]): void {
    this.taps.copyDebugTaps(dst)
  }

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

  collectActiveNotes(dst: number[]): number {
    return this.bank.collectActiveNotes(dst)
  }
}

/** The 13 arp type names (UI + tests). */
export { ARP_TYPES }
