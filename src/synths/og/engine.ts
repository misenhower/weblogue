/*
 * Engine — the original minilogue replica's synth core (worklet-side,
 * DOM-free). See docs/og-spec.md; UNCONFIRMED behaviors are marked and are
 * hardware-calibration targets.
 *
 * The family-shared machinery (param store + layered parameter model, note
 * skeleton, transport, process() skeleton, SERVICE MODE plumbing) lives in
 * dsp/enginebase.ts; this file is the OG binding: the applyParam switch, the
 * HI PASS + DELAY block, the slider offset layer, and the OG's eight voice
 * modes (spec §3) built on the shared VoiceBank/NoteStack mechanics:
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
import { P, PARAMS, MOTION_META, sliderDestParam, SLIDER_DEST_PITCH_BEND, SLIDER_DEST_GATE_TIME } from './params'
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
import {
  EngineBase,
  DBG_TAP_SIZE,
  UNI_OFF,
  type EngineBaseConfig,
  type OffsetLayer,
  type OffsetResolution,
} from '../../dsp/enginebase'
import type { Arp } from '../../dsp/arp'
import { Voice } from './voice'
import { DcBlock } from '../../dsp/dcblock'
import { OgDelayFx } from './delayfx'

const NV = 4
export { DBG_TAP_SIZE }

/** Voice modes (params.ts / spec §3 order). */
const VM_POLY = 0
const VM_DUO = 1
const VM_UNISON = 2
const VM_MONO = 3
const VM_CHORD = 4
const VM_DELAY = 5
const VM_ARP = 6
const VM_SIDECHAIN = 7

/** Arp rate: the OG has no rate menu; 16th notes. UNCONFIRMED. */
const ARP_RATE_BEATS = 0.25
const ARP_GATE = 0.75

/** SIDE CHAIN duck recovery time constant, seconds. UNCONFIRMED. */
const DUCK_RECOVERY_SEC = 0.35

/** DELAY-mode echo scheduling capacity (3 echoes x queued strikes). */
const ECHO_CAP = 24

/** Family-shared engine wiring (dsp/enginebase.ts), bound to the OG tables. */
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
  /** The OG always has an arpeggiator (BASE_CFG.arp). */
  declare readonly arp: Arp

  // Slider offset layer (assignable single axis; PITCH BEND arrives as bend).
  private readonly sliderLayer: OffsetLayer

  // DELAY-mode echo queue (sample countdowns; fired in preProcess()).
  private readonly eLeft = new Float64Array(ECHO_CAP)
  private readonly eKey = new Int32Array(ECHO_CAP)
  private readonly eVel = new Int32Array(ECHO_CAP)
  private eCount = 0

  // SIDE CHAIN duck state (per voice; block-rate recovery).
  private readonly duck = new Float64Array(NV).fill(1)
  private duckActive = false

  // FX: the HI PASS + DELAY block, behind the hardware's AC-coupled
  // voice-bus -> FX-ADC boundary (src/dsp/dcblock.ts).
  private readonly dcL: DcBlock
  private readonly dcR: DcBlock
  private readonly delay: OgDelayFx
  private readonly fxChain: ReadonlyArray<{ process(l: Float32Array, r: Float32Array, n: number): void }>

  constructor(sampleRate: number) {
    super(sampleRate, BASE_CFG)
    this.dcL = new DcBlock(this.sr)
    this.dcR = new DcBlock(this.sr)
    this.delay = new OgDelayFx(this.sr)
    this.fxChain = [this.delay]
    this.sliderLayer = this.addOffsetLayer((v, out) => this.resolveSlider(v, out))
    this.finishInit()
  }

  /* ------------------------------------------------------------- slider -- */

  /** Slider deflection -1..1 for assignable (non-bend) destinations. */
  setJoyY(v: number): void {
    if (!Number.isFinite(v)) return
    this.sliderLayer.value = clamp(v, -1, 1)
    this.sliderLayer.dirty = true
  }

  /** The OG has no aftertouch; accepted for protocol compatibility. */
  setPressure(_v: number): void {}

  private resolveSlider(v: number, out: OffsetResolution): void {
    const idx = Math.round(this.params[P.SLIDER_ASSIGN])
    const destId = sliderDestParam(idx)
    const rangePct = (this.params[P.SLIDER_RANGE] - 100) / 100
    if (destId === SLIDER_DEST_GATE_TIME) {
      out.gateOffset = v * rangePct * 72
    } else if (destId !== SLIDER_DEST_PITCH_BEND && destId >= 0) {
      const meta = PARAMS[destId]
      out.dest = destId
      out.offset = v * rangePct * (meta.max - meta.min)
    }
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
        break // read at block rate (lfoVoiceSyncOn)
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
      case P.VOICE_MODE:
        if (this.changeVoiceMode(Math.round(e))) {
          this.eCount = 0
          this.resetDucks()
        }
        this.syncArp()
        break
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
        this.sliderLayer.dirty = true
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

  protected override syncArp(): void {
    this.arp.setConfig({
      enabled: this.curMode === VM_ARP,
      typeIndex: arpTypeIndex(this.effectiveParam(P.VM_DEPTH)),
      latch: this.params[P.ARP_LATCH] >= 0.5,
      rateBeats: ARP_RATE_BEATS,
      gate01: ARP_GATE,
      swing: this.swing,
    })
  }

  protected override onTimingChanged(): void {
    this.refreshLfoFreq()
  }

  /* --------------------------------------------------- pitch ------------- */

  /** note -> Hz (no microtuning/transpose menus on the OG). */
  private noteHz(note: number): number {
    return 440 * Math.pow(2, (note - 69) / 12)
  }

  /* ------------------------------------------------ mode implementations - */

  private isMonoMode(mode: number): boolean {
    return mode === VM_UNISON || mode === VM_CHORD || mode === VM_MONO
  }

  protected modeNoteOn(note: number, vel: number, legato: boolean, forcePoly: boolean): void {
    const mode = forcePoly ? VM_POLY : this.curMode
    if (this.isMonoMode(mode)) {
      this.monoStart(note, vel, legato)
      return
    }
    if (mode === VM_DUO) {
      // DUO: detuned pairs, 2-voice poly (spec §3).
      this.duoStart(note, vel, legato, duoDetuneCents(this.effectiveParam(P.VM_DEPTH)), 1)
      return
    }
    if (mode === VM_DELAY) {
      this.polyStart(note, note, vel, legato)
      this.scheduleEchoes(note, vel)
      return
    }
    if (mode === VM_SIDECHAIN) {
      const i = this.polyStart(note, note, vel, legato)
      this.duckOthers(i)
      return
    }
    // POLY: chord-invert voicing of the held set (spec §3, UNCONFIRMED).
    // Arp hook notes are plain poly — their VM DEPTH selects the arp type.
    const sound = forcePoly ? note : this.invertedNote(note)
    this.polyStart(note, sound, vel, legato)
    if (!forcePoly) this.applyPolyInvert()
  }

  protected modeNoteOff(note: number, forcePoly: boolean): void {
    const mode = forcePoly ? VM_POLY : this.curMode
    if (this.isMonoMode(mode)) {
      this.monoNoteOff(note)
      return
    }
    this.stack.remove(note)
    this.bank.releaseKey(note, this.sustainOn)
    if (mode === VM_POLY && !forcePoly) this.applyPolyInvert()
  }

  /** UNISON / CHORD / MONO start (last-note priority, legato = no retrig). */
  protected monoStart(note: number, vel: number, legato: boolean): void {
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
      this.chordStart(chord.notes, note, vel, retrig, glide)
    }
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

  protected startVoice(
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
    v.noteOn(soundNote, hz, vel, retrig, glide)
    this.bank.started(i, key, soundNote, stacked)
    this.lastStartHz = hz
  }

  /* ------------------------------------------------------------ audio ---- */

  protected override onAllNotesOff(): void {
    this.eCount = 0
    this.resetDucks()
  }

  protected override preProcess(frames: number): void {
    if (this.eCount > 0) this.fireEchoes(frames)
    this.tickDucks(frames)
  }

  /** LFO Voice Sync (og-spec §8): phase shared across voices, so per-voice
   *  EG-MOD=RATE sweeps can't scatter a synced chord. */
  protected override lfoVoiceSyncOn(): boolean {
    return this.params[P.LFO_VOICE_SYNC] >= 0.5
  }

  /** FX: pre-delay tap, the HPF+DELAY block, post-delay tap (the OG is
   *  strictly mono out; the scopes render mono). The voice bus is AC-coupled
   *  first, like the hardware's FX ADC — see src/dsp/dcblock.ts for how a
   *  ring+sync DC pedestal otherwise reaches the output limiter. */
  protected processFx(outL: Float32Array, outR: Float32Array, frames: number): void {
    this.dcL.process(outL, frames)
    this.dcR.process(outR, frames)
    if (this.taps.on) this.taps.writeFxTap(6, outL, outR, frames, false)
    for (let f = 0; f < this.fxChain.length; f++) this.fxChain[f].process(outL, outR, frames)
    if (this.taps.on) this.taps.writeFxTap(8, outL, outR, frames, false)
  }
}

/** The 13 arp type names (UI + tests). */
export { ARP_TYPES }
