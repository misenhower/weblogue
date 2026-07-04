/*
 * Voice — THE analog voice of the Korg monologue replica (it is monophonic;
 * the engine builds exactly one). See docs/monologue-spec.md §1, §3-§7, §14.
 *
 * Owns: VCO1 + VCO2 (Vco) with the NOISE generator on VCO2's wave selector,
 * VCF (SvfFilter, MONO_FILTER_CFG, fixed 2-pole), ONE knob set of EG values
 * wired into TWO AdsrEg instances (see below), LFO, per-VCO Drift, and the
 * post-VCA DRIVE stage (dsp/drive.ts) — the final stage of the voice.
 *
 * Push model as in the og voice: the Engine maps raw knob values to PHYSICAL
 * units once per param change; tick() only reads scalars. Per-sample path:
 *
 *   pitch = glide(noteFreq) * bend * drift (+EG pitch per TARGET, +LFO)
 *   VCO1 -> [SYNC / RING (exclusive)] -> CH2 (VCO2 | NOISE | ring product)
 *   2-ch mixer (smoothed levels) -> VCF (keytrack/EG/LFO cutoff, 2-pole)
 *   -> VCA (amp EG * amp velocity * voiceGain) -> DRIVE -> out
 *
 * monologue specifics vs the og voice:
 *  - single EG knob set (TYPE/ATTACK/DECAY/INT/TARGET) drives two envelopes:
 *    the VCA envelope (shape per TYPE — A/D percussive, A/G/D gated-hold,
 *    GATE ~0.5 ms rectangle) and the TARGET envelope, which is an
 *    Attack/Decay shape in ALL THREE types (spec §5), scaled by bipolar INT
 *    into CUTOFF (octaves), PITCH 2 (VCO2 cents) or PITCH (both VCOs);
 *  - retrigger HARD-RESETS both envelopes to zero (multi-trigger, spec
 *    §5/§14); the engine passes retrigger=false for portamento legato;
 *  - VCO2's wave selector has NOISE in place of SQR: the channel outputs the
 *    white-noise generator and SHAPE has no effect (spec §3); RING with
 *    NOISE selected rings VCO1 x noise;
 *  - SYNC/RING is one exclusive 3-position switch — never both, and NO
 *    cross mod on this synth (spec §3);
 *  - LFO reaches true audio rate in FAST mode (0.5 Hz-2.8 kHz) and 1-SHOT
 *    stops a half-cycle after note-on; INT is bipolar; SHAPE/PITCH targets
 *    hit both VCOs (spec §6);
 *  - one-shot SLIDE glide (glideOnce): a sequencer SLIDE step glides into
 *    the next note over the program's Slide Time, independent of Portamento.
 *
 * SERVICE MODE taps: the TapVoice slots are POSITIONAL (rings 0-5); the
 * monologue's 6-stage story is
 *   ring0 tapV1  = VCO 1
 *   ring1 tapV2  = CH 2 (VCO2 / NOISE / RING product)
 *   ring2 tapM   = MIX (2-channel mixer sum)
 *   ring3 tapMix = FILTER out
 *   ring4 tapFilt= VCA out (pre-drive)
 *   ring5 tapVca = DRIVE out (the voice's final output)
 * i.e. the field names shift one stage from the og's because the monologue
 * has no third source channel but adds DRIVE as a first-class stage — the
 * mono debug-def must label rings by INDEX, not by field name.
 */
import { Vco } from '../../dsp/osc'
import { Noise } from '../../dsp/noise'
import { SvfFilter } from '../../dsp/filter'
import { AdsrEg } from '../../dsp/eg'
import { Lfo, LFO_MODE } from '../../dsp/lfo'
import { Drift } from '../../dsp/drift'
import { Drive } from '../../dsp/drive'
import {
  MONO_FILTER_CFG,
  MONO_DRIVE_CFG,
  EG_MAX_PITCH_CENTS,
  EG_MAX_CUTOFF_OCTAVES,
  LFO_MAX_PITCH_CENTS,
  LFO_MAX_CUTOFF_OCTAVES,
  LFO_MAX_SHAPE,
} from './curves'

/** EG TYPE values (params.ts / program-data order): GATE, A/G/D, A/D. */
const EG_GATE = 0
const EG_AGD = 1
// value 2 = A/D (the default branch in refreshEgConfig)

/** EG TARGET values (params.ts order): CUTOFF, PITCH 2, PITCH. */
const ET_CUTOFF = 0
const ET_PITCH2 = 1
const ET_PITCH = 2

/** LFO TARGET values (params.ts order): CUTOFF, SHAPE, PITCH. */
const LT_CUTOFF = 0
const LT_SHAPE = 1
const LT_PITCH = 2

/** FAST mode tops out at 2.8 kHz — true audio rate (spec §6). */
const LFO_MAX_HZ = 2800
/** Shorter slew than the family default (1 ms would triangle-ize FAST
 *  squares above ~500 Hz, spec §14). UNCONFIRMED time. */
const LFO_SLEW_SEC = 0.0003

/** GATE-type VCA edge time, ~0.5 ms ("time-based changes cannot be made to
 *  the VCA", spec §5). Matches the AdsrEg minimum segment time. */
const GATE_EDGE_SEC = 0.0005

const RING_GAIN = 1.4 // UNCONFIRMED (family value, as in the og voice)
const CENT = 1 / 1200
const MIN_CUTOFF = 5

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function pow2(x: number): number {
  return Math.pow(2, x)
}

export class Voice {
  private readonly sr: number
  private readonly maxFreq: number
  private readonly levelCoef: number // ~2 ms one-pole for mixer levels

  private readonly vco1: Vco
  private readonly vco2: Vco
  private readonly noise: Noise
  private readonly filter: SvfFilter
  /** VCA envelope — shape reconfigured per EG TYPE (refreshEgConfig). */
  private readonly ampEg: AdsrEg
  /** TARGET envelope — always Attack/Decay (sustain 0, release = DECAY):
   *  "in all three types an Attack/Decay envelope scaled by Int modulates
   *  the TARGET" (spec §5). Second instance of the same knob values. */
  private readonly modEg: AdsrEg
  private readonly lfo: Lfo
  // Two physical analog oscillators drift independently; the noise
  // generator is a drift-free discrete circuit (spec §3).
  private readonly drift1: Drift
  private readonly drift2: Drift
  private readonly drive: Drive

  // --- pitch state ---
  private _note = 60 // semitone used for filter keytrack
  private targetLog = Math.log2(440)
  private curLog = Math.log2(440)
  private glideCoef = 1 // 1 = snap (portamento layer)
  private glideOnceCoef = 0 // active one-shot SLIDE glide (0 = none)
  private glideOncePend = 0 // armed by glideOnce(), consumed by the next start
  private bendMult = 1
  private detuneCents = 0 // EngineVoice surface; unused musically (1 voice)
  private oct1 = 1
  private oct2 = 1
  private pitch1Cents = 0
  private pitch2Cents = 0

  // --- osc/mixer state ---
  private shape1 = 0
  private shape2 = 0
  private syncOn = false
  private ringOn = false
  private noiseT = 0 // CH2 source target: 1 = NOISE selected on VCO2
  private noiseMix = 0 // smoothed VCO2<->NOISE crossfade (~2 ms, no click)
  private lvl1T = 1
  private lvl2T = 0
  private lvl1 = 1
  private lvl2 = 0

  // --- filter state ---
  private cutoffHz = 21000
  private ktAmt = 0 // Cutoff Key Track menu amount 0/0.5/1
  private cutVel01 = 0 // Cutoff Velocity menu amount 0/0.5/1

  // --- EG state (one knob set, two envelopes) ---
  private egType = EG_AGD
  private egAttackSec = 0.002
  private egDecaySec = 0.1
  private egTarget = ET_CUTOFF
  private egPitchCents = 0 // INT * EG_MAX_PITCH_CENTS (bipolar)
  private egCutOct = 0 // INT * EG_MAX_CUTOFF_OCTAVES (bipolar)
  private ampVel01 = 0.5 // Amp Velocity menu /127
  private vel01 = 1

  // --- LFO state ---
  private lfoInt01 = 0 // -1..1 (bipolar on the monologue, spec §6)
  private lfoTarget = LT_PITCH
  private lfoOneShot = false

  private voiceGain = 1

  constructor(sampleRate: number, voiceIndex: number) {
    const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
    this.sr = sr
    this.maxFreq = sr * 0.45
    this.levelCoef = 1 - Math.exp(-1 / (0.002 * sr))
    this.vco1 = new Vco(sr)
    this.vco2 = new Vco(sr)
    const vi = (voiceIndex | 0) + 1
    this.noise = new Noise(vi * 0x2545f491)
    this.filter = new SvfFilter(sr, MONO_FILTER_CFG)
    this.ampEg = new AdsrEg(sr)
    this.modEg = new AdsrEg(sr)
    this.lfo = new Lfo(sr, LFO_MAX_HZ, LFO_SLEW_SEC)
    this.drift1 = new Drift(sr, vi * 2 * 0x9e3779b9)
    this.drift2 = new Drift(sr, (vi * 2 + 1) * 0x9e3779b9)
    this.drive = new Drive(sr, MONO_DRIVE_CFG)
    this.refreshEgConfig()
  }

  /* ------------------------------------------------------------- events -- */

  /**
   * Start / restart the note. retrigger=true HARD-RESETS both envelopes to
   * ZERO (the monologue's multi-trigger, spec §5/§14 — a retrig under a slow
   * attack really does dip to silence); retrigger=false is the
   * portamento-on single-trigger legato path: envelopes continue, oscillator
   * phases and drift untouched. glide=true approaches freqHz through the
   * portamento one-pole (or a pending glideOnce SLIDE time); else it snaps.
   */
  noteOn(note: number, freqHz: number, vel: number, retrigger: boolean, glide: boolean): void {
    this._note = note
    const v = vel < 1 ? 1 : vel > 127 ? 127 : vel
    this.vel01 = v / 127
    this.setPitchTarget(freqHz, glide)
    this.ampEg.gateOn(retrigger, true)
    this.modEg.gateOn(retrigger, true) // TARGET env resets too — UNCONFIRMED
    if (retrigger) {
      this.drift1.noteOn()
      this.drift2.noteOn()
      // 1-SHOT runs a half-cycle from note-on (spec §6); no other key sync.
      if (this.lfoOneShot) this.lfo.trigger()
    }
  }

  /** Live retune (tuning menu change / legato retarget), no gating. */
  setPitch(note: number, freqHz: number, glide: boolean): void {
    this._note = note
    this.setPitchTarget(freqHz, glide)
  }

  private setPitchTarget(freqHz: number, glide: boolean): void {
    // Consume a pending one-shot SLIDE glide; a start without one clears any
    // still-running SLIDE so the next portamento glide runs at its own time.
    this.glideOnceCoef = this.glideOncePend
    this.glideOncePend = 0
    const f = freqHz < 0.01 ? 0.01 : freqHz > this.maxFreq ? this.maxFreq : freqHz
    this.targetLog = Math.log2(f)
    const coef = this.glideOnceCoef > 0 ? this.glideOnceCoef : this.glideCoef
    if (!glide || coef >= 1) {
      this.curLog = this.targetLog
      this.glideOnceCoef = 0
    }
  }

  /** Seed the glide start point (SLIDE into a step after the gate ended). */
  setGlideStart(freqHz: number): void {
    if (Number.isFinite(freqHz) && freqHz > 0.01) this.curLog = Math.log2(freqHz)
  }

  /**
   * Arm a ONE-SHOT glide for the next noteOn/setPitch (sequencer SLIDE,
   * spec §8): that single transition glides over `sec` seconds regardless of
   * PORTAMENTO, then the voice reverts to the portamento glide time.
   */
  glideOnce(sec: number): void {
    if (!Number.isFinite(sec) || sec <= 0) this.glideOncePend = 1
    else this.glideOncePend = 1 - Math.exp(-3 / (sec * this.sr))
  }

  noteOff(): void {
    this.ampEg.gateOff()
    // TARGET envelope: release rate == decay rate (refreshEgConfig), so a
    // note-off mid-decay continues the same one-pole fall. Exact hardware
    // early-note-off semantics UNCONFIRMED (spec §16).
    this.modEg.gateOff()
  }

  /** Fast-fade for voice stealing; the engine restarts the voice next block. */
  kill(): void {
    this.ampEg.kill()
  }

  /**
   * SERVICE MODE taps (positional rings — see the header): tapV1 VCO1,
   * tapV2 CH2, tapM MIX, tapMix FILTER, tapFilt VCA, tapVca DRIVE out.
   */
  tapOn = false
  tapV1 = 0
  tapV2 = 0
  tapM = 0
  tapMix = 0
  tapFilt = 0
  tapVca = 0
  lastDrift1 = 0
  lastDrift2 = 0
  lastAmp = 0
  lastModEg = 0 // the TARGET Attack/Decay envelope
  lastLfo = 0
  lastHz = 0

  get active(): boolean {
    return this.ampEg.active
  }

  get note(): number {
    return this._note
  }

  /** LFO phase share (EngineVoice surface; single voice, so never shared). */
  get lfoPhase(): number {
    return this.lfo.phase
  }

  setLfoPhase(p: number): void {
    if (!Number.isFinite(p)) return
    ;(this.lfo as unknown as { ph: number }).ph = p - Math.floor(p)
  }

  /* ------------------------------------------------------------ setters -- */

  /** VCO1 WAVE, program-data order 0=SQR/1=TRI/2=SAW (== dsp VCO_WAVE). */
  setVco1Wave(wave: number): void {
    this.vco1.setWave(wave)
  }

  /** VCO2 WAVE, program-data order 0=NOISE/1=TRI/2=SAW (spec §3): NOISE
   *  swaps the channel source to the noise generator (SHAPE has no effect);
   *  TRI/SAW values coincide with the dsp VCO_WAVE ids. The source swap is
   *  crossfaded ~2 ms in tick() so the switch doesn't click. */
  setVco2Wave(wave: number): void {
    const w = Math.round(wave)
    if (w === 0) {
      this.noiseT = 1
    } else {
      this.noiseT = 0
      this.vco2.setWave(w)
    }
  }

  /** Octave as a frequency multiplier (16'=0.5, 8'=1, 4'=2, 2'=4). */
  setVcoOctave(osc: number, mult: number): void {
    if (osc === 0) this.oct1 = mult
    else this.oct2 = mult
  }

  setVcoPitchCents(osc: number, cents: number): void {
    if (osc === 0) this.pitch1Cents = cents
    else this.pitch2Cents = cents
  }

  setVcoShape(osc: number, s01: number): void {
    if (osc === 0) this.shape1 = clamp01(s01)
    else this.shape2 = clamp01(s01)
  }

  setVcoLevel(osc: number, l01: number): void {
    if (osc === 0) this.lvl1T = clamp01(l01)
    else this.lvl2T = clamp01(l01)
  }

  /** SYNC/RING exclusive 3-position switch (spec §3): 0=RING, 1=OFF,
   *  2=SYNC — never both. */
  setSyncRing(mode: number): void {
    const m = Math.round(mode)
    this.ringOn = m === 0
    this.syncOn = m === 2
  }

  setCutoff(hz: number): void {
    this.cutoffHz = hz
  }

  setResonance(r01: number): void {
    this.filter.setResonance(r01)
  }

  /** Cutoff Key Track menu amount 0/0.5/1 (spec §11). */
  setKeytrack(amt01: number): void {
    this.ktAmt = amt01
  }

  /** Cutoff Velocity menu amount 0/0.5/1 (spec §11; og velScale model,
   *  UNCONFIRMED on this hardware). */
  setCutoffVelocity(amt01: number): void {
    this.cutVel01 = clamp01(amt01)
  }

  /** EG TYPE (0=GATE, 1=A/G/D, 2=A/D — program-data order, spec §5). */
  setEgType(t: number): void {
    this.egType = Math.round(t)
    this.refreshEgConfig()
  }

  /** The single ATTACK/DECAY knob pair feeds both envelopes. */
  setEgTimes(attackSec: number, decaySec: number): void {
    this.egAttackSec = attackSec
    this.egDecaySec = decaySec
    this.refreshEgConfig()
  }

  /**
   * One knob set, two envelopes (spec §5):
   *  - VCA env per TYPE: A/D = decays to 0 even while held (sustain 0) and
   *    note-off mid-decay continues at the same rate (release = DECAY);
   *    A/G/D = holds at fixed max while gated, DECAY is the release;
   *    GATE = ~0.5 ms rectangular edges, times ignored;
   *  - TARGET env: Attack/Decay in ALL types (sustain 0, release = DECAY).
   */
  private refreshEgConfig(): void {
    const a = this.egAttackSec
    const d = this.egDecaySec
    const amp = this.ampEg
    if (this.egType === EG_GATE) {
      amp.setAttack(GATE_EDGE_SEC)
      amp.setDecay(d) // irrelevant at sustain 1
      amp.setSustain(1)
      amp.setRelease(GATE_EDGE_SEC)
    } else if (this.egType === EG_AGD) {
      amp.setAttack(a)
      amp.setDecay(d) // irrelevant at sustain 1
      amp.setSustain(1)
      amp.setRelease(d) // DECAY acts as the release (spec §5)
    } else {
      // A/D: percussive — decays to silence even while held.
      amp.setAttack(a)
      amp.setDecay(d)
      amp.setSustain(0)
      amp.setRelease(d) // early note-off keeps falling at the decay rate
    }
    const mod = this.modEg
    mod.setAttack(a)
    mod.setDecay(d)
    mod.setSustain(0)
    mod.setRelease(d)
  }

  /** EG INT -1..1 (curves.egIntTo01; bipolar center-512, spec §5). */
  setEgInt(i01: number): void {
    const i = i01 < -1 ? -1 : i01 > 1 ? 1 : i01
    this.egPitchCents = i * EG_MAX_PITCH_CENTS
    this.egCutOct = i * EG_MAX_CUTOFF_OCTAVES
  }

  /** EG TARGET (0=CUTOFF, 1=PITCH 2, 2=PITCH — spec §5). */
  setEgTarget(t: number): void {
    this.egTarget = Math.round(t)
  }

  setAmpVelocity(v127: number): void {
    this.ampVel01 = clamp01(v127 / 127)
  }

  setLfoWave(w: number): void {
    this.lfo.setWave(w)
  }

  /** LFO MODE (param order 0=1-SHOT, 1=SLOW, 2=FAST, spec §6): 1-SHOT arms
   *  the dsp one-shot; SLOW/FAST free-run — the engine pushes the per-mode
   *  Hz through setLfoFreq. */
  setLfoMode(m: number): void {
    const mode = Math.round(m)
    this.lfoOneShot = mode === 0
    this.lfo.setMode(mode === 0 ? LFO_MODE.ONE_SHOT : LFO_MODE.NORMAL)
  }

  /** LFO rate in Hz (engine maps the knob per mode / BPM sync). */
  setLfoFreq(hz: number): void {
    this.lfo.setFreq(Number.isFinite(hz) && hz > 0 ? hz : 0)
  }

  /** LFO INT -1..1 (bipolar on the monologue; curves.lfoIntTo01). */
  setLfoInt(i01: number): void {
    this.lfoInt01 = i01 < -1 ? -1 : i01 > 1 ? 1 : i01
  }

  setLfoTarget(t: number): void {
    this.lfoTarget = t | 0
  }

  /** DRIVE amount 0..1 (curves.driveAmount01) into the post-VCA stage. */
  setDrive(amount01: number): void {
    this.drive.setAmount(amount01)
  }

  /** Portamento time in seconds; 0 = off (pitch snaps). ~3 tau to arrive. */
  setGlideTime(sec: number): void {
    if (!Number.isFinite(sec) || sec <= 0) this.glideCoef = 1
    else this.glideCoef = 1 - Math.exp(-3 / (sec * this.sr))
  }

  /** Pitch-bend frequency multiplier (engine computes 2^(semis/12)). */
  setBendMult(m: number): void {
    if (Number.isFinite(m) && m > 0) this.bendMult = m
  }

  /** EngineVoice surface (no unison/duo stacks on a monophonic synth). */
  setDetuneCents(c: number): void {
    if (Number.isFinite(c)) this.detuneCents = c
  }

  setVoiceGain(g: number): void {
    if (Number.isFinite(g)) this.voiceGain = g < 0 ? 0 : g > 1 ? 1 : g
  }

  /* --------------------------------------------------------------- tick -- */

  /**
   * Idle tick: analog VCO drift and the free-running LFO keep evolving while
   * the voice is silent (family behavior).
   */
  tickIdle(): void {
    const d1 = this.drift1.tick()
    const d2 = this.drift2.tick()
    const lv = this.lfo.tick()
    if (this.tapOn) {
      this.lastDrift1 = d1
      this.lastDrift2 = d2
      this.lastLfo = lv
    }
  }

  tick(): number {
    // Modulators.
    const egV = this.modEg.tick() // TARGET Attack/Decay envelope
    const ampV = this.ampEg.tick()
    const drift1C = this.drift1.tick()
    const drift2C = this.drift2.tick()
    const lfoV = this.lfo.tick()

    // Pitch glide in log2-frequency domain (one-pole); an active one-shot
    // SLIDE glide overrides the portamento coefficient until it arrives.
    let lg = this.curLog
    if (lg !== this.targetLog) {
      const coef = this.glideOnceCoef > 0 ? this.glideOnceCoef : this.glideCoef
      lg += coef * (this.targetLog - lg)
      const d = this.targetLog - lg
      if (d < 1e-7 && d > -1e-7) {
        lg = this.targetLog
        this.glideOnceCoef = 0 // SLIDE glide arrived: back to portamento
      }
      this.curLog = lg
    }
    const baseHz = pow2(lg) * this.bendMult

    // EG -> pitch per TARGET (spec §5): PITCH = both VCOs, PITCH 2 = VCO2.
    const egPitch = this.egPitchCents * egV
    const egPitch1 = this.egTarget === ET_PITCH ? egPitch : 0
    const egPitch2 = this.egTarget === ET_PITCH || this.egTarget === ET_PITCH2 ? egPitch : 0

    // LFO -> PITCH hits both VCOs (spec §6).
    const lfoPitch = this.lfoTarget === LT_PITCH ? this.lfoInt01 * LFO_MAX_PITCH_CENTS * lfoV : 0

    const det = this.detuneCents
    const f1 = baseHz * this.oct1 * pow2((this.pitch1Cents + det + drift1C + egPitch1 + lfoPitch) * CENT)
    const f2 = baseHz * this.oct2 * pow2((this.pitch2Cents + det + drift2C + egPitch2 + lfoPitch) * CENT)

    // LFO -> SHAPE on both VCOs (no effect on the NOISE source, spec §3).
    const lfoShape = this.lfoTarget === LT_SHAPE ? this.lfoInt01 * LFO_MAX_SHAPE * lfoV : 0
    this.vco1.setShape(clamp01(this.shape1 + lfoShape))
    this.vco2.setShape(clamp01(this.shape2 + lfoShape))

    // VCO1, then the exclusive SYNC/RING switch (spec §3).
    this.vco1.setFreq(f1)
    const o1 = this.vco1.tick(0)
    this.vco2.setFreq(f2)
    if (this.syncOn && this.vco1.wrapped) this.vco2.hardSync(this.vco1.wrapFrac)
    const oV2 = this.vco2.tick(0)
    const oN = this.noise.tick()

    // CH2 source: VCO2 <-> NOISE crossfade (~2 ms, mirrors the Vco's own
    // wave-switch fade so selecting NOISE doesn't click). RING replaces the
    // channel with the VCO1 x source product — noise-ring included (spec §3).
    this.noiseMix += this.levelCoef * (this.noiseT - this.noiseMix)
    const src2 = oV2 + (oN - oV2) * this.noiseMix
    const ch2 = this.ringOn ? o1 * src2 * RING_GAIN : src2

    // 2-channel mixer (~2 ms level smoothing) — spec §1.
    const lc = this.levelCoef
    this.lvl1 += lc * (this.lvl1T - this.lvl1)
    this.lvl2 += lc * (this.lvl2T - this.lvl2)
    const x = this.lvl1 * o1 + this.lvl2 * ch2

    // Filter: keytrack (centered C4) x EG x LFO, exponents summed -> one pow.
    // Cutoff Velocity scales the EG->cutoff amount (og model, UNCONFIRMED).
    const velScale = 1 + (this.vel01 - 1) * this.cutVel01
    const egOct = this.egTarget === ET_CUTOFF ? this.egCutOct * egV * velScale : 0
    const lfoOct = this.lfoTarget === LT_CUTOFF ? this.lfoInt01 * LFO_MAX_CUTOFF_OCTAVES * lfoV : 0
    let fc = this.cutoffHz * pow2((this.ktAmt * (this._note - 60)) / 12 + egOct + lfoOct)
    if (!(fc >= MIN_CUTOFF)) fc = MIN_CUTOFF // also catches NaN
    else if (fc > this.maxFreq) fc = this.maxFreq
    this.filter.setCutoff(fc)
    const y = this.filter.tick(x)

    // VCA: amp EG x amp velocity (0 = velocity ignored) x voice gain.
    const ampVelGain = 1 + (this.vel01 - 1) * this.ampVel01
    const vca = y * ampV * ampVelGain * this.voiceGain

    // DRIVE: post-VCA analog overdrive, the voice's final stage (spec §1/§7).
    let out = this.drive.tick(vca)
    if (!Number.isFinite(out)) out = 0
    else if (out > -1e-18 && out < 1e-18) out = 0 // flush denormals

    if (this.tapOn) {
      this.tapV1 = o1
      this.tapV2 = ch2
      this.tapM = x // MIX
      this.tapMix = y // FILTER
      this.tapFilt = vca // VCA
      this.tapVca = out // DRIVE out
      this.lastDrift1 = drift1C
      this.lastDrift2 = drift2C
      this.lastAmp = ampV
      this.lastModEg = egV
      this.lastLfo = lfoV
      this.lastHz = baseHz
    }
    return out
  }
}
