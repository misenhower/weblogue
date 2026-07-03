/*
 * Voice — one analog voice of the original minilogue replica
 * (docs/og-spec.md §1/§4-§8).
 *
 * Owns: VCO1 + VCO2 (Vco), NOISE, VCF (SvfFilter, 2/4-pole), AMP EG (AdsrEg),
 * EG (second full AdsrEg), LFO and analog Drift. Plain TS, sampleRate +
 * voiceIndex (drift/noise seed) constructor args. No allocation in the audio
 * path.
 *
 * Push model: the Engine maps raw knob values to PHYSICAL units once per
 * param change and pushes them here through the setters; tick() only reads
 * scalars. Per-sample signal path:
 *
 *   pitch = glide(noteFreq) * bend * drift * detune (+EG pitch on VCO2, +LFO)
 *   VCO1 -> [CROSS MOD fm / SYNC / RING] -> VCO2 ; NOISE
 *   mixer (smoothed levels) -> VCF (keytrack/EG/LFO cutoff, 2/4-pole)
 *   -> VCA (amp EG * amp velocity * voiceGain)
 *
 * OG specifics vs the xd voice:
 *  - the assignable EG has THREE parallel taps, each with its own depth:
 *    VCO2 pitch (PITCH EG INT, ±4800c), cutoff (EG INT, ±100%), and the LFO
 *    via EG MOD [OFF, RATE, INT] (rate sweeps can reach audio range);
 *  - LFO INT is unipolar; SHAPE/PITCH targets hit BOTH VCOs (no target-osc
 *    menu); no 1-shot mode;
 *  - CUTOFF VELOCITY scales the EG->cutoff amount by velocity (model
 *    UNCONFIRMED, mirrors the xd's EG-velocity blend);
 *  - NOISE is a plain white channel (digital, drift-free).
 */
import { Vco } from '../../dsp/osc'
import { Noise } from '../../dsp/noise'
import { SvfFilter } from '../../dsp/filter'
import { AdsrEg } from '../../dsp/eg'
import { Lfo } from '../../dsp/lfo'
import { Drift } from '../../dsp/drift'
import {
  OG_FILTER_CFG,
  EG_MAX_CUTOFF_OCTAVES,
  LFO_MAX_PITCH_CENTS,
  LFO_MAX_CUTOFF_OCTAVES,
  LFO_MAX_SHAPE,
} from './curves'

/** LFO TARGET values (params.ts order): CUTOFF, SHAPE, PITCH. */
const LT_CUTOFF = 0
const LT_SHAPE = 1
const LT_PITCH = 2

/** LFO EG MOD values (params.ts order): OFF, RATE, INT. */
const EM_OFF = 0
const EM_RATE = 1
const EM_INT = 2

/** EG->LFO-rate sweep depth in octaves at full EG. UNCONFIRMED on hardware. */
const EG_LFO_RATE_OCTAVES = 6

/** OG LFO can be swept into audio range by EG MOD = RATE. */
const LFO_MAX_HZ = 5000

const RING_GAIN = 1.4 // UNCONFIRMED (xd family value)
const XMOD_SCALE = 3 // UNCONFIRMED (xd family value)
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
  private readonly ampEg: AdsrEg
  private readonly modEg: AdsrEg
  private readonly lfo: Lfo
  // Independent per-VCO drift like the hardware's two physical analog
  // oscillators; the noise generator is digital and drift-free.
  private readonly drift1: Drift
  private readonly drift2: Drift

  // --- pitch state ---
  private _note = 60 // semitone used for filter keytrack
  private targetLog = Math.log2(440)
  private curLog = Math.log2(440)
  private glideCoef = 1 // 1 = snap
  private bendMult = 1
  private detuneCents = 0 // unison/duo stack offset
  private oct1 = 1
  private oct2 = 1
  private pitch1Cents = 0
  private pitch2Cents = 0
  private pitchEgCents = 0 // PITCH EG INT depth (±4800), VCO2 only

  // --- osc/mixer state ---
  private shape1 = 0
  private shape2 = 0
  private sync = false
  private ring = false
  private xmod2 = 0 // xmod01^2, precomputed
  private prevV1 = 0 // previous-sample VCO1 output (cross-mod source)
  private lvl1T = 1
  private lvl2T = 0
  private lvlNT = 0
  private lvl1 = 1
  private lvl2 = 0
  private lvlN = 0

  // --- filter state ---
  private cutoffHz = 21000
  private ktAmt = 0
  private cutVel01 = 0 // CUTOFF VELOCITY switch /100

  // --- EG / velocity state ---
  private egIntPct01 = 0 // -1..1 (filter EG INT)
  private ampVel01 = 0.5 // Amp Velocity menu /127
  private vel01 = 1

  // --- LFO state ---
  private lfoBaseHz = 1
  private lfoInt01 = 0 // 0..1 (unipolar on the OG)
  private lfoTarget = LT_PITCH
  private lfoEgMod = EM_OFF
  private lfoKeySync = false
  private lastRateEg = NaN // dedupe per-sample setFreq calls

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
    this.filter = new SvfFilter(sr, OG_FILTER_CFG)
    this.ampEg = new AdsrEg(sr)
    this.modEg = new AdsrEg(sr)
    this.lfo = new Lfo(sr, LFO_MAX_HZ)
    this.drift1 = new Drift(sr, vi * 2 * 0x9e3779b9)
    this.drift2 = new Drift(sr, (vi * 2 + 1) * 0x9e3779b9)
  }

  /* ------------------------------------------------------------- events -- */

  /**
   * Start / restart the note. retrigger=false is the legato path: envelopes
   * continue, oscillator phases and drift are untouched. glide=true
   * approaches freqHz through the portamento one-pole; otherwise it snaps.
   */
  noteOn(note: number, freqHz: number, vel: number, retrigger: boolean, glide: boolean): void {
    this._note = note
    const v = vel < 1 ? 1 : vel > 127 ? 127 : vel
    this.vel01 = v / 127
    this.setPitchTarget(freqHz, glide)
    this.ampEg.gateOn(retrigger)
    this.modEg.gateOn(retrigger)
    if (retrigger) {
      this.drift1.noteOn()
      this.drift2.noteOn()
      if (this.lfoKeySync) this.lfo.trigger()
    }
  }

  /** Live retune (mono glide retarget / POLY invert re-voicing), no gating. */
  setPitch(note: number, freqHz: number, glide: boolean): void {
    this._note = note
    this.setPitchTarget(freqHz, glide)
  }

  private setPitchTarget(freqHz: number, glide: boolean): void {
    const f = freqHz < 0.01 ? 0.01 : freqHz > this.maxFreq ? this.maxFreq : freqHz
    this.targetLog = Math.log2(f)
    if (!glide || this.glideCoef >= 1) this.curLog = this.targetLog
  }

  /** Seed the glide start point (poly portamento glides from the last note). */
  setGlideStart(freqHz: number): void {
    if (Number.isFinite(freqHz) && freqHz > 0.01) this.curLog = Math.log2(freqHz)
  }

  noteOff(): void {
    this.ampEg.gateOff()
    this.modEg.gateOff() // full ADSR on the OG: enters its release stage
  }

  /** Fast-fade for voice stealing; the engine restarts the voice next block. */
  kill(): void {
    this.ampEg.kill()
  }

  /**
   * SERVICE MODE taps: when tapOn, tick() stores its intermediate stages and
   * modulator values here for the debug panel (tapM carries the NOISE
   * channel — the OG has no multi engine).
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
  lastModEg = 0
  lastLfo = 0
  lastHz = 0

  get active(): boolean {
    return this.ampEg.active
  }

  get note(): number {
    return this._note
  }

  /** LFO phase share for LFO Voice Sync. (TS-private field: compile-time only.) */
  get lfoPhase(): number {
    return this.lfo.phase
  }

  setLfoPhase(p: number): void {
    if (!Number.isFinite(p)) return
    ;(this.lfo as unknown as { ph: number }).ph = p - Math.floor(p)
  }

  /* ------------------------------------------------------------ setters -- */

  setVcoWave(osc: number, wave: number): void {
    ;(osc === 0 ? this.vco1 : this.vco2).setWave(wave)
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

  setNoiseLevel(l01: number): void {
    this.lvlNT = clamp01(l01)
  }

  setSync(on: boolean): void {
    this.sync = on
  }

  setRing(on: boolean): void {
    this.ring = on
  }

  setXmod(x01: number): void {
    const x = clamp01(x01)
    this.xmod2 = x * x
  }

  /** PITCH EG INT depth in cents (±4800; curves.pitchEgIntToCents). */
  setPitchEgCents(c: number): void {
    if (Number.isFinite(c)) this.pitchEgCents = c
  }

  setCutoff(hz: number): void {
    this.cutoffHz = hz
  }

  setResonance(r01: number): void {
    this.filter.setResonance(r01)
  }

  /** FILTER TYPE switch: 2 or 4 poles. */
  setFilterPoles(p: number): void {
    this.filter.setPoles(p)
  }

  setKeytrack(amt01: number): void {
    this.ktAmt = amt01
  }

  /** CUTOFF VELOCITY switch amount 0/0.5/1. */
  setCutoffVelocity(amt01: number): void {
    this.cutVel01 = clamp01(amt01)
  }

  setAmpEg(attackSec: number, decaySec: number, sustain01: number, releaseSec: number): void {
    this.ampEg.setAttack(attackSec)
    this.ampEg.setDecay(decaySec)
    this.ampEg.setSustain(sustain01)
    this.ampEg.setRelease(releaseSec)
  }

  setModEg(attackSec: number, decaySec: number, sustain01: number, releaseSec: number): void {
    this.modEg.setAttack(attackSec)
    this.modEg.setDecay(decaySec)
    this.modEg.setSustain(sustain01)
    this.modEg.setRelease(releaseSec)
  }

  /** Filter EG INT as percent -100..100 (curves.egIntToPercent). */
  setEgInt(pct: number): void {
    this.egIntPct01 = (pct < -100 ? -100 : pct > 100 ? 100 : pct) / 100
  }

  setAmpVelocity(v127: number): void {
    this.ampVel01 = clamp01(v127 / 127)
  }

  setLfoWave(w: number): void {
    this.lfo.setWave(w)
  }

  /** Base LFO rate in Hz (engine maps knob / BPM sync). */
  setLfoFreq(hz: number): void {
    this.lfoBaseHz = Number.isFinite(hz) && hz > 0 ? hz : 0
    this.lastRateEg = NaN // force re-push on the next tick
  }

  /** LFO INT 0..1 (unipolar on the OG; curves.lfoIntTo01). */
  setLfoInt(i01: number): void {
    this.lfoInt01 = clamp01(i01)
  }

  setLfoTarget(t: number): void {
    this.lfoTarget = t | 0
  }

  /** EG MOD switch: 0 OFF, 1 RATE, 2 INT. */
  setLfoEgMod(m: number): void {
    this.lfoEgMod = m | 0
    this.lastRateEg = NaN
  }

  setLfoKeySync(on: boolean): void {
    this.lfoKeySync = on
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

  /** Per-voice detune (unison spread / duo stack), in cents. */
  setDetuneCents(c: number): void {
    if (Number.isFinite(c)) this.detuneCents = c
  }

  /** Per-voice output gain (MONO sub levels / SIDE CHAIN ducking). */
  setVoiceGain(g: number): void {
    if (Number.isFinite(g)) this.voiceGain = g < 0 ? 0 : g > 1 ? 1 : g
  }

  /* --------------------------------------------------------------- tick -- */

  /**
   * Idle tick: analog VCO drift and the free-running LFO keep evolving while
   * the voice is silent (family behavior; see xd voice).
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
    // Modulators. EG MOD = RATE sweeps the LFO speed with the EG (spec §8);
    // the exponent is quantized to ~1/64 EG steps so setFreq (a divide) runs
    // only when the sweep actually moves.
    const egV = this.modEg.tick()
    if (this.lfoEgMod === EM_RATE) {
      const q = (egV * 64 + 0.5) | 0
      if (q !== this.lastRateEg) {
        this.lastRateEg = q
        this.lfo.setFreq(this.lfoBaseHz * pow2(EG_LFO_RATE_OCTAVES * (q / 64)))
      }
    } else if (this.lastRateEg !== -1) {
      this.lastRateEg = -1
      this.lfo.setFreq(this.lfoBaseHz)
    }
    const drift1C = this.drift1.tick()
    const drift2C = this.drift2.tick()
    const lfoV = this.lfo.tick()
    const ampV = this.ampEg.tick()

    // Effective LFO intensity: EG MOD = INT rides the depth with the EG.
    const lfoAmt = this.lfoEgMod === EM_INT ? this.lfoInt01 * egV : this.lfoInt01

    // Portamento glide in log2-frequency domain (one-pole).
    let lg = this.curLog
    if (lg !== this.targetLog) {
      lg += this.glideCoef * (this.targetLog - lg)
      const d = this.targetLog - lg
      if (d < 1e-7 && d > -1e-7) lg = this.targetLog
      this.curLog = lg
    }
    const baseHz = pow2(lg) * this.bendMult

    // EG -> VCO2 pitch only (PITCH EG INT, spec §4/§7).
    const egPitch2 = this.pitchEgCents * egV

    // LFO -> PITCH hits both VCOs (no target-osc menu on the OG).
    const lfoPitch = this.lfoTarget === LT_PITCH ? lfoAmt * LFO_MAX_PITCH_CENTS * lfoV : 0

    const det = this.detuneCents
    const f1 = baseHz * this.oct1 * pow2((this.pitch1Cents + det + drift1C + lfoPitch) * CENT)
    const f2 = baseHz * this.oct2 * pow2((this.pitch2Cents + det + drift2C + egPitch2 + lfoPitch) * CENT)

    // LFO -> SHAPE on both VCOs.
    const lfoShape = this.lfoTarget === LT_SHAPE ? lfoAmt * LFO_MAX_SHAPE * lfoV : 0
    this.vco1.setShape(clamp01(this.shape1 + lfoShape))
    this.vco2.setShape(clamp01(this.shape2 + lfoShape))

    // VCO1, then SYNC + CROSS MOD (previous-sample VCO1 out as FM source).
    this.vco1.setFreq(f1)
    const o1 = this.vco1.tick(0)
    this.vco2.setFreq(f2)
    if (this.sync && this.vco1.wrapped) this.vco2.hardSync(this.vco1.wrapFrac)
    const fmHz = this.xmod2 === 0 ? 0 : this.xmod2 * this.prevV1 * f2 * XMOD_SCALE
    const o2 = this.vco2.tick(fmHz)
    this.prevV1 = o1

    const oN = this.noise.tick()

    // Mixer (~2 ms level smoothing). RING replaces the VCO2 channel.
    const lc = this.levelCoef
    this.lvl1 += lc * (this.lvl1T - this.lvl1)
    this.lvl2 += lc * (this.lvl2T - this.lvl2)
    this.lvlN += lc * (this.lvlNT - this.lvlN)
    const ch2 = this.ring ? o1 * o2 * RING_GAIN : o2
    const x = this.lvl1 * o1 + this.lvl2 * ch2 + this.lvlN * oN

    // Filter: keytrack (centered C4) x EG x LFO, exponents summed -> one pow.
    // CUTOFF VELOCITY blends the EG->cutoff amount toward the velocity.
    const velScale = 1 + (this.vel01 - 1) * this.cutVel01
    const egOct = this.egIntPct01 * EG_MAX_CUTOFF_OCTAVES * egV * velScale
    const lfoOct = this.lfoTarget === LT_CUTOFF ? lfoAmt * LFO_MAX_CUTOFF_OCTAVES * lfoV : 0
    let fc = this.cutoffHz * pow2(this.ktAmt * (this._note - 60) / 12 + egOct + lfoOct)
    if (!(fc >= MIN_CUTOFF)) fc = MIN_CUTOFF // also catches NaN
    else if (fc > this.maxFreq) fc = this.maxFreq
    this.filter.setCutoff(fc)
    const y = this.filter.tick(x)

    if (this.tapOn) {
      this.tapV1 = o1
      this.tapV2 = ch2
      this.tapM = oN
      this.tapMix = x
      this.tapFilt = y
      this.lastDrift1 = drift1C
      this.lastDrift2 = drift2C
      this.lastAmp = ampV
      this.lastModEg = egV
      this.lastLfo = lfoV
      this.lastHz = baseHz
    }

    // VCA: amp EG x amp velocity (0 = velocity ignored) x voice gain.
    const ampVelGain = 1 + (this.vel01 - 1) * this.ampVel01
    let out = y * ampV * ampVelGain * this.voiceGain
    if (!Number.isFinite(out)) out = 0
    else if (out > -1e-18 && out < 1e-18) out = 0 // flush denormals
    if (this.tapOn) this.tapVca = out
    return out
  }
}
