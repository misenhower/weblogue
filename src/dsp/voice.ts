/*
 * Voice — one analog voice of the minilogue xd replica (spec §1/§4/§7/§8/§9).
 *
 * Owns: VCO1 + VCO2 (Vco), MULTI ENGINE, VCF (XdFilter), AMP EG (AdsrEg),
 * MOD EG (AdEg), LFO and analog Drift. Plain TS, sampleRate + voiceIndex
 * (drift seed) constructor args. No allocation in the audio path.
 *
 * Push model: the Engine maps raw knob values to PHYSICAL units once per
 * param change and pushes them here through the setters; tick() only reads
 * scalars. Per-sample signal path:
 *
 *   pitch = glide(noteFreq) * bend * drift * detune (+EG/LFO pitch cents)
 *   VCO1 -> [CROSS MOD fm / SYNC / RING] -> VCO2 ; MULTI
 *   mixer (smoothed levels) -> [multi pre] -> VCF (keytrack/EG/LFO cutoff)
 *   -> [multi post] -> VCA (amp EG * amp velocity * voiceGain)
 */
import { Vco } from './osc'
import { MultiEngine, type VpmTrims } from './multiengine'
import { XdFilter } from './filter'
import { AdsrEg, AdEg } from './eg'
import { Lfo, LFO_MODE } from './lfo'
import { Drift } from './drift'
import {
  EG_MAX_PITCH_CENTS,
  EG_MAX_CUTOFF_OCTAVES,
  LFO_MAX_PITCH_CENTS,
  LFO_MAX_CUTOFF_OCTAVES,
  LFO_MAX_SHAPE,
} from '../shared/maps'

/** EG TARGET values (params.ts order): CUTOFF, PITCH 2, PITCH. */
const EGT_CUTOFF = 0
const EGT_PITCH2 = 1
const EGT_PITCH = 2

/** LFO TARGET values: CUTOFF, SHAPE, PITCH. */
const LT_CUTOFF = 0
const LT_SHAPE = 1
const LT_PITCH = 2

/** LFO Target OSC menu: All, VCO1+2, VCO2, Multi. */
const TO_ALL = 0
const TO_VCO12 = 1
const TO_VCO2 = 2
const TO_MULTI = 3

const RING_GAIN = 1.4
const XMOD_SCALE = 3
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
  private readonly multi: MultiEngine
  private readonly filter: XdFilter
  private readonly ampEg: AdsrEg
  private readonly modEg: AdEg
  private readonly lfo: Lfo
  private readonly drift: Drift

  // --- pitch state ---
  private _note = 60 // semitone used for filter keytrack
  private targetLog = Math.log2(440)
  private curLog = Math.log2(440)
  private glideCoef = 1 // 1 = snap
  private bendMult = 1
  private detuneCents = 0 // unison/duo stack offset
  private oct1 = 1
  private oct2 = 1
  private octM = 1
  private pitch1Cents = 0
  private pitch2Cents = 0

  // --- osc/mixer state ---
  private shape1 = 0
  private shape2 = 0
  private shapeM = 0.5
  private sync = false
  private ring = false
  private xmod2 = 0 // xmod01^2, precomputed
  private prevV1 = 0 // previous-sample VCO1 output (cross-mod source)
  private lvl1T = 1
  private lvl2T = 0
  private lvlMT = 0
  private lvl1 = 1
  private lvl2 = 0
  private lvlM = 0
  private multiPost = false

  // --- filter state ---
  private cutoffHz = 21000
  private ktAmt = 0

  // --- EG / velocity state ---
  private egIntPct01 = 0 // -1..1
  private egTarget = EGT_CUTOFF
  private egVel01 = 0 // EG Velocity menu /127
  private ampVel01 = 0.5 // Amp Velocity menu /127
  private vel01 = 1

  // --- LFO state ---
  private lfoInt01 = 0 // -1..1
  private lfoTarget = LT_PITCH
  private lfoTargetOsc = TO_ALL
  private lfoKeySync = false
  private lfoMode: number = LFO_MODE.NORMAL

  private voiceGain = 1

  constructor(sampleRate: number, voiceIndex: number) {
    const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
    this.sr = sr
    this.maxFreq = sr * 0.45
    this.levelCoef = 1 - Math.exp(-1 / (0.002 * sr))
    this.vco1 = new Vco(sr)
    this.vco2 = new Vco(sr)
    this.multi = new MultiEngine(sr)
    this.filter = new XdFilter(sr)
    this.ampEg = new AdsrEg(sr)
    this.modEg = new AdEg(sr)
    this.lfo = new Lfo(sr)
    this.drift = new Drift(sr, ((voiceIndex | 0) + 1) * 0x9e3779b9)
  }

  /* ------------------------------------------------------------- events -- */

  /**
   * Start / restart the note. retrigger=false is the legato path (EG LEGATO):
   * envelopes continue, oscillator/multi phases and drift are untouched.
   * glide=true approaches freqHz through the portamento one-pole; otherwise
   * the pitch snaps.
   */
  noteOn(note: number, freqHz: number, vel: number, retrigger: boolean, glide: boolean): void {
    this._note = note
    const v = vel < 1 ? 1 : vel > 127 ? 127 : vel
    this.vel01 = v / 127
    this.setPitchTarget(freqHz, glide)
    this.ampEg.gateOn(retrigger)
    this.modEg.gateOn(retrigger)
    if (retrigger) {
      this.multi.noteOn()
      this.drift.noteOn()
      if (this.lfoKeySync || this.lfoMode === LFO_MODE.ONE_SHOT) this.lfo.trigger()
    }
  }

  /** Live retune (transpose/tuning change or mono glide retarget), no gating. */
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
    this.modEg.gateOff() // documented no-op (AD EG always completes)
  }

  /** Fast-fade for voice stealing; the engine restarts the voice next block. */
  kill(): void {
    this.ampEg.kill()
  }

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

  setMultiType(t: number): void {
    this.multi.setType(t)
  }

  setMultiSub(s: number): void {
    this.multi.setSubType(s)
  }

  setMultiOctave(mult: number): void {
    this.octM = mult
  }

  setMultiShape(s01: number): void {
    this.shapeM = clamp01(s01)
  }

  setMultiShiftShape(s01: number): void {
    this.multi.setShiftShape(s01)
  }

  /** VPM menu trims, each -1..+1 (0 = neutral); VPM mode only. */
  setVpmTrims(t: VpmTrims): void {
    this.multi.setVpmTrims(t)
  }

  setMultiLevel(l01: number): void {
    this.lvlMT = clamp01(l01)
  }

  setMultiRoutingPost(post: boolean): void {
    this.multiPost = post
  }

  setCutoff(hz: number): void {
    this.cutoffHz = hz
  }

  setResonance(r01: number): void {
    this.filter.setResonance(r01)
  }

  setDrive(pos: number): void {
    this.filter.setDrive(pos)
  }

  setKeytrack(amt01: number): void {
    this.ktAmt = amt01
  }

  setAmpEg(attackSec: number, decaySec: number, sustain01: number, releaseSec: number): void {
    this.ampEg.setAttack(attackSec)
    this.ampEg.setDecay(decaySec)
    this.ampEg.setSustain(sustain01)
    this.ampEg.setRelease(releaseSec)
  }

  setModEgTimes(attackSec: number, decaySec: number): void {
    this.modEg.setAttack(attackSec)
    this.modEg.setDecay(decaySec)
  }

  /** EG INT as percent -100..100 (maps.egIntToPercent). */
  setEgInt(pct: number): void {
    this.egIntPct01 = (pct < -100 ? -100 : pct > 100 ? 100 : pct) / 100
  }

  setEgTarget(t: number): void {
    this.egTarget = t | 0
  }

  setEgVelocity(v127: number): void {
    this.egVel01 = clamp01(v127 / 127)
  }

  setAmpVelocity(v127: number): void {
    this.ampVel01 = clamp01(v127 / 127)
  }

  setLfoWave(w: number): void {
    this.lfo.setWave(w)
  }

  setLfoMode(m: number): void {
    this.lfoMode = m | 0
    this.lfo.setMode(m)
  }

  setLfoFreq(hz: number): void {
    this.lfo.setFreq(hz)
  }

  /** LFO INT as -1..1 (maps.lfoIntTo01). */
  setLfoInt(i01: number): void {
    this.lfoInt01 = i01 < -1 ? -1 : i01 > 1 ? 1 : i01
  }

  setLfoTarget(t: number): void {
    this.lfoTarget = t | 0
  }

  setLfoTargetOsc(o: number): void {
    this.lfoTargetOsc = o | 0
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

  /** Per-voice output gain (duo stacked-voice level). */
  setVoiceGain(g: number): void {
    if (Number.isFinite(g)) this.voiceGain = g < 0 ? 0 : g > 1 ? 1 : g
  }

  /* --------------------------------------------------------------- tick -- */

  tick(): number {
    // Modulators.
    const driftC = this.drift.tick()
    const lfoV = this.lfo.tick()
    const egV = this.modEg.tick()
    const ampV = this.ampEg.tick()

    // Portamento glide in log2-frequency domain (one-pole).
    let lg = this.curLog
    if (lg !== this.targetLog) {
      lg += this.glideCoef * (this.targetLog - lg)
      const d = this.targetLog - lg
      if (d < 1e-7 && d > -1e-7) lg = this.targetLog
      this.curLog = lg
    }
    const baseHz = pow2(lg) * this.bendMult

    // EG pitch (spec §8): PITCH -> VCO1+VCO2+MULTI, PITCH 2 -> VCO2 only.
    const tgt = this.egTarget
    const egPitch = tgt === EGT_CUTOFF ? 0 : this.egIntPct01 * EG_MAX_PITCH_CENTS * egV
    const egAll = tgt === EGT_PITCH ? egPitch : 0
    const eg2 = tgt === EGT_CUTOFF ? 0 : egPitch

    // LFO pitch routed by Target OSC (spec §9).
    const to = this.lfoTargetOsc
    const lfoPitch = this.lfoTarget === LT_PITCH ? this.lfoInt01 * LFO_MAX_PITCH_CENTS * lfoV : 0
    const lp1 = to === TO_ALL || to === TO_VCO12 ? lfoPitch : 0
    const lp2 = to !== TO_MULTI ? lfoPitch : 0
    const lpM = to === TO_ALL || to === TO_MULTI ? lfoPitch : 0

    const det = this.detuneCents + driftC
    const f1 = baseHz * this.oct1 * pow2((this.pitch1Cents + det + egAll + lp1) * CENT)
    const f2 = baseHz * this.oct2 * pow2((this.pitch2Cents + det + eg2 + lp2) * CENT)
    const fM = baseHz * this.octM * pow2((det + egAll + lpM) * CENT)

    // LFO -> SHAPE on the routed oscillators only.
    const lfoShape = this.lfoTarget === LT_SHAPE ? this.lfoInt01 * LFO_MAX_SHAPE * lfoV : 0
    this.vco1.setShape(to === TO_ALL || to === TO_VCO12 ? clamp01(this.shape1 + lfoShape) : this.shape1)
    this.vco2.setShape(to !== TO_MULTI ? clamp01(this.shape2 + lfoShape) : this.shape2)
    this.multi.setShape(to === TO_ALL || to === TO_MULTI ? clamp01(this.shapeM + lfoShape) : this.shapeM)

    // VCO1, then SYNC + CROSS MOD (previous-sample VCO1 out as FM source).
    this.vco1.setFreq(f1)
    const o1 = this.vco1.tick(0)
    this.vco2.setFreq(f2)
    if (this.sync && this.vco1.wrapped) this.vco2.hardSync(this.vco1.wrapFrac)
    const fmHz = this.xmod2 === 0 ? 0 : this.xmod2 * this.prevV1 * f2 * XMOD_SCALE
    const o2 = this.vco2.tick(fmHz)
    this.prevV1 = o1

    this.multi.setFreq(fM)
    const oM = this.multi.tick()

    // Mixer (~2 ms level smoothing). RING replaces the VCO2 channel.
    const lc = this.levelCoef
    this.lvl1 += lc * (this.lvl1T - this.lvl1)
    this.lvl2 += lc * (this.lvl2T - this.lvl2)
    this.lvlM += lc * (this.lvlMT - this.lvlM)
    const ch2 = this.ring ? o1 * o2 * RING_GAIN : o2
    let x = this.lvl1 * o1 + this.lvl2 * ch2
    if (!this.multiPost) x += this.lvlM * oM

    // Filter: keytrack (centered C4) x EG x LFO, exponents summed -> one pow.
    const velScale = 1 + (this.vel01 - 1) * this.egVel01 // blends 1 -> vel
    const egOct = tgt === EGT_CUTOFF ? this.egIntPct01 * EG_MAX_CUTOFF_OCTAVES * egV * velScale : 0
    const lfoOct = this.lfoTarget === LT_CUTOFF ? this.lfoInt01 * LFO_MAX_CUTOFF_OCTAVES * lfoV : 0
    let fc = this.cutoffHz * pow2(this.ktAmt * (this._note - 60) / 12 + egOct + lfoOct)
    if (!(fc >= MIN_CUTOFF)) fc = MIN_CUTOFF // also catches NaN
    else if (fc > this.maxFreq) fc = this.maxFreq
    this.filter.setCutoff(fc)
    let y = this.filter.tick(x)
    if (this.multiPost) y += this.lvlM * oM // Post VCF: multi bypasses filter

    // VCA: amp EG x amp velocity (0 = velocity ignored) x voice gain.
    const ampVelGain = 1 + (this.vel01 - 1) * this.ampVel01
    let out = y * ampV * ampVelGain * this.voiceGain
    if (!Number.isFinite(out)) out = 0
    else if (out > -1e-18 && out < 1e-18) out = 0 // flush denormals
    return out
  }
}
