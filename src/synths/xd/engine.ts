/*
 * Engine — the minilogue xd replica's synth core (worklet-side, DOM-free).
 *
 * The family-shared machinery (param store + layered parameter model, note
 * skeleton, transport, process() skeleton, SERVICE MODE plumbing) lives in
 * dsp/enginebase.ts; this file is the xd binding: the applyParam switch, the
 * FX chain (MOD FX -> DELAY -> REVERB, spec §1), tuning/transpose, the
 * joystick-Y + aftertouch offset layers and the xd voice modes.
 *
 * Layered parameter model (all mapping through shared/maps.ts):
 *   effective raw = (motion override ?? knob raw) + joystick-Y offset
 * Raw -> physical mapping happens ONCE per change here (push model); voices
 * only ever receive physical units. Motion overrides clear when the
 * sequencer transport stops; the joystick and aftertouch offset layers are
 * non-destructive and recomputed at block rate.
 *
 * Voice modes (spec §3): POLY (+DUO zone), UNISON, CHORD, ARP. In ARP mode
 * live keys are fed to the arpeggiator and its hook noteOns come back into
 * the poly allocator.
 */
import { P, PARAMS, MOTION_META } from './params'
import { clamp, dbToGain } from '../../shared/maps'
import {
  vcoPitchCents,
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
  portamentoToSec,
  polyDuo,
  unisonDetuneCents,
  CHORDS,
  chordIndex,
  arpTypeIndex,
  ARP_RATES,
  microTuneCents,
} from './curves'
import {
  EngineBase,
  DBG_TAP_SIZE,
  UNI_OFF,
  type EngineBaseConfig,
  type OffsetLayer,
  type OffsetResolution,
} from '../../dsp/enginebase'
import type { Arp } from '../../dsp/arp'
import { setXdProfile } from './profiles'
import { Voice } from './voice'
import { ModFx } from '../../dsp/fx/modfx'
import { DelayFx } from '../../dsp/fx/delay'
import { ReverbFx } from '../../dsp/fx/reverb'

const NV = 4
export { DBG_TAP_SIZE }

/** Voice modes (params.ts order). */
const VM_ARP = 0
const VM_CHORD = 1
const VM_UNISON = 2
const VM_POLY = 3

/** DUO: stacked-voice detune at amount = 1, in cents. */
const DUO_DETUNE_CENTS = 30

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

/** Family-shared engine wiring (dsp/enginebase.ts), bound to the xd tables. */
const BASE_CFG: EngineBaseConfig<Voice> = {
  params: PARAMS,
  motionMeta: MOTION_META,
  numVoices: NV,
  createVoice: (sr, i) => new Voice(sr, i),
  ids: {
    voiceMode: P.VOICE_MODE,
    bendRangePlus: P.BEND_RANGE_PLUS,
    bendRangeMinus: P.BEND_RANGE_MINUS,
    portamento: P.PORTAMENTO,
    portamentoBpm: P.PORTAMENTO_BPM,
    portamentoMode: P.PORTAMENTO_MODE,
  },
  portamentoToSec,
  arp: { voiceMode: VM_ARP },
}

export class Engine extends EngineBase<Voice> {
  /** The xd always has an arpeggiator (BASE_CFG.arp). */
  declare readonly arp: Arp

  // Joystick-Y + channel-aftertouch offset layers (enginebase machinery;
  // the aftertouch layer reuses the joystick destination table).
  private readonly joyLayer: OffsetLayer
  private readonly atLayer: OffsetLayer

  private calcSemis = 60 // scratch: semitone of the last noteHz() call

  // FX chain in processing order (spec §1: MOD FX -> DELAY -> REVERB).
  private readonly modfx: ModFx
  private readonly delay: DelayFx
  private readonly reverb: ReverbFx
  private readonly fxChain: ReadonlyArray<{ process(l: Float32Array, r: Float32Array, n: number): void }>

  constructor(sampleRate: number) {
    super(sampleRate, BASE_CFG)
    this.modfx = new ModFx(this.sr)
    this.delay = new DelayFx(this.sr)
    this.reverb = new ReverbFx(this.sr)
    this.fxChain = [this.modfx, this.delay, this.reverb]
    this.joyLayer = this.addOffsetLayer((v, out) => this.resolveJoy(v, out))
    this.atLayer = this.addOffsetLayer((v, out) => this.resolvePressure(v, out))
    this.delay.setBpm(this.bpm)
    this.finishInit()
  }

  /* ------------------------------------------------- calibration profile -- */

  /**
   * Switch the worklet realm's calibration profile (profiles.ts) and re-derive
   * every cached physical value from the current raw params. Voice-level
   * scalars (mod depths, SQR PW floor) read the profile live and need no push.
   */
  setCalibProfile(id: string): void {
    if (setXdProfile(id)) this.applyAllParams()
  }

  /* ----------------------------------------------------------- joystick -- */

  /** Joystick Y, -1..1; offsets the assigned destination (block-rate). */
  setJoyY(v: number): void {
    if (!Number.isFinite(v)) return
    this.joyLayer.value = clamp(v, -1, 1)
    this.joyLayer.dirty = true
  }

  /** Channel aftertouch, 0..1; offsets the MIDI_AT_ASSIGN destination
   *  (block-rate, unipolar: +100% of the param's span at full pressure). */
  setPressure(v: number): void {
    if (!Number.isFinite(v)) return
    this.atLayer.value = clamp(v, 0, 1)
    this.atLayer.dirty = true
  }

  private resolveJoy(v: number, out: OffsetResolution): void {
    const idx = Math.round(this.params[v > 0 ? P.JOY_ASSIGN_PLUS : P.JOY_ASSIGN_MINUS])
    // Deflection magnitude only: the signed range alone sets the direction
    // (Y- deflections are negative; multiplying by them would flip it).
    const amt = Math.abs(v)
    const rangePct = (this.params[v > 0 ? P.JOY_RANGE_PLUS : P.JOY_RANGE_MINUS] - 100) / 100
    if (JOY_DEST_IDS[idx] === -1) {
      // GATE TIME: offsets the sequencer's step gates (raw units 0..72).
      out.gateOffset = amt * rangePct * 72
      return
    }
    const dest = this.joyDestParam(idx)
    if (dest >= 0) {
      const meta = PARAMS[dest]
      out.dest = dest
      out.offset = amt * rangePct * (meta.max - meta.min)
    }
  }

  private resolvePressure(v: number, out: OffsetResolution): void {
    const idx = Math.round(this.params[P.MIDI_AT_ASSIGN])
    if (JOY_DEST_IDS[idx] === -1) {
      // GATE TIME: offsets the sequencer's step gates (raw units 0..72).
      out.gateOffset = v * 72
      return
    }
    const dest = this.joyDestParam(idx)
    if (dest >= 0) {
      const meta = PARAMS[dest]
      out.dest = dest
      out.offset = v * (meta.max - meta.min)
    }
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

  protected applyParam(id: number): void {
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
        const c = vcoPitchCents(e)
        for (let i = 0; i < NV; i++) vs[i].setVcoPitchCents(0, c)
        break
      }
      case P.VCO2_PITCH: {
        const c = vcoPitchCents(e)
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
        this.joyLayer.dirty = true // MULTI SHAPE joystick/aftertouch dest may re-resolve
        this.atLayer.dirty = true
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
      case P.VOICE_MODE:
        this.changeVoiceMode(Math.round(e))
        this.syncArp()
        break
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
              if (this.bank.isStacked(i) && vs[i].active) {
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
        this.joyLayer.dirty = true
        break
      case P.MIDI_AT_ASSIGN:
        this.atLayer.dirty = true
        break
      case P.LFO_KEY_SYNC:
        for (let i = 0; i < NV; i++) vs[i].setLfoKeySync(e >= 0.5)
        break
      case P.LFO_VOICE_SYNC:
        break // read at block rate (lfoVoiceSyncOn)
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

  protected override syncArp(): void {
    const rate = ARP_RATES[Math.round(this.effectiveParam(P.ARP_RATE))] ?? ARP_RATES[4]
    this.arp.setConfig({
      enabled: this.curMode === VM_ARP,
      typeIndex: arpTypeIndex(this.effectiveParam(P.VM_DEPTH)),
      latch: this.params[P.ARP_LATCH] >= 0.5,
      rateBeats: rate.beats,
      gate01: this.effectiveParam(P.ARP_GATE) / 72,
      swing: this.swing,
    })
  }

  protected override onTimingChanged(): void {
    this.delay.setBpm(this.bpm)
    this.refreshLfoFreq()
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
      if (this.voices[i].active && this.bank.keyOf(i) >= 0) {
        const hz = this.noteHz(this.bank.noteOf(i))
        this.voices[i].setPitch(this.calcSemis, hz, false)
      }
    }
  }

  /* ------------------------------------------------ mode implementations - */

  protected modeNoteOn(note: number, vel: number, legato: boolean, forcePoly: boolean): void {
    const mode = forcePoly ? VM_POLY : this.curMode
    if (mode === VM_UNISON || mode === VM_CHORD) {
      this.monoStart(note, vel, legato)
      return
    }
    // POLY (or DUO zone of POLY).
    const pd = polyDuo(this.effectiveParam(P.VM_DEPTH))
    if (mode === VM_POLY && !forcePoly && pd.duo) {
      this.duoStart(note, vel, legato, pd.amount * DUO_DETUNE_CENTS, pd.amount)
    } else {
      this.polyStart(note, note, vel, legato)
    }
  }

  protected modeNoteOff(note: number, forcePoly: boolean): void {
    const mode = forcePoly ? VM_POLY : this.curMode
    if (mode === VM_UNISON || mode === VM_CHORD) {
      this.monoNoteOff(note)
      return
    }
    this.stack.remove(note)
    this.bank.releaseKey(note, this.sustainOn)
  }

  /** UNISON / CHORD mono start (last-note priority, EG legato rules). */
  protected monoStart(note: number, vel: number, legato: boolean): void {
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
      this.chordStart(chord.notes, note, vel, retrig, glide)
    }
  }

  protected startVoice(
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
    v.noteOn(semis, hz, vel, retrig, glide)
    this.bank.started(i, key, soundNote, stacked)
    this.lastStartHz = hz
  }

  /* ------------------------------------------------------------ audio ---- */

  /** LFO Voice Sync (xd-spec §9). Skipped in 1-SHOT mode, where each
   *  voice's half-cycle freeze is the point. */
  protected override lfoVoiceSyncOn(): boolean {
    return this.params[P.LFO_VOICE_SYNC] >= 0.5 && Math.round(this.params[P.LFO_MODE]) !== 0
  }

  /** Serial FX chain; SERVICE MODE taps the signal between stages (the FX
   *  pairs are mod L/R, delay L/R — genuinely stereo from the mod fx on). */
  protected processFx(outL: Float32Array, outR: Float32Array, frames: number): void {
    for (let f = 0; f < this.fxChain.length; f++) {
      this.fxChain[f].process(outL, outR, frames)
      if (this.taps.on && f + 1 < this.fxChain.length) this.taps.writeFxTap(6 + 2 * f, outL, outR, frames, false)
    }
  }
}
