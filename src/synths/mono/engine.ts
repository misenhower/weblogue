/*
 * Engine — the Korg monologue replica's synth core (worklet-side, DOM-free).
 * See docs/monologue-spec.md; UNCONFIRMED behaviors are marked and are
 * hardware-calibration targets (docs/hardware-calibration.md).
 *
 * The family-shared machinery (param store + layered parameter model, note
 * skeleton, transport, process() skeleton, SERVICE MODE plumbing) lives in
 * dsp/enginebase.ts; this file is the monologue binding:
 *
 *  - ONE voice (the synth is monophonic, spec §1): last-note priority with
 *    multi-trigger EG hard-reset by default and single-trigger legato when
 *    PORTAMENTO is on (spec §5);
 *  - the applyParam switch over the mono table, incl. the exclusive
 *    SYNC/RING tri-state, VCO2's NOISE wave, the dual-wired EG and the
 *    per-mode LFO rate curves (SLOW/1-SHOT vs FAST, spec §6);
 *  - the assignable SLIDER offset layer (same machinery as the og slider);
 *  - sequencer SLIDE (spec §8): a flagged step glides INTO the next step's
 *    note over the program Slide Time — a one-shot glide independent of
 *    PORTAMENTO (Voice.glideOnce);
 *  - KEY TRG / HOLD (spec §8): while lit and the sequence has content, keys
 *    do not play the voice — they start ENGINE-LOCAL sequence playback
 *    transposed by the played key. This drives the SAME StepSeq as the
 *    store-driven 'play' message but through a separate ownership flag
 *    (keyTrigStarted), so the two transports never fight: a UI play/stop
 *    simply takes the transport over;
 *  - NO effects of any kind (spec §1): the FX chain is empty — DRIVE lives
 *    inside the voice as its final stage; no arpeggiator (cfg.arp omitted).
 */
import {
  P,
  PARAMS,
  MOTION_META,
  sliderDestParam,
  SLIDER_DEST_PITCH_BEND,
  SLIDER_DEST_GATE_TIME,
} from './params'
import { clamp, dbToGain } from '../../shared/maps'
import {
  pitchToCents,
  egIntTo01,
  attackToSec,
  decayToSec,
  cutoffToHz,
  resonanceTo01,
  CUTOFF_VELOCITY_AMOUNT,
  CUTOFF_KEYTRACK_AMOUNT,
  lfoRateToHz,
  lfoBpmToHz,
  lfoIntTo01,
  levelTo01,
  programLevelToDb,
  portamentoToSec,
  slideTimeToSec,
  driveAmount01,
  microTuneCents,
} from './curves'
import {
  EngineBase,
  DBG_TAP_SIZE,
  type EngineBaseConfig,
  type OffsetLayer,
  type OffsetResolution,
} from '../../dsp/enginebase'
import type { Program, SeqData } from '../../shared/program'
import { Voice } from './voice'

/** The monologue is monophonic: exactly one voice (spec §1). */
const NV = 1
export { DBG_TAP_SIZE }

/** KEY TRG/HOLD param values (params.ts): Off, KEY TRG, HOLD. */
const KT_OFF = 0
const KT_TRIG = 1

/** KEY TRG transpose reference: playing this key plays the sequence as
 *  recorded. UNCONFIRMED reference note (spec §8/§16) — C4 is the family
 *  keyboard center. */
const KEY_TRIG_REF_NOTE = 60

/** Concurrently sounding seq notes to remember for transpose pairing
 *  (matches the StepSeq's own sounding-note capacity). */
const SEQ_MAP_CAP = 16

/** Pentatonic pitch-class sets + special microtuning indexes (family
 *  MICRO_TUNINGS order in dsp/tuning.ts; same handling as the xd). */
const PENTA_MAJOR = [0, 2, 4, 7, 9]
const PENTA_MINOR = [0, 3, 5, 7, 10]
const MT_MAJOR_PENTA = 8
const MT_MINOR_PENTA = 9
const MT_REVERSE = 10

/** Family-shared engine wiring (dsp/enginebase.ts), bound to the mono
 *  tables. voiceMode/portamentoBpm are -1 sentinels: the monologue has one
 *  voice mode and no BPM-synced portamento, and the base's out-of-range
 *  reads resolve to "off" (curMode is never dispatched here). */
const BASE_CFG: EngineBaseConfig<Voice> = {
  params: PARAMS,
  motionMeta: MOTION_META,
  numVoices: NV,
  createVoice: (sr, i) => new Voice(sr, i),
  ids: {
    voiceMode: -1,
    bendRangePlus: P.BEND_RANGE_PLUS,
    bendRangeMinus: P.BEND_RANGE_MINUS,
    portamento: P.PORTAMENTO,
    portamentoBpm: -1,
    portamentoMode: P.PORTAMENTO_MODE,
  },
  portamentoToSec,
  // no arp: the monologue has a sequencer but no arpeggiator (spec §14)
}

export class Engine extends EngineBase<Voice> {
  // Slider offset layer (assignable single axis; PITCH BEND arrives as bend).
  private readonly sliderLayer: OffsetLayer

  private calcSemis = 60 // scratch: semitone of the last noteHz() call

  // Sequencer SLIDE (spec §8): armed by hookNoteOn for the note it starts.
  private slidePending = false

  // KEY TRG / HOLD state (spec §8). Keys pressed while engaged never sound
  // directly; they transpose engine-local sequence playback.
  private readonly trigHeld = new Uint8Array(128)
  private trigCount = 0
  /** We (not the UI transport) started the current stepSeq playback. */
  private keyTrigStarted = false
  private keyTrigTranspose = 0
  private seqHasNotes = false

  // Original seq note -> sounded (transposed) note pairing, so a live
  // retranspose can never leave a hanging note.
  private readonly mapOrig = new Int32Array(SEQ_MAP_CAP)
  private readonly mapSnd = new Int32Array(SEQ_MAP_CAP)
  private mapN = 0

  constructor(sampleRate: number) {
    super(sampleRate, BASE_CFG)
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

  /** The monologue has no aftertouch; accepted for protocol compatibility. */
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
    const v = this.voices[0]
    switch (id) {
      case P.VCO1_WAVE:
        v.setVco1Wave(Math.round(e))
        break
      case P.VCO2_WAVE:
        v.setVco2Wave(Math.round(e)) // 0 = NOISE (spec §3)
        break
      case P.VCO1_OCTAVE:
        v.setVcoOctave(0, Math.pow(2, Math.round(e) - 1))
        break
      case P.VCO2_OCTAVE:
        v.setVcoOctave(1, Math.pow(2, Math.round(e) - 1))
        break
      case P.VCO1_PITCH:
        v.setVcoPitchCents(0, pitchToCents(e))
        break
      case P.VCO2_PITCH:
        v.setVcoPitchCents(1, pitchToCents(e))
        break
      case P.VCO1_SHAPE:
        v.setVcoShape(0, e / 1023)
        break
      case P.VCO2_SHAPE:
        v.setVcoShape(1, e / 1023)
        break
      case P.SYNC_RING:
        v.setSyncRing(Math.round(e)) // 0=RING, 1=OFF, 2=SYNC (exclusive)
        break
      case P.VCO1_LEVEL:
        v.setVcoLevel(0, levelTo01(e))
        break
      case P.VCO2_LEVEL:
        v.setVcoLevel(1, levelTo01(e))
        break
      case P.CUTOFF:
        v.setCutoff(cutoffToHz(e))
        break
      case P.RESONANCE:
        v.setResonance(resonanceTo01(e))
        break
      case P.EG_TYPE:
        v.setEgType(Math.round(e))
        break
      case P.EG_ATTACK:
      case P.EG_DECAY:
        v.setEgTimes(
          attackToSec(this.effectiveParam(P.EG_ATTACK)),
          decayToSec(this.effectiveParam(P.EG_DECAY)),
        )
        break
      case P.EG_INT:
        v.setEgInt(egIntTo01(e))
        break
      case P.EG_TARGET:
        v.setEgTarget(Math.round(e))
        break
      case P.LFO_WAVE:
        v.setLfoWave(Math.round(e))
        break
      case P.LFO_MODE:
        v.setLfoMode(Math.round(e))
        this.refreshLfoFreq() // FAST and SLOW/1-SHOT use different Hz curves
        break
      case P.LFO_RATE:
      case P.LFO_BPM_SYNC:
        this.refreshLfoFreq()
        break
      case P.LFO_INT:
        v.setLfoInt(lfoIntTo01(e))
        break
      case P.LFO_TARGET:
        v.setLfoTarget(Math.round(e))
        break
      case P.DRIVE:
        v.setDrive(driveAmount01(e))
        break
      case P.KEY_TRIG: {
        const kt = Math.round(e)
        // Switching Off (or to TRIG with no keys down) while we own the
        // transport stops engine-local playback; HOLD keeps latching.
        if (this.keyTrigStarted && (kt === KT_OFF || (kt === KT_TRIG && this.trigCount === 0))) {
          this.stopKeyTrig()
        }
        break
      }
      case P.OCTAVE:
        break // keyboard-side transpose (UI emits shifted notes)
      case P.PORTAMENTO:
        this.refreshGlide()
        break
      case P.PORTAMENTO_MODE:
        break // read at noteOn time (glideFor)
      case P.SLIDE_TIME:
        break // read when a SLIDE step fires (startVoice)
      case P.CUTOFF_VELOCITY:
        v.setCutoffVelocity(CUTOFF_VELOCITY_AMOUNT[Math.round(e)] ?? 0)
        break
      case P.CUTOFF_KEYTRACK:
        v.setKeytrack(CUTOFF_KEYTRACK_AMOUNT[Math.round(e)] ?? 0)
        break
      case P.AMP_VELOCITY:
        v.setAmpVelocity(e)
        break
      case P.PROGRAM_LEVEL:
        this.gainT = dbToGain(programLevelToDb(e))
        break
      case P.PROGRAM_TUNING:
      case P.MICRO_TUNING:
      case P.SCALE_KEY:
        this.retuneSounding()
        break
      case P.BEND_RANGE_PLUS:
      case P.BEND_RANGE_MINUS:
        this.refreshBend()
        break
      case P.SLIDER_ASSIGN:
      case P.SLIDER_RANGE:
        this.sliderLayer.dirty = true
        break
      default:
        break
    }
  }

  /** RATE knob -> Hz per LFO MODE (0=1-SHOT, 1=SLOW share the slow curve;
   *  2=FAST is audio-rate — spec §6), or the BPM-sync division table. */
  private refreshLfoFreq(): void {
    const raw = this.effectiveParam(P.LFO_RATE)
    const mode = Math.round(this.effectiveParam(P.LFO_MODE))
    const hz = this.params[P.LFO_BPM_SYNC] >= 0.5 ? lfoBpmToHz(raw, this.bpm) : lfoRateToHz(raw, mode)
    this.voices[0].setLfoFreq(hz)
  }

  protected override onTimingChanged(): void {
    this.refreshLfoFreq()
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

  /** note -> Hz with program tuning and microtuning applied.
   *  Side effect: this.calcSemis = final semitone (for filter keytrack). */
  private noteHz(note: number): number {
    const n = this.effectiveNote(note)
    const cents =
      (this.params[P.PROGRAM_TUNING] - 50) +
      microTuneCents(Math.round(this.params[P.MICRO_TUNING]), n, Math.round(this.params[P.SCALE_KEY]) - 12)
    this.calcSemis = n
    return 440 * Math.pow(2, (n - 69) / 12 + cents / 1200)
  }

  private retuneSounding(): void {
    const v = this.voices[0]
    if (v.active && this.bank.keyOf(0) >= 0) {
      const hz = this.noteHz(this.bank.noteOf(0))
      v.setPitch(this.calcSemis, hz, false)
    }
  }

  /* ------------------------------------------------------- mono notes ---- */

  protected modeNoteOn(note: number, vel: number, legato: boolean, _forcePoly: boolean): void {
    this.monoStart(note, vel, legato)
  }

  protected modeNoteOff(note: number, _forcePoly: boolean): void {
    this.monoNoteOff(note)
  }

  /**
   * The single mono start (last-note priority via the base's NoteStack).
   * Retrigger rules (spec §5): MULTI-TRIGGER by default — every start
   * hard-resets the EGs to zero (Voice.noteOn fromZero), including the
   * legato fall-back to a still-held key (UNCONFIRMED for the fall-back);
   * enabling PORTAMENTO switches to single-trigger legato even at time = 0
   * (the stored Off,0..128 quirk maps time 0 to ~3 ms, so glideSec > 0 is
   * exactly "portamento not Off").
   */
  protected monoStart(note: number, vel: number, legato: boolean): void {
    const retrig = !(legato && this.glideSec > 0)
    const glide = this.slidePending || this.glideFor(legato)
    this.curMonoNote = note
    this.startVoice(0, note, note, vel, retrig, glide, 0, 1, false)
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
    if (this.slidePending) {
      // Sequencer SLIDE: glide INTO this note over the program Slide Time
      // (one-shot, independent of PORTAMENTO — spec §8; curve UNCONFIRMED).
      v.glideOnce(slideTimeToSec(this.effectiveParam(P.SLIDE_TIME)))
      this.slidePending = false
    }
    if (glide && !v.active && this.lastStartHz > 0) v.setGlideStart(this.lastStartHz)
    v.noteOn(semis, hz, vel, retrig, glide)
    this.bank.started(i, key, soundNote, stacked)
    this.lastStartHz = hz
  }

  /* -------------------------------------------------- KEY TRG / HOLD ----- */

  /**
   * Keyboard noteOn. With KEY TRG/HOLD engaged and a non-empty sequence the
   * key does NOT play the voice: it starts (or retransposes) engine-local
   * sequence playback, transposed by (key - C4) — spec §8, reference note
   * UNCONFIRMED. With the sequence empty or the button off: normal playing.
   */
  override noteOn(note: number, vel: number): void {
    if (!Number.isFinite(note) || !Number.isFinite(vel)) return
    if (Math.round(this.params[P.KEY_TRIG]) !== KT_OFF && this.seqHasNotes) {
      const n = Math.max(0, Math.min(127, Math.round(note)))
      if (!this.trigHeld[n]) {
        this.trigHeld[n] = 1
        this.trigCount++
      }
      this.keyTrigTranspose = n - KEY_TRIG_REF_NOTE
      if (!this.stepSeq.playing) {
        this.keyTrigStarted = true // engine-local, not the UI 'play' message
        this.stepSeq.setPlaying(true)
      }
      return
    }
    super.noteOn(note, vel)
  }

  override noteOff(note: number): void {
    if (!Number.isFinite(note)) return
    const n = Math.max(0, Math.min(127, Math.round(note)))
    if (this.trigHeld[n]) {
      // This key was consumed by KEY TRG (it never sounded directly).
      this.trigHeld[n] = 0
      this.trigCount--
      if (this.trigCount === 0 && Math.round(this.params[P.KEY_TRIG]) === KT_TRIG) {
        // TRIG: releasing all keys stops ENGINE-LOCAL playback; a UI-started
        // transport keeps running and just loses the transpose (UNCONFIRMED).
        if (this.keyTrigStarted) this.stopKeyTrig()
        else this.keyTrigTranspose = 0
      }
      // HOLD: playback and the latched transpose persist after release.
      return
    }
    super.noteOff(note)
  }

  private stopKeyTrig(): void {
    this.keyTrigStarted = false
    this.keyTrigTranspose = 0
    this.stepSeq.setPlaying(false) // releases the seq's sounding notes
    this.motion.clearOverrides() // mirror EngineBase.setPlaying(false)
  }

  /** The store-driven transport ('play' messages) takes the stepSeq over in
   *  both directions; engine-local KEY TRG playback yields its ownership. */
  override setPlaying(on: boolean): void {
    this.keyTrigStarted = false
    if (!on) this.keyTrigTranspose = 0
    super.setPlaying(on)
  }

  override setSeqData(seq: SeqData): void {
    this.seqHasNotes = seqHasContent(seq)
    super.setSeqData(seq)
  }

  override loadProgram(p: Program): void {
    super.loadProgram(p) // allNotesOff inside clears the KEY TRG state
    this.seqHasNotes = seqHasContent(p.seq)
  }

  protected override onAllNotesOff(): void {
    this.trigHeld.fill(0)
    this.trigCount = 0
    if (this.keyTrigStarted) this.stopKeyTrig()
    this.keyTrigTranspose = 0
    this.mapN = 0
  }

  /* ------------------------------------------------- sequencer hooks ----- */

  /** Seq notes re-enter here: apply the KEY TRG transpose (paired for the
   *  matching noteOff) and arm the SLIDE glide for this start. */
  protected override hookNoteOn(note: number, vel: number, slide?: boolean): void {
    const orig = Math.round(note)
    const n = Math.max(0, Math.min(127, orig + this.keyTrigTranspose))
    const v = Math.max(1, Math.min(127, Math.round(vel)))
    this.mapPush(orig, n)
    if (slide === true) this.slidePending = true
    this.noteOnInternal(n, v, false)
    this.slidePending = false
  }

  protected override hookNoteOff(note: number): void {
    this.noteOffInternal(this.mapPop(Math.round(note)), false)
  }

  private mapPush(orig: number, sounded: number): void {
    if (this.mapN >= SEQ_MAP_CAP) {
      // Shouldn't happen (StepSeq caps sounding notes at the same 16); drop
      // the oldest pairing rather than leak.
      for (let k = 1; k < SEQ_MAP_CAP; k++) {
        this.mapOrig[k - 1] = this.mapOrig[k]
        this.mapSnd[k - 1] = this.mapSnd[k]
      }
      this.mapN = SEQ_MAP_CAP - 1
    }
    this.mapOrig[this.mapN] = orig
    this.mapSnd[this.mapN] = sounded
    this.mapN++
  }

  /** Sounded note for a seq noteOff; falls back to the current transpose. */
  private mapPop(orig: number): number {
    for (let k = 0; k < this.mapN; k++) {
      if (this.mapOrig[k] === orig) {
        const snd = this.mapSnd[k]
        const last = this.mapN - 1
        this.mapOrig[k] = this.mapOrig[last]
        this.mapSnd[k] = this.mapSnd[last]
        this.mapN = last
        return snd
      }
    }
    return Math.max(0, Math.min(127, orig + this.keyTrigTranspose))
  }

  /* ------------------------------------------------------------ audio ---- */

  /** No effects of any kind on the monologue (spec §1) — DRIVE is the
   *  voice's own final stage. The FX tap pairs are still written so SERVICE
   *  MODE rings 6-9 carry the (mono) output instead of stale buffers. */
  protected processFx(outL: Float32Array, outR: Float32Array, frames: number): void {
    if (this.taps.on) {
      this.taps.writeFxTap(6, outL, outR, frames, false)
      this.taps.writeFxTap(8, outL, outR, frames, false)
    }
  }
}

/** True if any step would actually fire a note (KEY TRG gating, spec §8). */
function seqHasContent(seq: SeqData): boolean {
  if (!seq || !Array.isArray(seq.steps)) return false
  for (let i = 0; i < seq.steps.length; i++) {
    const st = seq.steps[i]
    if (st && st.on === true && Array.isArray(st.notes) && st.notes.length > 0) return true
  }
  return false
}
