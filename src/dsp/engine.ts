/*
 * Engine — the minilogue xd replica's synth core (worklet-side, DOM-free).
 *
 * Owns the raw parameter store, 4 Voices, the FX chain (MOD FX -> DELAY ->
 * REVERB, spec §1) and a Sequencer (whose hooks feed notes/motion back in).
 *
 * Layered parameter model (all mapping through shared/maps.ts):
 *   effective raw = (motion override ?? knob raw) + joystick-Y offset
 * Raw -> physical mapping happens ONCE per change here (push model); voices
 * only ever receive physical units. Motion overrides clear when the
 * sequencer transport stops; the joystick and aftertouch offset layers are
 * non-destructive and recomputed at block rate.
 *
 * Voice modes (spec §3): POLY (+DUO zone), UNISON, CHORD, ARP. In ARP mode
 * live keys are fed to the sequencer's arpeggiator and its hook noteOns come
 * back into the poly allocator.
 */
import {
  P,
  PARAMS,
  PARAM_COUNT,
  MOTION_PITCH_BEND,
  MOTION_GATE_TIME,
} from '../shared/params'
import {
  clamp,
  pitchToCents,
  egIntToPercent,
  attackToSec,
  decayToSec,
  releaseToSec,
  cutoffToHz,
  resonanceTo01,
  KEYTRACK_AMOUNT,
  lfoRateToHz,
  lfoBpmToHz,
  lfoIntTo01,
  levelTo01,
  programLevelToDb,
  dbToGain,
  portamentoToSec,
  polyDuo,
  unisonDetuneCents,
  CHORDS,
  chordIndex,
  arpTypeIndex,
  microTuneCents,
} from '../shared/maps'
import type { Program, SeqData } from '../shared/program'
import { Sequencer } from './seq'
import { Voice } from './voice'
import { ModFx } from './fx/modfx'
import { DelayFx } from './fx/delay'
import { ReverbFx } from './fx/reverb'

const NV = 4
/**
 * Samples per SERVICE-MODE tap frame: the panel shows a 512-sample window
 * center-triggered within the frame, so the trigger search span is
 * DBG_TAP_SIZE - 512 ≈ 16 ms at 48 kHz — a guaranteed lock down to ~C2.
 */
export const DBG_TAP_SIZE = 1280

/** Voice modes (params.ts order). */
const VM_ARP = 0
const VM_CHORD = 1
const VM_UNISON = 2
const VM_POLY = 3

/** Unison detune spread per voice index, x detune cents. */
const UNI_OFF = [-1, -1 / 3, 1 / 3, 1]

/** DUO: stacked-voice detune at amount = 1, in cents. */
const DUO_DETUNE_CENTS = 30

/** Per-voice headroom into the mono sum (4 voices stay mostly linear). */
const VOICE_MIX = 0.35

/** PORTAMENTO BPM quantization grid, in beats. */
const PORTA_BEATS = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1]

/** Pentatonic pitch-class sets (nearest-below snapping). */
const PENTA_MAJOR = [0, 2, 4, 7, 9]
const PENTA_MINOR = [0, 3, 5, 7, 10]
const MT_MAJOR_PENTA = 8
const MT_MINOR_PENTA = 9
const MT_REVERSE = 10

/** Joystick Y+/Y- destination table (JOY_ASSIGN_DESTS order). -1 = GATE TIME
 * (a sequencer concept: routed to the sequencer as a live gate offset),
 * -2 = MULTI SHAPE (dynamic). */
const JOY_DEST_IDS: readonly number[] = [
  -1, P.PORTAMENTO, P.VM_DEPTH, P.VCO1_PITCH, P.VCO1_SHAPE, P.VCO2_PITCH,
  P.VCO2_SHAPE, P.CROSS_MOD, -2, P.VCO1_LEVEL, P.VCO2_LEVEL, P.MULTI_LEVEL,
  P.CUTOFF, P.RESONANCE, P.AMP_ATTACK, P.AMP_DECAY, P.AMP_SUSTAIN,
  P.AMP_RELEASE, P.EG_ATTACK, P.EG_DECAY, P.EG_INT, P.LFO_RATE, P.LFO_INT,
  P.MODFX_TIME, P.MODFX_DEPTH, P.REVERB_TIME, P.REVERB_DEPTH, P.DELAY_TIME,
  P.DELAY_DEPTH,
]

const MODFX_SUB_PARAM = [
  P.MODFX_SUB_CHORUS, P.MODFX_SUB_ENSEMBLE, P.MODFX_SUB_PHASER,
  P.MODFX_SUB_FLANGER, P.MODFX_SUB_USER,
]

const STACK_CAP = 64

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

  // Motion-sequence override layer (raw units; cleared when transport stops).
  private readonly motionVal = new Float64Array(PARAM_COUNT)
  private readonly motionHas = new Uint8Array(PARAM_COUNT)
  private motionBendOn = false
  private motionBend = 0

  // Joystick.
  private bendX = 0
  private joyY = 0
  private joyDirty = false
  private joyDest = -1
  private joyOffset = 0
  private joyGateOff = 0

  // Channel aftertouch (MIDI_AT_ASSIGN destination, same offset machinery).
  private pressure = 0
  private pressureDirty = false
  private atDest = -1
  private atOffset = 0
  private atGateOff = 0

  // Voices + allocator bookkeeping.
  private readonly voices: Voice[] = []
  private readonly vKey = new Int32Array(NV).fill(-1) // external key identity
  private readonly vNote = new Int32Array(NV) // sounding note (pre-tuning)
  private readonly vGen = new Float64Array(NV)
  private readonly vReleased = new Uint8Array(NV)
  private readonly vSustained = new Uint8Array(NV)
  private readonly vStacked = new Uint8Array(NV) // DUO stacked-voice marker
  private gen = 0
  // Pending restarts after a steal (applied at the next process block).
  private readonly pendFlag = new Uint8Array(NV)
  private readonly pendKey = new Int32Array(NV)
  private readonly pendNote = new Int32Array(NV)
  private readonly pendVel = new Int32Array(NV)
  private readonly pendDet = new Float64Array(NV)
  private readonly pendGain = new Float64Array(NV)
  private readonly pendStk = new Uint8Array(NV)
  private readonly pendGlide = new Uint8Array(NV)

  // Gated-note stack (all modes): legato detection + mono last-note priority.
  private readonly stackNote = new Int32Array(STACK_CAP)
  private readonly stackVel = new Int32Array(STACK_CAP)
  private stackCount = 0
  private curMonoNote = -1

  private readonly physHeld = new Uint8Array(128)
  /** UNISON/CHORD keys released while the damper is down (deferred). */
  private readonly monoSustained = new Uint8Array(128)
  private sustainOn = false
  private curMode = VM_POLY
  private glideSec = 0
  private lastStartHz = 0
  private calcSemis = 60 // scratch: semitone of the last noteHz() call

  // FX + sequencer.
  private readonly modfx: ModFx
  private readonly delay: DelayFx
  private readonly reverb: ReverbFx
  readonly seq: Sequencer
  /** Playhead callback for the processor ({t:'step'} messages). */
  onStep: ((i: number) => void) | null = null

  private bpm = 120
  private swing = 0

  // Output stage.
  private gainT = 1
  private gainSm = 1
  private readonly gainCoef: number
  private peak = 0

  // --- round-robin allocation state (hardware cycles voices) -------------
  private rotor = 0
  private pairRotor = 0
  private readonly chordMap = new Int8Array(NV).fill(-1)
  private chordTones = 0

  // --- SERVICE MODE (debug panel) taps: zero-cost unless enabled ---------
  private dbgOn = false
  private dbgVoice = 0 // most recently triggered voice index
  private readonly dbgRings = [
    new Float32Array(DBG_TAP_SIZE),
    new Float32Array(DBG_TAP_SIZE),
    new Float32Array(DBG_TAP_SIZE),
    new Float32Array(DBG_TAP_SIZE),
  ]
  private dbgW = 0

  constructor(sampleRate: number) {
    const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
    this.sr = sr
    this.gainCoef = 1 - Math.exp(-1 / (0.005 * sr))
    for (let i = 0; i < NV; i++) this.voices.push(new Voice(sr, i))
    this.modfx = new ModFx(sr)
    this.delay = new DelayFx(sr)
    this.reverb = new ReverbFx(sr)
    this.seq = new Sequencer(sr, {
      noteOn: (note, vel) => this.hookNoteOn(note, vel),
      noteOff: (note) => this.hookNoteOff(note),
      motionValue: (id, v) => this.applyMotion(id, v),
      stepChanged: (i) => {
        if (this.onStep) this.onStep(i)
      },
    })
    for (const m of PARAMS) this.params[m.id] = m.def
    this.curMode = Math.round(this.params[P.VOICE_MODE])
    this.delay.setBpm(this.bpm)
    this.applyAllParams()
    this.syncArp()
  }

  /* --------------------------------------------------------- parameters -- */

  /** Store a raw knob/menu value and push its mapped physical value(s). */
  setParam(id: number, v: number): void {
    if (!Number.isFinite(v)) return
    const m = PARAMS[id]
    if (!m) return
    this.params[id] = clamp(v, m.min, m.max)
    this.applyParam(id)
  }

  /** Raw knob value (no overrides). */
  getParam(id: number): number {
    return id >= 0 && id < PARAM_COUNT ? this.params[id] : 0
  }

  /** Effective raw value including motion override + joystick offset. */
  effectiveParam(id: number): number {
    const m = PARAMS[id]
    if (!m) return 0
    let v = this.motionHas[id] ? this.motionVal[id] : this.params[id]
    if (this.joyDest === id) v += this.joyOffset
    if (this.atDest === id) v += this.atOffset
    return clamp(v, m.min, m.max)
  }

  /**
   * Motion-lane value: like setParam but into the non-destructive override
   * layer. MOTION_PITCH_BEND (-1..1) drives the bend multiplier.
   * MOTION_GATE_TIME never arrives here (the sequencer consumes gate-time
   * lanes itself as per-step gate overrides); the guard is kept for safety.
   */
  applyMotion(paramId: number, v: number): void {
    if (!Number.isFinite(v)) return
    if (paramId === MOTION_PITCH_BEND) {
      this.motionBendOn = true
      this.motionBend = clamp(v, -1, 1)
      this.refreshBend()
      return
    }
    if (paramId === MOTION_GATE_TIME) return // consumed by the sequencer
    if (!PARAMS[paramId]) return
    this.motionHas[paramId] = 1
    this.motionVal[paramId] = v
    this.applyParam(paramId)
  }

  private clearMotionOverrides(): void {
    if (this.motionBendOn) {
      this.motionBendOn = false
      this.refreshBend()
    }
    for (let id = 0; id < PARAM_COUNT; id++) {
      if (this.motionHas[id]) {
        this.motionHas[id] = 0
        this.applyParam(id)
      }
    }
  }

  /* ----------------------------------------------------------- joystick -- */

  /** Joystick X / pitch bend, -1..1 (BEND_RANGE_PLUS/MINUS semitones). */
  setBend(v: number): void {
    if (!Number.isFinite(v)) return
    this.bendX = clamp(v, -1, 1)
    this.refreshBend()
  }

  /** Joystick Y, -1..1; offsets the assigned destination (block-rate). */
  setJoyY(v: number): void {
    if (!Number.isFinite(v)) return
    this.joyY = clamp(v, -1, 1)
    this.joyDirty = true
  }

  /** Channel aftertouch, 0..1; offsets the MIDI_AT_ASSIGN destination
   *  (block-rate, unipolar: +100% of the param's span at full pressure). */
  setPressure(v: number): void {
    if (!Number.isFinite(v)) return
    this.pressure = clamp(v, 0, 1)
    this.pressureDirty = true
  }

  private refreshBend(): void {
    const v = this.motionBendOn ? this.motionBend : this.bendX
    const range = v >= 0 ? this.params[P.BEND_RANGE_PLUS] : this.params[P.BEND_RANGE_MINUS]
    const mult = Math.pow(2, (v * range) / 12) // range 0 = Off
    for (let i = 0; i < NV; i++) this.voices[i].setBendMult(mult)
  }

  private applyJoy(): void {
    this.joyDirty = false
    const v = this.joyY
    let dest = -1
    let offset = 0
    let gateOffset = 0
    if (v > 1e-3 || v < -1e-3) {
      const idx = Math.round(this.params[v > 0 ? P.JOY_ASSIGN_PLUS : P.JOY_ASSIGN_MINUS])
      // Deflection magnitude only: the signed range alone sets the direction
      // (Y- deflections are negative; multiplying by them would flip it).
      const amt = Math.abs(v)
      const rangePct = (this.params[v > 0 ? P.JOY_RANGE_PLUS : P.JOY_RANGE_MINUS] - 100) / 100
      if (JOY_DEST_IDS[idx] === -1) {
        // GATE TIME: offsets the sequencer's step gates (raw units 0..72).
        gateOffset = amt * rangePct * 72
      } else {
        dest = this.joyDestParam(idx)
        if (dest >= 0) {
          const meta = PARAMS[dest]
          offset = amt * rangePct * (meta.max - meta.min)
        }
      }
    }
    this.joyGateOff = gateOffset
    this.seq.setGateTimeOffset(gateOffset + this.atGateOff)
    if (dest === this.joyDest && offset === this.joyOffset) return
    const prev = this.joyDest
    this.joyDest = dest
    this.joyOffset = offset
    if (prev >= 0 && prev !== dest) this.applyParam(prev)
    if (dest >= 0) this.applyParam(dest)
  }

  private applyPressure(): void {
    this.pressureDirty = false
    const v = this.pressure
    let dest = -1
    let offset = 0
    let gateOffset = 0
    if (v > 1e-3) {
      const idx = Math.round(this.params[P.MIDI_AT_ASSIGN])
      if (JOY_DEST_IDS[idx] === -1) {
        // GATE TIME: offsets the sequencer's step gates (raw units 0..72).
        gateOffset = v * 72
      } else {
        dest = this.joyDestParam(idx)
        if (dest >= 0) {
          const meta = PARAMS[dest]
          offset = v * (meta.max - meta.min)
        }
      }
    }
    this.atGateOff = gateOffset
    this.seq.setGateTimeOffset(this.joyGateOff + gateOffset)
    if (dest === this.atDest && offset === this.atOffset) return
    const prev = this.atDest
    this.atDest = dest
    this.atOffset = offset
    if (prev >= 0 && prev !== dest) this.applyParam(prev)
    if (dest >= 0) this.applyParam(dest)
  }

  private joyDestParam(destIndex: number): number {
    const id = JOY_DEST_IDS[destIndex]
    if (id === undefined || id === -1) return -1
    if (id === -2) {
      // MULTI SHAPE resolves to the active engine type's shape param.
      const t = Math.round(this.effectiveParam(P.MULTI_TYPE))
      return t === 0 ? P.SHAPE_NOISE : t === 1 ? P.SHAPE_VPM : P.SHAPE_USER
    }
    return id
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
      case P.SYNC:
        for (let i = 0; i < NV; i++) vs[i].setSync(e >= 0.5)
        break
      case P.RING:
        for (let i = 0; i < NV; i++) vs[i].setRing(e >= 0.5)
        break
      case P.CROSS_MOD:
        for (let i = 0; i < NV; i++) vs[i].setXmod(e / 1023)
        break
      case P.MULTI_TYPE: {
        const t = Math.round(e)
        for (let i = 0; i < NV; i++) vs[i].setMultiType(t)
        // Sub/shape/shift are stored per type: re-push the active set.
        this.refreshMultiSelect()
        this.joyDirty = true // MULTI SHAPE joystick/aftertouch dest may re-resolve
        this.pressureDirty = true
        break
      }
      case P.SELECT_NOISE:
      case P.SELECT_VPM:
      case P.SELECT_USER:
        this.refreshMultiSelect()
        break
      case P.MULTI_OCTAVE:
        for (let i = 0; i < NV; i++) vs[i].setMultiOctave(Math.pow(2, Math.round(e) - 1))
        break
      case P.SHAPE_NOISE:
      case P.SHAPE_VPM:
      case P.SHAPE_USER:
      case P.SHIFTSHAPE_NOISE:
      case P.SHIFTSHAPE_VPM:
      case P.SHIFTSHAPE_USER:
        this.refreshMultiShape()
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
      case P.MULTI_LEVEL: {
        const l = levelTo01(e)
        for (let i = 0; i < NV; i++) vs[i].setMultiLevel(l)
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
      case P.DRIVE:
        for (let i = 0; i < NV; i++) vs[i].setDrive(Math.round(e))
        break
      case P.KEYTRACK: {
        const k = KEYTRACK_AMOUNT[Math.round(e)] ?? 0
        for (let i = 0; i < NV; i++) vs[i].setKeytrack(k)
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
      case P.EG_DECAY: {
        const a = attackToSec(this.effectiveParam(P.EG_ATTACK))
        const d = decayToSec(this.effectiveParam(P.EG_DECAY))
        for (let i = 0; i < NV; i++) vs[i].setModEgTimes(a, d)
        break
      }
      case P.EG_INT: {
        const pct = egIntToPercent(e)
        for (let i = 0; i < NV; i++) vs[i].setEgInt(pct)
        break
      }
      case P.EG_TARGET:
        for (let i = 0; i < NV; i++) vs[i].setEgTarget(Math.round(e))
        break
      case P.LFO_WAVE:
        for (let i = 0; i < NV; i++) vs[i].setLfoWave(Math.round(e))
        break
      case P.LFO_MODE:
        for (let i = 0; i < NV; i++) vs[i].setLfoMode(Math.round(e))
        this.refreshLfoFreq()
        break
      case P.LFO_RATE:
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
      case P.MODFX_ON:
        this.modfx.setOn(e >= 0.5)
        break
      case P.MODFX_TYPE:
      case P.MODFX_SUB_CHORUS:
      case P.MODFX_SUB_ENSEMBLE:
      case P.MODFX_SUB_PHASER:
      case P.MODFX_SUB_FLANGER:
      case P.MODFX_SUB_USER: {
        const t = Math.round(this.effectiveParam(P.MODFX_TYPE))
        const subParam = MODFX_SUB_PARAM[t] ?? P.MODFX_SUB_CHORUS
        this.modfx.setType(t, Math.round(this.effectiveParam(subParam)))
        break
      }
      case P.MODFX_TIME:
        this.modfx.setTime(e / 1023)
        break
      case P.MODFX_DEPTH:
        this.modfx.setDepth(e / 1023)
        break
      case P.DELAY_ON:
        this.delay.setOn(e >= 0.5)
        break
      case P.DELAY_SUB:
        this.delay.setSubType(Math.round(e))
        break
      case P.DELAY_TIME:
        this.delay.setTime(e / 1023)
        break
      case P.DELAY_DEPTH:
        this.delay.setDepth(e / 1023)
        break
      case P.DELAY_DRYWET:
        this.delay.setDryWet(e / 1024)
        break
      case P.REVERB_ON:
        this.reverb.setOn(e >= 0.5)
        break
      case P.REVERB_SUB:
        this.reverb.setSubType(Math.round(e))
        break
      case P.REVERB_TIME:
        this.reverb.setTime(e / 1023)
        break
      case P.REVERB_DEPTH:
        this.reverb.setDepth(e / 1023)
        break
      case P.REVERB_DRYWET:
        this.reverb.setDryWet(e / 1024)
        break
      case P.VOICE_MODE: {
        const m = Math.round(e)
        if (m !== this.curMode) {
          this.curMode = m
          this.releaseAllVoices()
          this.stackCount = 0
          this.curMonoNote = -1
          this.monoSustained.fill(0)
        }
        this.syncArp()
        break
      }
      case P.VM_DEPTH: {
        // Live knob: unison detune spread / duo stack level+detune.
        if (this.curMode === VM_UNISON) {
          const det = unisonDetuneCents(e)
          for (let i = 0; i < NV; i++) {
            if (vs[i].active) vs[i].setDetuneCents(UNI_OFF[i] * det)
          }
        } else if (this.curMode === VM_POLY) {
          const pd = polyDuo(e)
          if (pd.duo) {
            for (let i = 0; i < NV; i++) {
              if (this.vStacked[i] && vs[i].active) {
                vs[i].setDetuneCents(pd.amount * DUO_DETUNE_CENTS)
                vs[i].setVoiceGain(pd.amount)
              }
            }
          }
        }
        this.syncArp()
        break
      }
      case P.ARP_LATCH:
      case P.ARP_RATE:
      case P.ARP_GATE:
        this.syncArp()
        break
      case P.OCTAVE:
        // Master OCTAVE transposes the UI keyboard itself (keyboard.ts emits
        // shifted notes); nothing to do engine-side.
        break
      case P.PORTAMENTO:
      case P.PORTAMENTO_BPM:
        this.refreshGlide()
        break
      case P.PORTAMENTO_MODE:
        break // read at noteOn time
      case P.PROGRAM_LEVEL:
        this.gainT = dbToGain(programLevelToDb(e))
        break
      case P.PROGRAM_TUNING:
      case P.PROGRAM_TRANSPOSE:
      case P.MICRO_TUNING:
      case P.SCALE_KEY:
        this.retuneSounding()
        break
      case P.BEND_RANGE_PLUS:
      case P.BEND_RANGE_MINUS:
        this.refreshBend()
        break
      case P.JOY_ASSIGN_PLUS:
      case P.JOY_RANGE_PLUS:
      case P.JOY_ASSIGN_MINUS:
      case P.JOY_RANGE_MINUS:
        this.joyDirty = true
        break
      case P.MIDI_AT_ASSIGN:
        this.pressureDirty = true
        break
      case P.LFO_KEY_SYNC:
        for (let i = 0; i < NV; i++) vs[i].setLfoKeySync(e >= 0.5)
        break
      case P.LFO_VOICE_SYNC:
        break // read at noteOn time
      case P.LFO_TARGET_OSC:
        for (let i = 0; i < NV; i++) vs[i].setLfoTargetOsc(Math.round(e))
        break
      case P.EG_VELOCITY:
        for (let i = 0; i < NV; i++) vs[i].setEgVelocity(e)
        break
      case P.AMP_VELOCITY:
        for (let i = 0; i < NV; i++) vs[i].setAmpVelocity(e)
        break
      case P.EG_LEGATO:
        break // read at noteOn time
      case P.MULTI_ROUTING:
        for (let i = 0; i < NV; i++) vs[i].setMultiRoutingPost(Math.round(e) === 1)
        break
      case P.VPM_FEEDBACK:
      case P.VPM_NOISE_DEPTH:
      case P.VPM_SHAPE_MOD_INT:
      case P.VPM_MOD_ATTACK:
      case P.VPM_MOD_DECAY:
      case P.VPM_KEY_TRACK:
        this.refreshVpmTrims()
        break
      default:
        break
    }
  }

  private refreshMultiSelect(): void {
    const t = Math.round(this.effectiveParam(P.MULTI_TYPE))
    const selParam = t === 0 ? P.SELECT_NOISE : t === 1 ? P.SELECT_VPM : P.SELECT_USER
    const sub = Math.round(this.effectiveParam(selParam))
    for (let i = 0; i < NV; i++) this.voices[i].setMultiSub(sub)
    this.refreshMultiShape()
  }

  private refreshMultiShape(): void {
    const t = Math.round(this.effectiveParam(P.MULTI_TYPE))
    const shapeParam = t === 0 ? P.SHAPE_NOISE : t === 1 ? P.SHAPE_VPM : P.SHAPE_USER
    const shiftParam = t === 0 ? P.SHIFTSHAPE_NOISE : t === 1 ? P.SHIFTSHAPE_VPM : P.SHIFTSHAPE_USER
    const sh = this.effectiveParam(shapeParam) / 1023
    const ss = this.effectiveParam(shiftParam) / 1023
    for (let i = 0; i < NV; i++) {
      this.voices[i].setMultiShape(sh)
      this.voices[i].setMultiShiftShape(ss)
    }
  }

  /**
   * VPM menu trims (spec §5.2): raw 0..200 (100 = 0%) -> -1..+1, batched into
   * one object and pushed to every voice's MultiEngine. The MultiEngine
   * stores them, so later type/subtype switches keep the trims; loadProgram
   * re-pushes via applyAllParams -> applyParam.
   */
  private refreshVpmTrims(): void {
    const t = {
      feedback: (this.effectiveParam(P.VPM_FEEDBACK) - 100) / 100,
      noiseDepth: (this.effectiveParam(P.VPM_NOISE_DEPTH) - 100) / 100,
      shapeModInt: (this.effectiveParam(P.VPM_SHAPE_MOD_INT) - 100) / 100,
      modAttack: (this.effectiveParam(P.VPM_MOD_ATTACK) - 100) / 100,
      modDecay: (this.effectiveParam(P.VPM_MOD_DECAY) - 100) / 100,
      keyTrack: (this.effectiveParam(P.VPM_KEY_TRACK) - 100) / 100,
    }
    for (let i = 0; i < NV; i++) this.voices[i].setVpmTrims(t)
  }

  private refreshLfoFreq(): void {
    const mode = Math.round(this.effectiveParam(P.LFO_MODE))
    const raw = this.effectiveParam(P.LFO_RATE)
    const hz = mode === 2 ? lfoBpmToHz(raw, this.bpm) : lfoRateToHz(raw)
    for (let i = 0; i < NV; i++) this.voices[i].setLfoFreq(hz)
  }

  private refreshGlide(): void {
    let sec = portamentoToSec(this.effectiveParam(P.PORTAMENTO))
    if (sec > 0 && this.params[P.PORTAMENTO_BPM] >= 0.5) {
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
    for (let i = 0; i < NV; i++) this.voices[i].setGlideTime(sec)
  }

  private syncArp(): void {
    this.seq.setArp({
      enabled: this.curMode === VM_ARP,
      typeIndex: arpTypeIndex(this.effectiveParam(P.VM_DEPTH)),
      latch: this.params[P.ARP_LATCH] >= 0.5,
      rateIndex: Math.round(this.effectiveParam(P.ARP_RATE)),
      gate01: this.effectiveParam(P.ARP_GATE) / 72,
      swing: this.swing,
    })
  }

  /* --------------------------------------------------- pitch / tuning ---- */

  /** Reverse / pentatonic keyboard remapping (spec §12 microtuning). */
  private effectiveNote(note: number): number {
    const mt = Math.round(this.params[P.MICRO_TUNING])
    if (mt === MT_REVERSE) return 120 - note
    if (mt === MT_MAJOR_PENTA || mt === MT_MINOR_PENTA) {
      const set = mt === MT_MAJOR_PENTA ? PENTA_MAJOR : PENTA_MINOR
      const key = Math.round(this.params[P.SCALE_KEY]) - 12
      const rel = note - key
      const oct = Math.floor(rel / 12)
      const pc = rel - oct * 12
      let snapped = 0
      for (let i = 0; i < set.length; i++) if (set[i] <= pc) snapped = set[i]
      return key + oct * 12 + snapped
    }
    return note
  }

  /** note -> Hz with transpose, program tuning and microtuning applied.
   *  Side effect: this.calcSemis = final semitone (for filter keytrack). */
  private noteHz(note: number): number {
    const n0 = this.effectiveNote(note)
    const n = n0 + (Math.round(this.params[P.PROGRAM_TRANSPOSE]) - 12)
    const cents =
      (this.params[P.PROGRAM_TUNING] - 50) +
      microTuneCents(Math.round(this.params[P.MICRO_TUNING]), n0, Math.round(this.params[P.SCALE_KEY]) - 12)
    this.calcSemis = n
    return 440 * Math.pow(2, (n - 69) / 12 + cents / 1200)
  }

  private retuneSounding(): void {
    for (let i = 0; i < NV; i++) {
      if (this.voices[i].active && this.vKey[i] >= 0) {
        const hz = this.noteHz(this.vNote[i])
        this.voices[i].setPitch(this.calcSemis, hz, false)
      }
    }
  }

  /* ---------------------------------------------------------- notes ------ */

  noteOn(note: number, vel: number): void {
    if (!Number.isFinite(note) || !Number.isFinite(vel)) return
    const n = Math.max(0, Math.min(127, Math.round(note)))
    const v = Math.max(1, Math.min(127, Math.round(vel)))
    this.physHeld[n] = 1
    if (this.curMode === VM_ARP) {
      this.seq.arpKeyDown(n, v)
      return
    }
    this.noteOnInternal(n, v, false)
  }

  noteOff(note: number): void {
    if (!Number.isFinite(note)) return
    const n = Math.max(0, Math.min(127, Math.round(note)))
    this.physHeld[n] = 0
    // Always release the arp key buffer: a key registered in ARP mode may be
    // let go after a voice-mode switch and would otherwise linger forever.
    this.seq.arpKeyUp(n)
    if (this.curMode === VM_ARP) return
    this.noteOffInternal(n, false)
  }

  allNotesOff(): void {
    for (let i = 0; i < NV; i++) {
      this.pendFlag[i] = 0
      this.vSustained[i] = 0
      if (this.voices[i].active && !this.vReleased[i]) this.gateOffVoice(i)
    }
    this.stackCount = 0
    this.curMonoNote = -1
    this.monoSustained.fill(0)
    for (let n = 0; n < 128; n++) {
      if (this.physHeld[n]) {
        this.physHeld[n] = 0
        this.seq.arpKeyUp(n)
      }
    }
    // Drop latched arp keys: momentary latch-off flush, then restore config.
    this.seq.setArp({
      enabled: false,
      typeIndex: 0,
      latch: false,
      rateIndex: 4,
      gate01: 0.75,
      swing: this.swing,
    })
    this.syncArp()
  }

  sustain(on: boolean): void {
    this.sustainOn = on === true
    if (!this.sustainOn) {
      // Mono modes: flush key releases deferred while the damper was down.
      // The current note goes last so the legato fall-back never retriggers
      // a note that is itself being released.
      let cur = -1
      for (let n = 0; n < 128; n++) {
        if (this.monoSustained[n]) {
          this.monoSustained[n] = 0
          if (this.physHeld[n]) continue
          if (n === this.curMonoNote) cur = n
          else this.noteOffInternal(n, false)
        }
      }
      if (cur >= 0) this.noteOffInternal(cur, false)
      for (let i = 0; i < NV; i++) {
        if (this.vSustained[i]) {
          this.vSustained[i] = 0
          if (!this.stackContains(this.vKey[i])) this.gateOffVoice(i)
        }
      }
    }
  }

  /** Sequencer / arpeggiator hook notes re-enter the allocator here. */
  private hookNoteOn(note: number, vel: number): void {
    const n = Math.max(0, Math.min(127, Math.round(note)))
    const v = Math.max(1, Math.min(127, Math.round(vel)))
    this.noteOnInternal(n, v, this.curMode === VM_ARP)
  }

  private hookNoteOff(note: number): void {
    const n = Math.max(0, Math.min(127, Math.round(note)))
    this.noteOffInternal(n, this.curMode === VM_ARP)
  }

  private noteOnInternal(note: number, vel: number, forcePoly: boolean): void {
    if (this.monoSustained[note]) {
      // Re-press of a pedal-sustained key: drop the stale stack entry first.
      this.monoSustained[note] = 0
      this.stackRemove(note)
    }
    const legato = this.stackCount > 0
    this.stackPush(note, vel)
    const mode = forcePoly ? VM_POLY : this.curMode
    if (mode === VM_UNISON || mode === VM_CHORD) {
      this.monoStart(note, vel, legato)
      return
    }
    // POLY (or DUO zone of POLY).
    const pd = polyDuo(this.effectiveParam(P.VM_DEPTH))
    if (mode === VM_POLY && !forcePoly && pd.duo) this.duoNoteOn(note, vel, legato, pd.amount)
    else this.polyNoteOn(note, vel, legato)
  }

  private noteOffInternal(note: number, forcePoly: boolean): void {
    const mode = forcePoly ? VM_POLY : this.curMode
    if (mode === VM_UNISON || mode === VM_CHORD) {
      if (this.sustainOn) {
        // Damper down: defer the release entirely (CC64 semantics) — the key
        // stays on the stack so the pitch does not fall back mid-pedal.
        this.monoSustained[note] = 1
        return
      }
      this.stackRemove(note)
      if (this.stackCount === 0) {
        this.releaseAllVoices()
        this.curMonoNote = -1
      } else if (note === this.curMonoNote) {
        // Return to the previous held note (legato).
        const top = this.stackCount - 1
        this.monoStart(this.stackNote[top], this.stackVel[top], true)
      }
      return
    }
    this.stackRemove(note)
    for (let i = 0; i < NV; i++) {
      if (this.vKey[i] === note && !this.vReleased[i]) {
        if (this.pendFlag[i]) {
          this.pendFlag[i] = 0 // key released before the stolen restart fired
          this.vKey[i] = -1
        } else if (this.sustainOn) {
          this.vSustained[i] = 1
        } else if (this.voices[i].active) {
          this.gateOffVoice(i)
        }
      }
    }
  }

  /** UNISON / CHORD mono start (last-note priority, EG legato rules). */
  private monoStart(note: number, vel: number, legato: boolean): void {
    const retrig = !(this.params[P.EG_LEGATO] >= 0.5 && legato)
    const glide = this.glideFor(legato)
    this.curMonoNote = note
    if (this.curMode === VM_UNISON) {
      const det = unisonDetuneCents(this.effectiveParam(P.VM_DEPTH))
      for (let i = 0; i < NV; i++) {
        this.startVoice(i, note, note, vel, retrig, glide, UNI_OFF[i] * det, 1, false)
      }
    } else {
      const chord = CHORDS[chordIndex(this.effectiveParam(P.VM_DEPTH))]
      const tones = Math.min(chord.notes.length, NV)
      // Rotate the chord's voice set on each fresh strike (family behavior:
      // voices cycle even in mono-style modes, letting tails ring); a legato
      // transition re-pitches the SAME voices so glide/EGs stay continuous.
      const reuse = !retrig && this.chordTones === tones && this.chordMap[0] >= 0
      if (!reuse) {
        for (let t = 0; t < tones; t++) this.chordMap[t] = (this.rotor + t) % NV
        for (let t = tones; t < NV; t++) this.chordMap[t] = -1
        this.rotor = (this.rotor + tones) % NV
        this.chordTones = tones
      }
      for (let t = 0; t < tones; t++) {
        this.startVoice(this.chordMap[t], note, note + chord.notes[t], vel, retrig, glide, 0, 1, false)
      }
      for (let i = 0; i < NV; i++) {
        let used = false
        for (let t = 0; t < tones; t++) if (this.chordMap[t] === i) used = true
        if (!used && this.voices[i].active && !this.vReleased[i]) this.gateOffVoice(i)
      }
    }
  }

  private polyNoteOn(note: number, vel: number, legato: boolean): void {
    const glide = this.glideFor(legato)
    const i = this.allocVoice()
    if (i >= 0) {
      this.startVoice(i, note, note, vel, true, glide, 0, 1, false)
      return
    }
    // Steal the oldest: kill now, restart at the next block.
    const s = this.oldestVoice()
    this.stealVoice(s, note, note, vel, glide, 0, 1, false)
  }

  private duoNoteOn(note: number, vel: number, legato: boolean, amount: number): void {
    const glide = this.glideFor(legato)
    const det = amount * DUO_DETUNE_CENTS
    // Pairs (0,1) and (2,3): main + stacked voice; rotate between the pairs
    // like the hardware rotates voices.
    let pair = -1
    for (let q = 0; q < 2; q++) {
      const p = (this.pairRotor + q) % 2
      const a = p * 2
      if (!this.voices[a].active && !this.voices[a + 1].active && !this.pendFlag[a] && !this.pendFlag[a + 1]) {
        pair = p
        this.pairRotor = (p + 1) % 2
        break
      }
    }
    if (pair < 0) {
      // Prefer a fully-released pair, else steal the oldest pair.
      let bestGen = Infinity
      let released = -1
      let relGen = Infinity
      for (let p = 0; p < 2; p++) {
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
          pair = p
        }
      }
      if (released >= 0) {
        const a = released * 2
        this.startVoice(a, note, note, vel, true, glide, 0, 1, false)
        this.startVoice(a + 1, note, note, vel, true, glide, det, amount, true)
        return
      }
      const a = pair * 2
      this.stealVoice(a, note, note, vel, glide, 0, 1, false)
      this.stealVoice(a + 1, note, note, vel, glide, det, amount, true)
      return
    }
    const a = pair * 2
    this.startVoice(a, note, note, vel, true, glide, 0, 1, false)
    this.startVoice(a + 1, note, note, vel, true, glide, det, amount, true)
  }

  /** Idle voice, else oldest gate-released voice; -1 = must steal. */
  private allocVoice(): number {
    // Round-robin like the hardware: scan idle voices starting after the
    // last allocation, so repeated presses cycle 1-2-3-4 and each previous
    // press's release tail keeps ringing on its own voice.
    for (let j = 0; j < NV; j++) {
      const i = (this.rotor + j) % NV
      if (!this.voices[i].active && !this.pendFlag[i]) {
        this.rotor = (i + 1) % NV
        return i
      }
    }
    let best = -1
    let bestGen = Infinity
    for (let i = 0; i < NV; i++) {
      if (this.vReleased[i] && !this.pendFlag[i] && this.vGen[i] < bestGen) {
        bestGen = this.vGen[i]
        best = i
      }
    }
    if (best >= 0) this.rotor = (best + 1) % NV
    return best
  }

  private oldestVoice(): number {
    let best = 0
    let bestGen = Infinity
    for (let i = 0; i < NV; i++) {
      if (this.vGen[i] < bestGen) {
        bestGen = this.vGen[i]
        best = i
      }
    }
    return best
  }

  private stealVoice(
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

  private startVoice(
    i: number, key: number, soundNote: number, vel: number,
    retrig: boolean, glide: boolean, det: number, gain: number, stacked: boolean,
  ): void {
    const v = this.voices[i]
    this.dbgVoice = i
    const hz = this.noteHz(soundNote)
    const semis = this.calcSemis
    v.setDetuneCents(det)
    v.setVoiceGain(gain)
    if (glide && !v.active && this.lastStartHz > 0) v.setGlideStart(this.lastStartHz)
    // LFO voice sync: copy phase from the lowest-indexed active voice.
    let syncP = -1
    if (this.params[P.LFO_VOICE_SYNC] >= 0.5) {
      for (let k = 0; k < NV; k++) {
        if (k !== i && this.voices[k].active) {
          syncP = this.voices[k].lfoPhase
          break
        }
      }
    }
    v.noteOn(semis, hz, vel, retrig, glide)
    if (syncP >= 0) v.setLfoPhase(syncP)
    this.vKey[i] = key
    this.vNote[i] = soundNote
    this.vGen[i] = ++this.gen
    this.vReleased[i] = 0
    this.vSustained[i] = 0
    this.vStacked[i] = stacked ? 1 : 0
    this.pendFlag[i] = 0
    this.lastStartHz = hz
  }

  private gateOffVoice(i: number): void {
    this.voices[i].noteOff()
    this.vReleased[i] = 1
  }

  private releaseAllVoices(): void {
    for (let i = 0; i < NV; i++) {
      this.pendFlag[i] = 0
      if (this.voices[i].active && !this.vReleased[i]) {
        if (this.sustainOn) this.vSustained[i] = 1
        else this.gateOffVoice(i)
      }
    }
  }

  private glideFor(legato: boolean): boolean {
    if (this.glideSec <= 0) return false
    // Portamento Mode: Auto = only when played legato, On = always.
    return this.params[P.PORTAMENTO_MODE] >= 0.5 || legato
  }

  /* ------------------------------------------------------- note stack ---- */

  private stackPush(note: number, vel: number): void {
    if (this.stackCount >= STACK_CAP) {
      for (let k = 1; k < STACK_CAP; k++) {
        this.stackNote[k - 1] = this.stackNote[k]
        this.stackVel[k - 1] = this.stackVel[k]
      }
      this.stackCount = STACK_CAP - 1
    }
    this.stackNote[this.stackCount] = note
    this.stackVel[this.stackCount] = vel
    this.stackCount++
  }

  private stackRemove(note: number): void {
    for (let k = this.stackCount - 1; k >= 0; k--) {
      if (this.stackNote[k] === note) {
        for (let j = k + 1; j < this.stackCount; j++) {
          this.stackNote[j - 1] = this.stackNote[j]
          this.stackVel[j - 1] = this.stackVel[j]
        }
        this.stackCount--
        return
      }
    }
  }

  private stackContains(note: number): boolean {
    for (let k = 0; k < this.stackCount; k++) if (this.stackNote[k] === note) return true
    return false
  }

  /* -------------------------------------------------- transport / data --- */

  setPlaying(on: boolean): void {
    this.seq.setPlaying(on === true)
    if (!on) this.clearMotionOverrides()
  }

  setSeqData(seq: SeqData): void {
    this.seq.setSeq(seq)
    this.updateTiming(seq.bpm, seq.swing)
    this.releaseStaleMotion(seq)
  }

  /**
   * Lane edits mid-play: drop motion overrides whose lane was disabled,
   * cleared or re-assigned so the panel knob regains control immediately
   * (otherwise the stale override would pin the param until STOP).
   */
  private releaseStaleMotion(seq: SeqData): void {
    const lanes = seq.motion ?? []
    for (let id = 0; id < PARAM_COUNT; id++) {
      if (!this.motionHas[id]) continue
      let live = false
      for (const l of lanes) {
        if (l && l.on === true && Math.round(l.paramId) === id) {
          live = true
          break
        }
      }
      if (!live) {
        this.motionHas[id] = 0
        this.applyParam(id)
      }
    }
    if (this.motionBendOn) {
      let live = false
      for (const l of lanes) {
        if (l && l.on === true && Math.round(l.paramId) === MOTION_PITCH_BEND) {
          live = true
          break
        }
      }
      if (!live) {
        this.motionBendOn = false
        this.refreshBend()
      }
    }
  }

  loadProgram(p: Program): void {
    this.allNotesOff()
    this.motionHas.fill(0)
    this.motionBendOn = false
    this.joyDest = -1
    this.joyOffset = 0
    this.joyY = 0
    this.joyDirty = false
    this.joyGateOff = 0
    this.atDest = -1
    this.atOffset = 0
    this.pressure = 0
    this.pressureDirty = false
    this.atGateOff = 0
    this.seq.setGateTimeOffset(0)
    for (const meta of PARAMS) {
      const v = p.params[meta.id]
      this.params[meta.id] = clamp(Number.isFinite(v) ? v : meta.def, meta.min, meta.max)
    }
    this.curMode = Math.round(this.params[P.VOICE_MODE])
    this.seq.setSeq(p.seq)
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
    this.delay.setBpm(b)
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

    if (this.joyDirty) this.applyJoy()
    if (this.pressureDirty) this.applyPressure()

    // Stolen-voice restarts: fire only once the ~1.5 ms kill ramp has fully
    // faded the old note (live steals arrive between blocks, before the ramp
    // has run — restarting immediately would skip the fade and click).
    for (let i = 0; i < NV; i++) {
      if (this.pendFlag[i] && !this.voices[i].active) {
        this.startVoice(
          i, this.pendKey[i], this.pendNote[i], this.pendVel[i], true,
          this.pendGlide[i] === 1, this.pendDet[i], this.pendGain[i], this.pendStk[i] === 1,
        )
      }
    }

    // Sequencer first: its hooks fire noteOn/noteOff/motion into the engine.
    this.seq.process(frames)

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
      if (this.dbgOn) {
        const tv = vs[this.dbgVoice]
        const w = this.dbgW
        this.dbgRings[0][w] = tv.tapV1
        this.dbgRings[1][w] = tv.tapV2
        this.dbgRings[2][w] = tv.tapMix
        this.dbgRings[3][w] = tv.tapFilt
        this.dbgW = (w + 1) % DBG_TAP_SIZE
      }
    }

    this.modfx.process(outL, outR, frames)
    this.delay.process(outL, outR, frames)
    this.reverb.process(outL, outR, frames)

    // Final transparent safety limiter + peak metering.
    let peak = this.peak
    for (let s = 0; s < frames; s++) {
      let l = outL[s]
      let r = outR[s]
      if (!Number.isFinite(l)) l = 0
      if (!Number.isFinite(r)) r = 0
      l = softLimit(l)
      r = softLimit(r)
      outL[s] = l
      outR[s] = r
      const a = l > -l ? l : -l
      const b = r > -r ? r : -r
      const m = a > b ? a : b
      if (m > peak) peak = m
    }
    this.peak = peak
  }

  /* -------------------------------------------------------- telemetry ---- */

  /** Enable/disable SERVICE MODE taps (all voices record their stages). */
  setDebug(on: boolean): void {
    this.dbgOn = on
    for (let i = 0; i < NV; i++) this.voices[i].tapOn = on
  }

  get debugOn(): boolean {
    return this.dbgOn
  }

  get debugVoice(): number {
    return this.dbgVoice
  }

  /** Copy the four tap rings (chronological order) into dst[0..3]. */
  copyDebugTaps(dst: Float32Array[]): void {
    const w = this.dbgW
    const tail = DBG_TAP_SIZE - w
    for (let t = 0; t < 4; t++) {
      const ring = this.dbgRings[t]
      const d = dst[t]
      d.set(ring.subarray(w), 0)
      d.set(ring.subarray(0, w), tail)
    }
  }

  /** Per-voice state for the debug panel's voice lanes. */
  debugVoiceInfo(i: number): { note: number; on: boolean; amp: number; drift1: number; drift2: number } {
    const v = this.voices[i]
    return { note: v.note, on: v.active, amp: v.lastAmp, drift1: v.lastDrift1, drift2: v.lastDrift2 }
  }

  /** Post-FX peak since the last call (meter); resets on read. */
  takePeak(): number {
    const p = this.peak
    this.peak = 0
    return p
  }

  activeVoiceCount(): number {
    let c = 0
    for (let i = 0; i < NV; i++) if (this.voices[i].active) c++
    return c
  }

  /** Gated (non-released) note keys, deduped, for key/LED feedback. */
  collectActiveNotes(dst: number[]): number {
    dst.length = 0
    for (let i = 0; i < NV; i++) {
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
