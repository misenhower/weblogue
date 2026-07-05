/*
 * Engine — the Korg prologue replica's synth core (worklet-side, DOM-free).
 * See docs/prologue-spec.md; UNCONFIRMED behaviors are marked and are
 * hardware-calibration targets (spec §17).
 *
 * The family-shared machinery (param store + layered parameter model, note
 * skeleton, transport, process() skeleton, SERVICE MODE plumbing) lives in
 * dsp/enginebase.ts; this file is the prologue binding — the family's first
 * BITIMBRAL engine:
 *
 *  - ONE shared voice pool (8 or 16 voices — the two hardware variants share
 *    this class via the numVoices constructor arg; the worklet always builds
 *    16 and the replica-only VOICE CAP param bounds allocation, spec §14)
 *    with a per-voice TIMBRE TAG (VoiceBank aux, 0=MAIN 1=SUB). SUB ON
 *    halves each timbre's budget (16->8+8, spec §1); steals cross timbres
 *    when the pool is exhausted (spec §15; policy UNCONFIRMED §17). A voice
 *    changing timbres gets that timbre's full param block re-pushed (retag).
 *  - TIMBRE TYPE dispatch (spec §2/§15): LAYER starts a note on both timbres
 *    (each under its OWN voice mode — main POLY + sub UNISON is legal),
 *    SPLIT routes by key vs SPLIT POINT (POSITION swaps sides), XFADE starts
 *    both with key-position gain weights (linear across the keybed,
 *    UNCONFIRMED §17). BALANCE scales the timbre gains globally.
 *  - Voice modes PER TIMBRE (spec §4): POLY (+DUO zone, xd semantics),
 *    MONO (the OG sub-voice model within the timbre's allocation), UNISON
 *    (all of the timbre's available voices, depth = detune), CHORD (family
 *    table). The per-timbre dispatch/allocation is this engine's own layer
 *    over the VoiceBank primitives (the base's single-mode helpers assume
 *    one whole-bank mode).
 *  - STEREO sum stage (sumVoices override, spec §13): per-voice timbre
 *    weight (BALANCE/XFADE) + VOICE SPREAD pan accumulate into engine-owned
 *    MAIN and SUB stereo bus pairs; processFx runs MOD FX and the exclusive
 *    DELAY-or-REVERB over routed submixes (ROUTING [Main+Sub, Main, Sub]),
 *    sums the buses and puts the L.F. COMP last (spec §7; app-level state on
 *    hardware — replica-only params, a documented deviation).
 *  - MOD WHEEL = one offset layer PER TIMBRE (each resolving its own
 *    M.WHEEL ASSIGN/RANGE; a single deflection drives both, spec §9);
 *    likewise two FW2 aftertouch layers. setJoyY carries the wheel 0..1.
 *  - Arpeggiator: PROGRAM-GLOBAL (spec §10), not a voice mode — ON/LATCH
 *    routes live keys to the arp (noteOn/noteOff overrides; the base's
 *    mode-equality gate is parked on a -1 sentinel), ARP TARGET routes fired
 *    notes to main/sub/both, TEMPO comes from seq.bpm. No step sequencer and
 *    no motion sequencing: the StepSeq stays constructed-but-dormant.
 */
import {
  P,
  RP,
  PARAMS,
  MOTION_META,
  GLOBAL_PARAM_COUNT,
  TIMBRE_PARAM_COUNT,
  TIMBRE_BLOCKS,
  wheelDestParam,
  WHEEL_DEST_GATE_TIME,
  WHEEL_DEST_MULTI_SHAPE,
  type TimbreParamIds,
} from './params'
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
  lfoRateToHz,
  lfoIntTo01,
  levelTo01,
  programLevelToDb,
  portamentoToSec,
  polyDuo,
  unisonDetuneCents,
  monoSubMix,
  CHORDS,
  chordIndex,
  ARP_RATES,
  voiceSpreadPan,
  microTuneCents,
} from './curves'
import {
  EngineBase,
  DBG_TAP_SIZE,
  type EngineBaseConfig,
  type OffsetLayer,
  type OffsetResolution,
} from '../../dsp/enginebase'
import type { Arp } from '../../dsp/arp'
import { Voice } from './voice'
import { ModFx } from '../../dsp/fx/modfx'
import { DelayFx } from '../../dsp/fx/delay'
import { ReverbFx } from '../../dsp/fx/reverb'
import { LfComp } from '../../dsp/fx/lfcomp'

export { DBG_TAP_SIZE }

/** TIMBRE TYPE values (params.ts order): LAYER, XFADE, SPLIT. */
const TT_XFADE = 1
const TT_SPLIT = 2

/** Per-timbre VOICE MODE values (timbre byte +6 order, MIDIimp P14). */
const TM_POLY = 0
const TM_MONO = 1
const TM_UNISON = 2
// TM_CHORD = 3 (the monoStartT default branch)

/** ARP TARGET [Main+Sub, Main, Sub] -> timbre bitmask (bit0 main, bit1 sub). */
const ARP_TARGET_MASKS = [3, 1, 2] as const

/** DUO: stacked-voice detune at amount = 1, in cents. UNCONFIRMED (the xd
 *  value; spec §17 "DUO stacked level/detune curves"). */
const DUO_DETUNE_CENTS = 30

/** Per-voice headroom into the sum: 16 voices vs the xd's 4 get a smaller
 *  share so full-pool stacks stay inside the limiter's linear region.
 *  UNCONFIRMED (output-level calibration target). */
const PROLOGUE_VOICE_MIX = 0.2

/** Pentatonic pitch-class sets + special microtuning indexes (family
 *  MICRO_TUNINGS order in dsp/tuning.ts; same handling as the xd). */
const PENTA_MAJOR = [0, 2, 4, 7, 9]
const PENTA_MINOR = [0, 3, 5, 7, 10]
const MT_MAJOR_PENTA = 8
const MT_MINOR_PENTA = 9
const MT_REVERSE = 10

/** Timbre-block layout constants (params.ts: globals, then two blocks). */
const T1_BASE = GLOBAL_PARAM_COUNT
const T2_BASE = GLOBAL_PARAM_COUNT + TIMBRE_PARAM_COUNT
const T_END = GLOBAL_PARAM_COUNT + 2 * TIMBRE_PARAM_COUNT

/** Offset of each timbre param WITHIN its block (identical for both blocks):
 *  the applyParam dispatch switches on these so one binding serves t1 + t2. */
const O: TimbreParamIds = (() => {
  const src = TIMBRE_BLOCKS[0] as unknown as Record<string, number>
  const out: Record<string, number> = {}
  for (const k of Object.keys(src)) out[k] = src[k] - T1_BASE
  return out as unknown as TimbreParamIds
})()

const MODFX_SUB_PARAM = [
  P.MODFX_SUB_CHORUS, P.MODFX_SUB_ENSEMBLE, P.MODFX_SUB_PHASER,
  P.MODFX_SUB_FLANGER, P.MODFX_SUB_USER,
]

/** VCO/MULTI octave enum -> frequency multiplier. The prologue's program
 *  enum runs 2'->16' (REVERSED vs the xd/OG, params.ts note): 8' (value 2)
 *  is unity, so mult = 2^(2 - value). */
function octMult(e: number): number {
  return Math.pow(2, 2 - Math.round(e))
}

/** UNISON detune slot factor for voice k of n (generalizes the family
 *  4-voice UNI_OFF spread [-1..-1/3..1/3..1] to the timbre's pool share). */
function uniSlot(k: number, n: number): number {
  return n <= 1 ? 0 : (2 * k) / (n - 1) - 1
}

/** prologue arp TYPE (6, spec §10) x RANGE (1-4 oct) -> the family arp core's
 *  13-type index (dsp/arp.ts). RANGE 1 = the "1" (one-octave) variants,
 *  RANGE >= 2 = the "2" variants — the core has no 3/4-octave spans, and the
 *  hardware's raw RANGE mapping is itself UNCONFIRMED (spec §17); best-effort
 *  approximation. POLY RANDOM ("2 random notes at once") has no core
 *  equivalent — approximated by the POLY chord-per-step types (UNCONFIRMED). */
function arpCoreType(type: number, range: number): number {
  const two = range >= 2
  switch (type) {
    case 0: return two ? 1 : 0 // MANUAL
    case 1: return two ? 3 : 2 // RISE
    case 2: return two ? 5 : 4 // FALL
    case 3: return two ? 7 : 6 // RISE FALL
    case 4: return two ? 11 : 10 // RANDOM
    default: return two ? 9 : 8 // POLY RANDOM -> POLY 1/2 (approximation)
  }
}

/** Family-shared engine wiring (dsp/enginebase.ts), bound per instance so
 *  the two hardware variants (8/16 voices) share the class (spec §14). */
function makeCfg(numVoices: number): EngineBaseConfig<Voice> {
  return {
    params: PARAMS,
    motionMeta: MOTION_META,
    numVoices,
    createVoice: (sr, i) => new Voice(sr, i),
    ids: {
      // The prologue's voice modes/portamento/bend ranges are PER TIMBRE and
      // its arp is program-global rather than a voice mode: the base's
      // single-mode fields are parked on -1 sentinels (the monologue
      // precedent — out-of-range reads resolve to "off") and this engine
      // owns the dispatch (refreshGlide/refreshBend overrides, timbre
      // noteOn/noteOff layer, arp gating overrides).
      voiceMode: -1,
      bendRangePlus: -1,
      bendRangeMinus: -1,
      portamento: -1,
      portamentoBpm: -1, // no BPM-synced portamento on the prologue
      portamentoMode: P.PORTAMENTO_MODE,
    },
    portamentoToSec,
    // arp exists (base constructs it + runs its transport); voiceMode -1
    // keeps the base's mode-equality key routing permanently off.
    arp: { voiceMode: -1 },
    voiceMix: PROLOGUE_VOICE_MIX,
  }
}

export class Engine extends EngineBase<Voice> {
  /** The prologue always has an arpeggiator (makeCfg arp). */
  declare readonly arp: Arp

  // Per-voice timbre tag mirror (bank.auxOf without a method call in the
  // per-sample sum; startVoice keeps it in sync with the bank).
  private readonly voiceTimbre = new Int32Array(this.nv)
  // Per-voice sum-stage state: timbre weight (BALANCE/XFADE) + spread pan.
  private readonly sumGain = new Float64Array(this.nv).fill(1)
  private readonly panL = new Float64Array(this.nv).fill(Math.SQRT1_2)
  private readonly panR = new Float64Array(this.nv).fill(Math.SQRT1_2)
  // Per-voice UNISON slot factor (live VM DEPTH re-detune).
  private readonly uniOffV = new Float64Array(this.nv)

  // Per-timbre state.
  private readonly glideSecT = new Float64Array(2)
  private readonly bendMultT = new Float64Array(2).fill(1)
  private readonly lastStartHzT = new Float64Array(2)
  private readonly monoNote = new Int32Array(2).fill(-1)
  /** Mono-family (MONO/UNISON/CHORD) voice sets, per timbre: a legato
   *  transition re-pitches the SAME voices; a fresh strike rotates. */
  private readonly monoSet: readonly [Int32Array, Int32Array] = [
    new Int32Array(this.nv).fill(-1),
    new Int32Array(this.nv).fill(-1),
  ]
  private readonly monoSetLen = new Int32Array(2)

  // Mono-start plan scratch (no allocation on the note path).
  private readonly planNote = new Int32Array(this.nv)
  private readonly planDet = new Float64Array(this.nv)
  private readonly planGain = new Float64Array(this.nv)
  private readonly planStk = new Uint8Array(this.nv)
  private readonly planOff = new Float64Array(this.nv)

  /** Set by acquireVoice: the returned voice was stolen (restart pended with
   *  the note's parameters) — the caller must not start it now. */
  private acqStolen = false

  // Wheel deflection (setBend mirror: the base's bendX is private).
  private bendVal = 0
  // Mod wheel + aftertouch offset layers, one PER TIMBRE (spec §9).
  private readonly wheelLayers: readonly [OffsetLayer, OffsetLayer]
  private readonly atLayers: readonly [OffsetLayer, OffsetLayer]

  // Arp state: fired-note timbre mask (0 = live routing) + edge detection.
  private arpMask = 0
  private arpEngaged = false

  private calcSemis = 60 // scratch: semitone of the last noteHz() call

  // Engine-owned per-timbre stereo buses (block-sized; grown only if an
  // offline render exceeds the worklet's 128-frame blocks).
  private busML = new Float32Array(128)
  private busMR = new Float32Array(128)
  private busSL = new Float32Array(128)
  private busSR = new Float32Array(128)

  // Shared stereo FX (spec §7): MOD FX -> DELAY-or-REVERB -> L.F. COMP.
  private readonly modfx: ModFx
  private readonly delay: DelayFx
  private readonly reverb: ReverbFx
  private readonly lfcomp: LfComp

  constructor(sampleRate: number, numVoices: 8 | 16 = 16) {
    super(sampleRate, makeCfg(numVoices))
    this.modfx = new ModFx(this.sr)
    this.delay = new DelayFx(this.sr)
    this.reverb = new ReverbFx(this.sr)
    this.lfcomp = new LfComp(this.sr)
    this.wheelLayers = [
      this.addOffsetLayer((v, out) => this.resolveWheel(0, v, out)),
      this.addOffsetLayer((v, out) => this.resolveWheel(1, v, out)),
    ]
    this.atLayers = [
      this.addOffsetLayer((v, out) => this.resolveAt(0, v, out)),
      this.addOffsetLayer((v, out) => this.resolveAt(1, v, out)),
    ]
    this.delay.setBpm(this.bpm)
    this.finishInit()
  }

  /** Timbre tag of voice i (0 = MAIN, 1 = SUB) — telemetry/tests. */
  timbreOf(i: number): number {
    return i >= 0 && i < this.nv ? this.voiceTimbre[i] : 0
  }

  /* ------------------------------------------------- wheels / aftertouch -- */

  /** MOD WHEEL deflection 0..1 (unipolar): one physical wheel drives BOTH
   *  timbres' offset layers, each resolving its own M.WHEEL ASSIGN/RANGE. */
  setJoyY(v: number): void {
    if (!Number.isFinite(v)) return
    const w = clamp(v, 0, 1)
    for (let t = 0; t < 2; t++) {
      this.wheelLayers[t].value = w
      this.wheelLayers[t].dirty = true
    }
  }

  /** FW2 MIDI aftertouch 0..1: per-timbre MIDI AFTERTOUCH assign (spec §9). */
  setPressure(v: number): void {
    if (!Number.isFinite(v)) return
    const p = clamp(v, 0, 1)
    for (let t = 0; t < 2; t++) {
      this.atLayers[t].value = p
      this.atLayers[t].dirty = true
    }
  }

  /** Destination index -> concrete param id for timbre t. GATE TIME resolves
   *  to the ARP's gate (no step sequencer on the prologue, spec §10); MULTI
   *  SHAPE resolves to the timbre's active engine type's shape param. */
  private resolveDest(destIndex: number, t: number): number {
    const id = wheelDestParam(destIndex, t)
    if (id === WHEEL_DEST_GATE_TIME) return P.ARP_GATE
    if (id === WHEEL_DEST_MULTI_SHAPE) {
      const T = TIMBRE_BLOCKS[t]
      const ty = Math.round(this.effectiveParam(T.multiType))
      return ty === 0 ? T.shapeNoise : ty === 1 ? T.shapeVpm : T.shapeUser
    }
    return id
  }

  private resolveWheel(t: number, v: number, out: OffsetResolution): void {
    const T = TIMBRE_BLOCKS[t]
    const dest = this.resolveDest(Math.round(this.params[T.wheelAssign]), t)
    if (dest < 0) return
    const rangePct = (this.params[T.wheelRange] - 100) / 100 // ±100%
    const meta = PARAMS[dest]
    out.dest = dest
    out.offset = v * rangePct * (meta.max - meta.min)
  }

  private resolveAt(t: number, v: number, out: OffsetResolution): void {
    const T = TIMBRE_BLOCKS[t]
    const dest = this.resolveDest(Math.round(this.params[T.atAssign]), t)
    if (dest < 0) return
    // Unipolar, +full span at max pressure (the xd aftertouch precedent).
    const meta = PARAMS[dest]
    out.dest = dest
    out.offset = v * (meta.max - meta.min)
  }

  /* ------------------------------------------------------- bend (per T) -- */

  override setBend(v: number): void {
    if (Number.isFinite(v)) this.bendVal = clamp(v, -1, 1)
    super.setBend(v)
  }

  /** BEND RANGE +/- is per timbre: each timbre's voices get their own mult. */
  protected override refreshBend(): void {
    const v = this.motion.bendOn ? this.motion.bend : this.bendVal
    for (let t = 0; t < 2; t++) {
      const T = TIMBRE_BLOCKS[t]
      const range = v >= 0 ? this.params[T.bendRangePlus] : this.params[T.bendRangeMinus]
      this.bendMultT[t] = Math.pow(2, (v * range) / 12) // range 0 = Off
    }
    for (let i = 0; i < this.nv; i++) this.voices[i].setBendMult(this.bendMultT[this.voiceTimbre[i]])
  }

  /* ----------------------------------------------- raw -> physical push -- */

  protected applyParam(id: number): void {
    if (!PARAMS[id]) return
    if (id >= T1_BASE && id < T_END) {
      const t = id < T2_BASE ? 0 : 1
      this.applyTimbreParam(t, id - (t === 0 ? T1_BASE : T2_BASE))
      return
    }
    this.applyGlobalParam(id)
  }

  private applyGlobalParam(id: number): void {
    const e = this.effectiveParam(id)
    const vs = this.voices
    switch (id) {
      case P.SUB_ON:
        if (e < 0.5) {
          // Sub disabled: release its voices (tags persist; a later reuse
          // retags). Existing MAIN voices above the halved budget simply
          // resolve through stealing on the next allocations (UNCONFIRMED
          // hardware behavior for notes sounding across the switch).
          this.bank.releaseAll(this.sustainOn, 1)
          this.monoSetLen[1] = 0
          this.monoNote[1] = -1
        }
        this.refreshSumGains()
        break
      case P.EDIT_TIMBRE:
        break // panel edit scope — app-side, nothing to do engine-side
      case P.TIMBRE_TYPE:
      case P.BALANCE:
      case P.POSITION:
        this.refreshSumGains()
        break
      case P.SPLIT_POINT:
        break // read at noteOn routing time (liveMask)
      case P.AMP_VELOCITY:
        for (let i = 0; i < this.nv; i++) vs[i].setAmpVelocity(e)
        break
      case P.PORTAMENTO_MODE:
        break // read at noteOn time (glideForT)
      case P.PROGRAM_LEVEL:
        this.gainT = dbToGain(programLevelToDb(e))
        break
      case P.PROGRAM_TUNING:
      case P.PROGRAM_TRANSPOSE:
      case P.MICRO_TUNING:
      case P.SCALE_KEY:
        this.retuneSounding()
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
      case P.MODFX_SPEED:
        this.modfx.setTime(e / 1023)
        break
      case P.MODFX_DEPTH:
        this.modfx.setDepth(e / 1023)
        break
      case P.MODFX_ROUTING:
      case P.DLRV_ROUTING:
        break // read at block rate (processFx)
      case P.DLRV_SELECT:
      case P.DLRV_ON: {
        // Exclusive select (byte 62) gated by the separate ON/OFF (byte 72).
        const sel = Math.round(this.params[P.DLRV_SELECT])
        const on = this.params[P.DLRV_ON] >= 0.5
        this.delay.setOn(on && sel === 1)
        this.reverb.setOn(on && sel === 2)
        break
      }
      case P.DELAY_SUB:
        this.delay.setSubType(Math.round(e))
        break
      case P.REVERB_SUB:
        this.reverb.setSubType(Math.round(e))
        break
      case P.DLRV_TIME:
        this.delay.setTime(e / 1023)
        this.reverb.setTime(e / 1023)
        break
      case P.DLRV_DEPTH:
        this.delay.setDepth(e / 1023)
        this.reverb.setDepth(e / 1023)
        break
      case P.DLRV_DRYWET:
        this.delay.setDryWet(e / 1024)
        this.reverb.setDryWet(e / 1024)
        break
      case P.ARP_ON_LATCH: {
        const on = Math.round(e) >= 1
        if (on && !this.arpEngaged) {
          // Engaging the arp takes the keys over: flush live voices so
          // nothing hangs (the family voice-mode-switch precedent;
          // UNCONFIRMED hardware behavior for notes already sounding).
          this.bank.releaseAll(this.sustainOn)
          this.stack.clear()
          this.stack.clearMonoSustained()
          this.monoNote[0] = this.monoNote[1] = -1
          this.monoSetLen[0] = this.monoSetLen[1] = 0
        }
        this.arpEngaged = on
        this.syncArp()
        break
      }
      case P.ARP_TYPE:
      case P.ARP_RANGE:
      case P.ARP_RATE:
      case P.ARP_GATE:
        this.syncArp()
        break
      case P.ARP_TARGET:
        break // read per arp-fired note (hookNoteOn)
      case RP.LF_COMP_ON:
        this.lfcomp.setOn(e >= 0.5)
        break
      case RP.LF_COMP_GAIN:
        this.lfcomp.setGain(e / 1023)
        break
      case RP.VOICE_CAP:
        this.applyVoiceCap()
        break
      default:
        break // OCTAVE (keyboard-side), MICRO_TUNING handled above, etc.
    }
  }

  /** Per-timbre param: engine-level side effects, then the per-voice push to
   *  every voice currently TAGGED with that timbre (idle ones included —
   *  they play that timbre next; a retag re-pushes the whole block). */
  private applyTimbreParam(t: number, off: number): void {
    switch (off) {
      case O.portamento:
        this.refreshGlide()
        return
      case O.voiceSpread:
        this.refreshPans(t)
        return
      case O.vmDepth:
        this.applyVmDepth(t)
        return
      case O.voiceMode:
        this.flushTimbre(t)
        return
      case O.wheelAssign:
      case O.wheelRange:
        this.wheelLayers[t].dirty = true
        return
      case O.atAssign:
        this.atLayers[t].dirty = true
        return
      case O.bendRangePlus:
      case O.bendRangeMinus:
        this.refreshBend()
        return
      case O.egLegato:
        return // read at noteOn time (monoStartT)
      case O.lfoVoiceSync:
        return // read at block rate (preProcess)
      case O.multiType:
        // MULTI SHAPE wheel/aftertouch destinations re-resolve per type.
        this.wheelLayers[t].dirty = true
        this.atLayers[t].dirty = true
        break // and fall through to the voice push
      default:
        break
    }
    for (let i = 0; i < this.nv; i++) {
      if (this.voiceTimbre[i] === t) this.pushTimbre(this.voices[i], t, off)
    }
  }

  /** One timbre param -> physical push into one voice. */
  private pushTimbre(v: Voice, t: number, off: number): void {
    const T = TIMBRE_BLOCKS[t]
    switch (off) {
      case O.vco1Wave:
        v.setVcoWave(0, Math.round(this.effectiveParam(T.vco1Wave)))
        break
      case O.vco2Wave:
        v.setVcoWave(1, Math.round(this.effectiveParam(T.vco2Wave)))
        break
      case O.vco1Octave:
        v.setVcoOctave(0, octMult(this.effectiveParam(T.vco1Octave)))
        break
      case O.vco2Octave:
        v.setVcoOctave(1, octMult(this.effectiveParam(T.vco2Octave)))
        break
      case O.vco1Pitch:
        v.setVcoPitchCents(0, pitchToCents(this.effectiveParam(T.vco1Pitch)))
        break
      case O.vco2Pitch:
        v.setVcoPitchCents(1, pitchToCents(this.effectiveParam(T.vco2Pitch)))
        break
      case O.vco1Shape:
        v.setVcoShape(0, this.effectiveParam(T.vco1Shape) / 1023)
        break
      case O.vco2Shape:
        v.setVcoShape(1, this.effectiveParam(T.vco2Shape) / 1023)
        break
      case O.pitchEgTarget:
        v.setPitchEgTarget(Math.round(this.effectiveParam(T.pitchEgTarget)))
        break
      case O.pitchEgInt:
        v.setPitchEgCents(pitchEgIntToCents(this.effectiveParam(T.pitchEgInt)))
        break
      case O.syncRing:
        v.setSyncRing(Math.round(this.effectiveParam(T.syncRing)))
        break
      case O.crossMod:
        v.setXmod(this.effectiveParam(T.crossMod) / 1023)
        break
      case O.multiRouting:
        v.setMultiRoutingPost(Math.round(this.effectiveParam(T.multiRouting)) === 1)
        break
      case O.multiType:
        v.setMultiType(Math.round(this.effectiveParam(T.multiType)))
        this.pushMultiSelect(v, t)
        break
      case O.selectNoise:
      case O.selectVpm:
      case O.selectUser:
        this.pushMultiSelect(v, t)
        break
      case O.multiOctave:
        v.setMultiOctave(octMult(this.effectiveParam(T.multiOctave)))
        break
      case O.shapeNoise:
      case O.shapeVpm:
      case O.shapeUser:
      case O.shiftShapeVpm:
      case O.shiftShapeUser:
        this.pushMultiShape(v, t)
        break
      case O.vco1Level:
        v.setVcoLevel(0, levelTo01(this.effectiveParam(T.vco1Level)))
        break
      case O.vco2Level:
        v.setVcoLevel(1, levelTo01(this.effectiveParam(T.vco2Level)))
        break
      case O.multiLevel:
        v.setMultiLevel(levelTo01(this.effectiveParam(T.multiLevel)))
        break
      case O.cutoff:
        v.setCutoff(cutoffToHz(this.effectiveParam(T.cutoff)))
        break
      case O.resonance:
        v.setResonance(resonanceTo01(this.effectiveParam(T.resonance)))
        break
      case O.cutoffEgInt:
        v.setCutoffEgInt(egIntToPercent(this.effectiveParam(T.cutoffEgInt)))
        break
      case O.drive:
        v.setDrive(Math.round(this.effectiveParam(T.drive)))
        break
      case O.lowCut:
        v.setLowCut(this.effectiveParam(T.lowCut) >= 0.5)
        break
      case O.keytrack:
        v.setKeytrack(KEYTRACK_AMOUNT[Math.round(this.effectiveParam(T.keytrack))] ?? 0)
        break
      case O.egVelocity:
        v.setEgVelocity(this.effectiveParam(T.egVelocity))
        break
      case O.ampAttack:
      case O.ampDecay:
      case O.ampSustain:
      case O.ampRelease:
        v.setAmpEg(
          attackToSec(this.effectiveParam(T.ampAttack)),
          decayToSec(this.effectiveParam(T.ampDecay)),
          this.effectiveParam(T.ampSustain) / 1023,
          releaseToSec(this.effectiveParam(T.ampRelease)),
        )
        break
      case O.egAttack:
      case O.egDecay:
      case O.egSustain:
      case O.egRelease:
        v.setModEg(
          attackToSec(this.effectiveParam(T.egAttack)),
          decayToSec(this.effectiveParam(T.egDecay)),
          this.effectiveParam(T.egSustain) / 1023,
          releaseToSec(this.effectiveParam(T.egRelease)),
        )
        break
      case O.lfoWave:
        v.setLfoWave(Math.round(this.effectiveParam(T.lfoWave)))
        break
      case O.lfoMode:
      case O.lfoRate:
        // MODE picks the Hz curve (BPM/SLOW/FAST, spec §8; no 1-shot).
        v.setLfoFreq(
          lfoRateToHz(
            this.effectiveParam(T.lfoRate),
            Math.round(this.effectiveParam(T.lfoMode)),
            this.bpm,
          ),
        )
        break
      case O.lfoInt:
        v.setLfoInt(lfoIntTo01(this.effectiveParam(T.lfoInt)))
        break
      case O.lfoTarget:
        v.setLfoTarget(Math.round(this.effectiveParam(T.lfoTarget)))
        break
      case O.lfoTargetOsc:
        v.setLfoTargetOsc(Math.round(this.effectiveParam(T.lfoTargetOsc)))
        break
      case O.lfoKeySync:
        v.setLfoKeySync(this.effectiveParam(T.lfoKeySync) >= 0.5)
        break
      case O.vpmFeedback:
      case O.vpmNoiseDepth:
      case O.vpmShapeModInt:
      case O.vpmModAttack:
      case O.vpmModDecay:
      case O.vpmKeyTrack:
        // Raw 0..200 (100 = 0%) -> -1..+1 trims (control path: the small
        // object per push is fine).
        v.setVpmTrims({
          feedback: (this.effectiveParam(T.vpmFeedback) - 100) / 100,
          noiseDepth: (this.effectiveParam(T.vpmNoiseDepth) - 100) / 100,
          shapeModInt: (this.effectiveParam(T.vpmShapeModInt) - 100) / 100,
          modAttack: (this.effectiveParam(T.vpmModAttack) - 100) / 100,
          modDecay: (this.effectiveParam(T.vpmModDecay) - 100) / 100,
          keyTrack: (this.effectiveParam(T.vpmKeyTrack) - 100) / 100,
        })
        break
      default:
        break // engine-level offsets (handled in applyTimbreParam)
    }
  }

  private pushMultiSelect(v: Voice, t: number): void {
    const T = TIMBRE_BLOCKS[t]
    const ty = Math.round(this.effectiveParam(T.multiType))
    const selParam = ty === 0 ? T.selectNoise : ty === 1 ? T.selectVpm : T.selectUser
    v.setMultiSub(Math.round(this.effectiveParam(selParam)))
    this.pushMultiShape(v, t)
  }

  private pushMultiShape(v: Voice, t: number): void {
    const T = TIMBRE_BLOCKS[t]
    const ty = Math.round(this.effectiveParam(T.multiType))
    const shapeParam = ty === 0 ? T.shapeNoise : ty === 1 ? T.shapeVpm : T.shapeUser
    v.setMultiShape(this.effectiveParam(shapeParam) / 1023)
    // NO SHIFT-SHAPE-NOISE in prologue program data (spec §6: timbre bytes
    // +36-37 are reserved): NOISE holds the neutral center (the xd's panel
    // default). VPM/USER use their stored params.
    const ss = ty === 0 ? 0.5
      : this.effectiveParam(ty === 1 ? T.shiftShapeVpm : T.shiftShapeUser) / 1023
    v.setMultiShiftShape(ss)
  }

  /** Full timbre-block push into one voice (timbre retag). */
  private pushAllTimbre(i: number, t: number): void {
    for (let off = 0; off < TIMBRE_PARAM_COUNT; off++) this.pushTimbre(this.voices[i], t, off)
  }

  /* --------------------------------------------- per-timbre derived state -- */

  private timbreMode(t: number): number {
    return Math.round(this.params[TIMBRE_BLOCKS[t].voiceMode])
  }

  private isMonoish(t: number): boolean {
    return this.timbreMode(t) >= TM_MONO
  }

  /** Usable pool size: VOICE CAP (replica-only, spec §14) bounds allocation
   *  to voice indices < cap; the bank stays this.nv wide. */
  private poolCap(): number {
    const raw = Math.round(this.params[RP.VOICE_CAP])
    return Math.max(1, Math.min(this.nv, Number.isFinite(raw) ? raw : this.nv))
  }

  /** Voice budget of a timbre: SUB ON halves the pool (16->8+8, spec §1). */
  private timbreCapOf(t: number): number {
    const cap = this.poolCap()
    if (this.params[P.SUB_ON] < 0.5) return t === 0 ? cap : 0
    return Math.max(1, cap >> 1)
  }

  private usedCountT(t: number): number {
    let c = 0
    for (let i = 0; i < this.nv; i++) {
      if (this.voiceTimbre[i] === t && this.bank.inUse(i)) c++
    }
    return c
  }

  /** Which timbres a LIVE key addresses (bit0 main, bit1 sub): SUB ON off ->
   *  main only; LAYER/XFADE -> both; SPLIT -> by key vs SPLIT POINT. The
   *  boundary key belongs to the HIGH side and POSITION 0 ('Sub<>Main') puts
   *  SUB on the low side — both UNCONFIRMED conventions (spec §15/§17). */
  private liveMask(note: number): number {
    if (this.params[P.SUB_ON] < 0.5) return 1
    if (Math.round(this.params[P.TIMBRE_TYPE]) !== TT_SPLIT) return 3
    const below = note < Math.round(this.params[P.SPLIT_POINT])
    const lowIsSub = Math.round(this.params[P.POSITION]) === 0
    return below === lowIsSub ? 2 : 1
  }

  private routesTo(note: number, t: number): boolean {
    return ((this.liveMask(note) >> t) & 1) === 1
  }

  private glideForT(t: number, legato: boolean): boolean {
    if (this.glideSecT[t] <= 0) return false
    // Portamento Mode (program-global): Auto = only when legato, On = always.
    return this.params[P.PORTAMENTO_MODE] >= 0.5 || legato
  }

  /** Portamento is PER TIMBRE (timbre byte +0): keep both times and push
   *  each voice its tagged timbre's time. */
  protected override refreshGlide(): void {
    for (let t = 0; t < 2; t++) {
      this.glideSecT[t] = portamentoToSec(this.effectiveParam(TIMBRE_BLOCKS[t].portamento))
    }
    for (let i = 0; i < this.nv; i++) this.voices[i].setGlideTime(this.glideSecT[this.voiceTimbre[i]])
    this.glideSec = this.glideSecT[0] // base field: kept coherent, unused here
  }

  /* ----------------------------------------------------- sum-stage state -- */

  /**
   * Per-voice sum weight for a timbre + played key (spec §2/§15).
   * BALANCE direction is DOCUMENTED [OM]: "64: the volume for the main
   * timbre and the sub-timbre will be the same. Turning the knob to the
   * LEFT will increase the volume of the MAIN timbre" — so 0 = full MAIN
   * only, center = both at full, 127 = full SUB only. XFADE crossfades
   * linearly across the full keybed with the low side per POSITION
   * (UNCONFIRMED, spec §17).
   */
  private timbreWeight(t: number, key: number): number {
    if (this.params[P.SUB_ON] < 0.5) return t === 0 ? 1 : 0
    const b = this.effectiveParam(P.BALANCE) / 127
    let w = t === 0 ? Math.min(1, 2 * (1 - b)) : Math.min(1, 2 * b)
    if (Math.round(this.params[P.TIMBRE_TYPE]) === TT_XFADE && key >= 0) {
      const k = Math.max(0, Math.min(127, key)) / 127
      const mainW = Math.round(this.params[P.POSITION]) === 0 ? k : 1 - k
      w *= t === 0 ? mainW : 1 - mainW
    }
    return w
  }

  private refreshSumGains(): void {
    for (let i = 0; i < this.nv; i++) {
      if (this.bank.keyOf(i) >= 0) {
        this.sumGain[i] = this.timbreWeight(this.voiceTimbre[i], this.bank.keyOf(i))
      }
    }
  }

  /** VOICE SPREAD pan for voice i under timbre t's spread (spec §13):
   *  static per-voice placement over the pool, equal-power panned.
   *  UNCONFIRMED pan law (spec §17). */
  private setPan(i: number, t: number): void {
    const spread = this.effectiveParam(TIMBRE_BLOCKS[t].voiceSpread) / 127
    const p = voiceSpreadPan(spread, i, this.poolCap())
    const a = ((p + 1) * Math.PI) / 4
    this.panL[i] = Math.cos(a)
    this.panR[i] = Math.sin(a)
  }

  private refreshPans(t = -1): void {
    for (let i = 0; i < this.nv; i++) {
      if (t < 0 || this.voiceTimbre[i] === t) this.setPan(i, this.voiceTimbre[i])
    }
  }

  /** VOICE CAP change: nothing above the cap may keep sounding or restart. */
  private applyVoiceCap(): void {
    const cap = this.poolCap()
    for (let i = cap; i < this.nv; i++) {
      this.bank.cancelPend(i)
      if (this.voices[i].active && !this.bank.isReleased(i)) this.bank.gateOff(i)
    }
    this.refreshPans() // the spread fan spans the capped pool
  }

  /* ------------------------------------------------------------- LFO ----- */

  private refreshLfoFreqs(): void {
    for (let t = 0; t < 2; t++) {
      for (let i = 0; i < this.nv; i++) {
        if (this.voiceTimbre[i] === t) this.pushTimbre(this.voices[i], t, O.lfoRate)
      }
    }
  }

  protected override onTimingChanged(): void {
    this.delay.setBpm(this.bpm)
    this.refreshLfoFreqs() // BPM-mode LFOs track the transport tempo
  }

  /* --------------------------------------------------------------- arp --- */

  private arpOn(): boolean {
    return Math.round(this.params[P.ARP_ON_LATCH]) >= 1
  }

  protected override syncArp(): void {
    const onLatch = Math.round(this.params[P.ARP_ON_LATCH])
    const rate = ARP_RATES[Math.round(this.effectiveParam(P.ARP_RATE))] ?? ARP_RATES[4]
    this.arp.setConfig({
      enabled: onLatch >= 1,
      typeIndex: arpCoreType(
        Math.round(this.params[P.ARP_TYPE]),
        Math.round(this.params[P.ARP_RANGE]),
      ),
      latch: onLatch >= 2,
      rateBeats: rate.beats,
      gate01: this.effectiveParam(P.ARP_GATE) / 72,
      swing: this.swing,
    })
  }

  /** Live keys feed the arp whenever ARP ON/LATCH is engaged (program-global
   *  — NOT a voice mode; the base's mode gate is parked on -1). */
  override noteOn(note: number, vel: number): void {
    if (!Number.isFinite(note) || !Number.isFinite(vel)) return
    const n = Math.max(0, Math.min(127, Math.round(note)))
    const v = Math.max(1, Math.min(127, Math.round(vel)))
    if (this.arpOn()) {
      this.stack.setHeld(n, true)
      this.arp.keyDown(n, v)
      return
    }
    super.noteOn(n, v)
  }

  override noteOff(note: number): void {
    if (!Number.isFinite(note)) return
    const n = Math.max(0, Math.min(127, Math.round(note)))
    if (this.arpOn()) {
      this.stack.setHeld(n, false)
      this.arp.keyUp(n)
      return
    }
    super.noteOff(n) // base also drains lingering arp-buffer keys (keyUp)
  }

  /** Arp-fired notes re-enter here: ARP TARGET picks the timbre(s) — the
   *  dispatch then applies each target timbre's OWN voice mode (UNCONFIRMED:
   *  the hardware may force plain poly for arp notes). */
  protected override hookNoteOn(note: number, vel: number, _slide?: boolean): void {
    const n = Math.max(0, Math.min(127, Math.round(note)))
    const v = Math.max(1, Math.min(127, Math.round(vel)))
    this.arpMask = ARP_TARGET_MASKS[Math.round(this.params[P.ARP_TARGET])] ?? 3
    this.noteOnInternal(n, v, false)
    this.arpMask = 0
  }

  /* --------------------------------------------------- pitch / tuning ---- */

  /** Reverse / pentatonic keyboard remapping (family microtuning menu). */
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
    for (let i = 0; i < this.nv; i++) {
      if (this.voices[i].active && this.bank.keyOf(i) >= 0) {
        const hz = this.noteHz(this.bank.noteOf(i))
        this.voices[i].setPitch(this.calcSemis, hz, false)
      }
    }
  }

  /* ------------------------------------------------ mode implementations - */

  protected modeNoteOn(note: number, vel: number, legato: boolean, _forcePoly: boolean): void {
    // forcePoly never fires here (the base's arp-mode gate is parked): the
    // timbre dispatch below IS the prologue's routing layer.
    const mask = this.arpMask !== 0 ? this.arpMask : this.liveMask(note)
    for (let t = 0; t < 2; t++) {
      if (((mask >> t) & 1) === 0) continue
      if (this.timbreCapOf(t) <= 0) continue
      if (this.timbreMode(t) === TM_POLY) {
        const pd = polyDuo(this.effectiveParam(TIMBRE_BLOCKS[t].vmDepth))
        if (pd.duo) this.duoStartT(t, note, vel, legato, pd.amount * DUO_DETUNE_CENTS, pd.amount)
        else this.polyStartT(t, note, note, vel, legato)
      } else {
        this.monoStartT(t, note, vel, this.legatoFor(t))
      }
    }
  }

  protected modeNoteOff(note: number, _forcePoly: boolean): void {
    // Per-timbre release: poly timbres release by key (aux-filtered so a
    // mono timbre's stack semantics are untouched); mono timbres go through
    // last-note-priority fall-back. A key counts for a mono timbre if it
    // routes there now OR is its current mono note (routing params may have
    // moved between press and release).
    const mono0 = this.isMonoish(0)
    const mono1 = this.isMonoish(1)
    const hit0 = mono0 && (this.monoNote[0] === note || this.routesTo(note, 0))
    const hit1 = mono1 && (this.monoNote[1] === note || this.routesTo(note, 1))
    if ((hit0 || hit1) && this.sustainOn) {
      // Damper down: defer the mono release entirely (CC64 semantics) — the
      // key stays on the stack so the pitch does not fall back mid-pedal.
      this.stack.setMonoSustained(note, true)
      if (!mono0) this.bank.releaseKey(note, true, 0)
      if (!mono1) this.bank.releaseKey(note, true, 1)
      return
    }
    this.stack.remove(note)
    if (hit0) this.monoRelease(0, note)
    else if (!mono0) this.bank.releaseKey(note, this.sustainOn, 0)
    if (hit1) this.monoRelease(1, note)
    else if (!mono1) this.bank.releaseKey(note, this.sustainOn, 1)
  }

  /** Base-class mono surface — the prologue never routes through the base's
   *  mono machinery (per-timbre dispatch above); kept for the abstract. */
  protected monoStart(note: number, vel: number, legato: boolean): void {
    for (let t = 0; t < 2; t++) {
      if (this.isMonoish(t) && this.routesTo(note, t)) this.monoStartT(t, note, vel, legato)
    }
  }

  /** Any OTHER stack key addressing timbre t (per-timbre legato: SPLIT sides
   *  are legato-independent; the just-pushed top entry is excluded). */
  private legatoFor(t: number): boolean {
    for (let k = this.stack.count - 2; k >= 0; k--) {
      if (this.routesTo(this.stack.noteAt(k), t)) return true
    }
    return false
  }

  /** Most recent stack entry addressing timbre t; -1 = none. */
  private topStackIndexFor(t: number): number {
    for (let k = this.stack.count - 1; k >= 0; k--) {
      if (this.routesTo(this.stack.noteAt(k), t)) return k
    }
    return -1
  }

  /** Mono-family key release for one timbre: empty -> release the timbre's
   *  voices; releasing the current note falls back to the previous held key
   *  addressing this timbre (legato). */
  private monoRelease(t: number, note: number): void {
    const k = this.topStackIndexFor(t)
    if (k < 0) {
      this.bank.releaseAll(this.sustainOn, t)
      this.monoNote[t] = -1
      this.monoSetLen[t] = 0
    } else if (note === this.monoNote[t]) {
      this.monoStartT(t, this.stack.noteAt(k), this.stack.velAt(k), true)
    }
  }

  /* -------------------------------------------- allocation over the pool -- */

  /**
   * Acquire a voice for timbre t under the pool cap + timbre budget. Always
   * returns a voice index; this.acqStolen tells whether a steal was
   * scheduled instead of an immediate start (the bank restarts it with the
   * note parameters once the kill ramp finishes). Under budget: idle
   * round-robin over the pool, then oldest released tail (either timbre —
   * retagged, hardware-style cross-timbre reuse), then cross-timbre steal of
   * the pool's oldest. At budget: retake the timbre's own oldest released
   * tail, else steal its own oldest. Steal policy UNCONFIRMED (spec §17).
   */
  private acquireVoice(
    t: number, key: number, soundNote: number, vel: number,
    glide: boolean, det: number, gain: number, stacked: boolean,
  ): number {
    const cap = this.poolCap()
    this.acqStolen = false
    let i: number
    if (this.usedCountT(t) < this.timbreCapOf(t)) {
      i = this.bank.allocLimit(cap)
      if (i >= 0) {
        this.retag(i, t)
        return i
      }
      i = this.bank.oldestLimit(cap)
    } else {
      i = this.bank.oldestReleasedLimit(cap, t)
      if (i >= 0) {
        this.retag(i, t)
        return i
      }
      i = this.bank.oldestLimit(cap, t)
      if (i < 0) i = this.bank.oldestLimit(cap) // unreachable guard
    }
    this.acqStolen = true
    this.bank.steal(i, key, soundNote, vel, glide, det, gain, stacked, t)
    this.retag(i, t)
    return i
  }

  /** Commit a voice to a timbre: sync the tag mirror and re-push the whole
   *  timbre block (params, glide time, bend range, spread pan) when it
   *  actually changes hands. */
  private retag(i: number, t: number): void {
    if (this.voiceTimbre[i] === t) return
    this.voiceTimbre[i] = t
    this.bank.setAux(i, t)
    this.pushAllTimbre(i, t)
    this.voices[i].setGlideTime(this.glideSecT[t])
    this.voices[i].setBendMult(this.bendMultT[t])
    this.setPan(i, t)
  }

  private polyStartT(t: number, key: number, soundNote: number, vel: number, legato: boolean): void {
    const glide = this.glideForT(t, legato)
    const i = this.acquireVoice(t, key, soundNote, vel, glide, 0, 1, false)
    this.uniOffV[i] = 0
    if (!this.acqStolen) this.startVoiceT(i, t, key, soundNote, vel, true, glide, 0, 1, false)
  }

  /** DUO zone of POLY (spec §4): main + detuned stacked voice per key. */
  private duoStartT(t: number, note: number, vel: number, legato: boolean, det: number, stackGain: number): void {
    const glide = this.glideForT(t, legato)
    const a = this.acquireVoice(t, note, note, vel, glide, 0, 1, false)
    this.uniOffV[a] = 0
    if (!this.acqStolen) this.startVoiceT(a, t, note, note, vel, true, glide, 0, 1, false)
    const b = this.acquireVoice(t, note, note, vel, glide, det, stackGain, true)
    this.uniOffV[b] = 0
    if (!this.acqStolen) this.startVoiceT(b, t, note, note, vel, true, glide, det, stackGain, true)
  }

  /**
   * Mono-family start for one timbre (MONO/UNISON/CHORD, spec §4), last-note
   * priority. Plans the voice roles, then either re-pitches the SAME voice
   * set (legato — glide/EGs stay continuous) or allocates a fresh set,
   * letting replaced voices ring out (family tails).
   */
  private monoStartT(t: number, note: number, vel: number, legato: boolean): void {
    const T = TIMBRE_BLOCKS[t]
    const mode = this.timbreMode(t)
    const tcap = this.timbreCapOf(t)
    if (tcap <= 0) return
    const depth = this.effectiveParam(T.vmDepth)
    let count: number
    if (mode === TM_UNISON) {
      // UNISON: every voice the timbre can hold (halved pool when SUB ON —
      // a 16-voice monster stack when solo, spec §4).
      count = tcap
      const det = unisonDetuneCents(depth)
      for (let k = 0; k < count; k++) {
        const off = uniSlot(k, count)
        this.planNote[k] = note
        this.planDet[k] = off * det
        this.planGain[k] = 1
        this.planStk[k] = k > 0 ? 1 : 0
        this.planOff[k] = off
      }
    } else if (mode === TM_MONO) {
      // The OG MONO model (spec §4): main + 2 sub voices at -1 oct + one at
      // -2 oct, levels from the DEPTH crossfade (UNCONFIRMED curve §17).
      const mix = monoSubMix(depth)
      count = Math.min(4, tcap)
      for (let k = 0; k < count; k++) {
        this.planNote[k] = k === 0 ? note : k === 3 ? note - 24 : note - 12
        this.planDet[k] = 0
        this.planGain[k] = k === 0 ? 1 : k === 3 ? mix.sub2 : mix.sub1
        this.planStk[k] = k === 0 ? 0 : 1
        this.planOff[k] = 0
      }
    } else {
      // CHORD: the family 14-chord table (spec §4).
      const chord = CHORDS[chordIndex(depth)]
      count = Math.min(chord.notes.length, tcap)
      for (let k = 0; k < count; k++) {
        this.planNote[k] = note + chord.notes[k]
        this.planDet[k] = 0
        this.planGain[k] = 1
        this.planStk[k] = 0
        this.planOff[k] = 0
      }
    }
    const retrig = !(this.params[T.egLegato] >= 0.5 && legato)
    const glide = this.glideForT(t, legato)
    this.monoNote[t] = note
    this.curMonoNote = note // base sustain-flush ordering hint
    const set = this.monoSet[t]
    let reuse = legato && this.monoSetLen[t] === count
    if (reuse) {
      for (let k = 0; k < count; k++) {
        const i = set[k]
        if (i < 0 || this.voiceTimbre[i] !== t) {
          reuse = false
          break
        }
      }
    }
    if (reuse) {
      for (let k = 0; k < count; k++) {
        this.uniOffV[set[k]] = this.planOff[k]
        this.startVoiceT(
          set[k], t, note, this.planNote[k], vel, retrig, glide,
          this.planDet[k], this.planGain[k], this.planStk[k] === 1,
        )
      }
      return
    }
    for (let k = 0; k < count; k++) {
      const i = this.acquireVoice(
        t, note, this.planNote[k], vel, glide,
        this.planDet[k], this.planGain[k], this.planStk[k] === 1,
      )
      set[k] = i
      this.uniOffV[i] = this.planOff[k]
      if (!this.acqStolen) {
        this.startVoiceT(
          i, t, note, this.planNote[k], vel, retrig, glide,
          this.planDet[k], this.planGain[k], this.planStk[k] === 1,
        )
      }
    }
    this.monoSetLen[t] = count
    // Replaced strike: let the timbre's previous voices ring out (release
    // tails) and cancel stale pended restarts outside the new set.
    for (let i = 0; i < this.nv; i++) {
      if (this.voiceTimbre[i] !== t) continue
      let inSet = false
      for (let k = 0; k < count; k++) {
        if (set[k] === i) {
          inSet = true
          break
        }
      }
      if (inSet) continue
      if (this.voices[i].active) {
        if (!this.bank.isReleased(i)) this.bank.gateOff(i)
      } else {
        this.bank.cancelPend(i)
      }
    }
  }

  private startVoiceT(
    i: number, t: number, key: number, soundNote: number, vel: number,
    retrig: boolean, glide: boolean, det: number, gain: number, stacked: boolean,
  ): void {
    this.retag(i, t)
    this.startVoice(i, key, soundNote, vel, retrig, glide, det, gain, stacked)
  }

  /** Shared start (also the bank's pended-restart callback target — the
   *  timbre tag was committed at steal time, so it reads the mirror). */
  protected startVoice(
    i: number, key: number, soundNote: number, vel: number,
    retrig: boolean, glide: boolean, det: number, gain: number, stacked: boolean,
  ): void {
    const v = this.voices[i]
    const t = this.voiceTimbre[i]
    this.dbgVoice = i
    const hz = this.noteHz(soundNote)
    const semis = this.calcSemis
    v.setDetuneCents(det)
    v.setVoiceGain(gain)
    // Poly portamento glides from the timbre's last started note.
    if (glide && !v.active && this.lastStartHzT[t] > 0) v.setGlideStart(this.lastStartHzT[t])
    v.noteOn(semis, hz, vel, retrig, glide)
    this.bank.started(i, key, soundNote, stacked)
    this.lastStartHzT[t] = hz
    this.sumGain[i] = this.timbreWeight(t, key)
    this.setPan(i, t)
  }

  /* -------------------------------------------------- live VM DEPTH ------ */

  private applyVmDepth(t: number): void {
    const T = TIMBRE_BLOCKS[t]
    const mode = this.timbreMode(t)
    const e = this.effectiveParam(T.vmDepth)
    const vs = this.voices
    if (mode === TM_UNISON) {
      const det = unisonDetuneCents(e)
      for (let i = 0; i < this.nv; i++) {
        if (this.voiceTimbre[i] === t && vs[i].active) vs[i].setDetuneCents(this.uniOffV[i] * det)
      }
    } else if (mode === TM_POLY) {
      const pd = polyDuo(e)
      if (pd.duo) {
        for (let i = 0; i < this.nv; i++) {
          if (this.voiceTimbre[i] === t && this.bank.isStacked(i) && vs[i].active) {
            vs[i].setDetuneCents(pd.amount * DUO_DETUNE_CENTS)
            vs[i].setVoiceGain(pd.amount)
          }
        }
      }
    } else if (mode === TM_MONO) {
      const mix = monoSubMix(e)
      const set = this.monoSet[t]
      for (let k = 1; k < this.monoSetLen[t]; k++) {
        const i = set[k]
        if (i >= 0 && this.voiceTimbre[i] === t && vs[i].active) {
          vs[i].setVoiceGain(k === 3 ? mix.sub2 : mix.sub1)
        }
      }
    }
    // CHORD: the selected chord applies on the next strike (family behavior).
  }

  /** VOICE MODE switch on one timbre: flush its notes so modes never leak
   *  (the base changeVoiceMode precedent, scoped by the timbre tag). */
  private flushTimbre(t: number): void {
    this.bank.releaseAll(this.sustainOn, t)
    this.monoSetLen[t] = 0
    this.monoNote[t] = -1
  }

  protected override onAllNotesOff(): void {
    this.monoNote[0] = this.monoNote[1] = -1
    this.monoSetLen[0] = this.monoSetLen[1] = 0
    this.arpMask = 0
  }

  /* ------------------------------------------------------------ audio ---- */

  /** LFO Voice Sync is per timbre (spec §8): each timbre's voices follow the
   *  lowest-indexed voice currently carrying that tag (block-rate phase
   *  share, the family "phase shared across voices" reading). */
  protected override preProcess(_frames: number): void {
    for (let t = 0; t < 2; t++) {
      if (this.params[TIMBRE_BLOCKS[t].lfoVoiceSync] < 0.5) continue
      let lead = -1
      for (let i = 0; i < this.nv; i++) {
        if (this.voiceTimbre[i] !== t) continue
        if (lead < 0) {
          lead = i
          continue
        }
        this.voices[i].setLfoPhase(this.voices[lead].lfoPhase)
      }
    }
  }

  private ensureBuses(frames: number): void {
    if (frames <= this.busML.length) return
    // Worklet blocks are 128 (the preallocated size); only oversized offline
    // renders land here, so the growth allocation never hits the RT path.
    this.busML = new Float32Array(frames)
    this.busMR = new Float32Array(frames)
    this.busSL = new Float32Array(frames)
    this.busSR = new Float32Array(frames)
  }

  /**
   * Stereo sum-stage override (base contract, dsp/enginebase.ts): every
   * voice ticks exactly once, the master-gain smoother advances per sample,
   * and each voice's output — scaled by voiceMix * gainSm, its timbre weight
   * and its VOICE SPREAD pan — accumulates into the MAIN or SUB stereo bus
   * pair. outL/outR are NOT written here: processFx composes them from the
   * buses (and overwrites every sample), which the base then limits.
   */
  protected override sumVoices(outL: Float32Array, outR: Float32Array, frames: number): void {
    void outL
    void outR
    this.ensureBuses(frames)
    const vs = this.voices
    const nv = this.nv
    const gc = this.gainCoef
    const bml = this.busML
    const bmr = this.busMR
    const bsl = this.busSL
    const bsr = this.busSR
    const tg = this.voiceTimbre
    const sg = this.sumGain
    const pl = this.panL
    const pr = this.panR
    for (let s = 0; s < frames; s++) {
      this.gainSm += gc * (this.gainT - this.gainSm)
      const g = this.voiceMix * this.gainSm
      let ml = 0
      let mr = 0
      let sl = 0
      let sr = 0
      for (let i = 0; i < nv; i++) {
        if (vs[i].active) {
          const o = vs[i].tick() * sg[i]
          if (tg[i] === 1) {
            sl += o * pl[i]
            sr += o * pr[i]
          } else {
            ml += o * pl[i]
            mr += o * pr[i]
          }
        } else {
          vs[i].tickIdle()
        }
      }
      ml *= g
      mr *= g
      sl *= g
      sr *= g
      bml[s] = Number.isFinite(ml) ? ml : 0
      bmr[s] = Number.isFinite(mr) ? mr : 0
      bsl[s] = Number.isFinite(sl) ? sl : 0
      bsr[s] = Number.isFinite(sr) ? sr : 0
      if (this.taps.on) this.taps.writeVoiceSample(vs[this.dbgVoice], vs)
    }
  }

  /** SERVICE-MODE FX tap: the audible mix (main + sub) at this chain point,
   *  staged through the out buffers (overwritten by the final sum anyway). */
  private tapBusMix(base: number, scratchL: Float32Array, scratchR: Float32Array, frames: number): void {
    for (let s = 0; s < frames; s++) {
      scratchL[s] = this.busML[s] + this.busSL[s]
      scratchR[s] = this.busMR[s] + this.busSR[s]
    }
    this.taps.writeFxTap(base, scratchL, scratchR, frames, false)
  }

  /**
   * FX chain over the timbre buses (spec §7): MOD FX with its ROUTING
   * [Main+Sub, Main, Sub], then the exclusive DELAY-or-REVERB with ITS
   * routing, then the buses sum to the output and the L.F. COMP runs last.
   * A Main+Sub stage merges the buses through the one shared (stateful)
   * effect; the merged stream then counts as both timbres downstream —
   * submix behavior UNCONFIRMED (spec §17 "FX routing submix behavior").
   * Merging only happens while the MOD FX is ON, so the OFF default keeps
   * the buses separate for the delay/reverb stage's routing.
   */
  protected processFx(outL: Float32Array, outR: Float32Array, frames: number): void {
    const bml = this.busML
    const bmr = this.busMR
    const bsl = this.busSL
    const bsr = this.busSR
    let merged = false
    const mfxRouting = Math.round(this.params[P.MODFX_ROUTING])
    if (mfxRouting === 0 && this.params[P.MODFX_ON] >= 0.5) {
      for (let s = 0; s < frames; s++) {
        bml[s] += bsl[s]
        bmr[s] += bsr[s]
        bsl[s] = 0
        bsr[s] = 0
      }
      merged = true
      this.modfx.process(bml, bmr, frames)
    } else if (mfxRouting === 2) {
      this.modfx.process(bsl, bsr, frames)
    } else {
      this.modfx.process(bml, bmr, frames)
    }
    if (this.taps.on) this.tapBusMix(6, outL, outR, frames) // post-MOD FX

    // DELAY or REVERB, mutually exclusive: both constructed, only the
    // selected one processes (switching cuts the other's tail, spec §7).
    const sel = Math.round(this.params[P.DLRV_SELECT])
    const fx = sel === 1 ? this.delay : sel === 2 ? this.reverb : null
    if (fx) {
      const routing = merged ? 0 : Math.round(this.params[P.DLRV_ROUTING])
      if (routing === 0) {
        if (!merged) {
          for (let s = 0; s < frames; s++) {
            bml[s] += bsl[s]
            bmr[s] += bsr[s]
            bsl[s] = 0
            bsr[s] = 0
          }
          merged = true
        }
        fx.process(bml, bmr, frames)
      } else if (routing === 2) {
        fx.process(bsl, bsr, frames)
      } else {
        fx.process(bml, bmr, frames)
      }
    }
    if (this.taps.on) this.tapBusMix(8, outL, outR, frames) // post-DL/RV

    // Sum the buses to the output; L.F. COMP is LAST in the chain (spec §7;
    // prologue-16 only on hardware — the 8-variant keeps it off app-side).
    for (let s = 0; s < frames; s++) {
      outL[s] = bml[s] + bsl[s]
      outR[s] = bmr[s] + bsr[s]
    }
    this.lfcomp.process(outL, outR, frames)
  }
}
