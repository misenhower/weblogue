/*
 * Voice — one analog voice of the Korg prologue replica (spec §1/§3/§5/§6/§8).
 * The engine builds 16 of these (the prologue-8 variant caps allocation at 8;
 * spec §14) and tags each with a timbre — the voice itself is timbre-blind:
 * it just receives whichever timbre block's physical values the engine pushes.
 *
 * Owns: VCO1 + VCO2 (Vco), digital MULTI ENGINE (identical to the xd's,
 * spec §6), VCF (SvfFilter, PROLOGUE_FILTER_CFG, fixed 2-pole) + the LOW CUT
 * one-pole HPF, AMP EG + the shared mod EG (both FULL AdsrEg — the prologue
 * has two complete ADSRs, spec §5), LFO and per-VCO analog Drift.
 *
 * Push model as in the xd voice: the Engine maps raw knob values to PHYSICAL
 * units once per param change; tick() only reads scalars. Per-sample path:
 *
 *   pitch = glide(noteFreq) * bend * drift * detune (+EG/LFO pitch cents)
 *   VCO1 -> [CROSS MOD fm + SYNC-or-RING (exclusive 3-way)] -> VCO2 ; MULTI
 *   mixer (smoothed levels) -> [multi pre] -> VCF -> [multi post]
 *   -> LOW CUT HPF -> VCA (amp EG * amp velocity * voiceGain)
 *
 * prologue specifics vs the xd voice:
 *  - the shared EG (mod EG) hits BOTH destinations simultaneously (spec §5):
 *    pitch per the PITCH EG switch [VCO 2, VCO 1+2, ALL(+multi)] scaled by
 *    PITCH EG INT (±4800c), AND cutoff ALWAYS via CUTOFF EG INT — there is
 *    no EG TARGET menu; EG Velocity scales only the cutoff tap (spec §5);
 *  - SYNC/RING is one exclusive 3-position switch (0=RING, 1=OFF, 2=SYNC —
 *    the monologue precedent) while the CROSS MOD knob stacks with either
 *    (spec §3);
 *  - LOW CUT [OFF, ON]: a gentle non-resonant one-pole HPF. The filter
 *    section's switch "trims lows" — placed after the VCF (including the
 *    post-VCF multi routing), before the VCA. UNCONFIRMED placement and
 *    corner (curves.LOW_CUT_HZ ~120 Hz, spec §17); the ON/OFF switch is
 *    crossfaded ~2 ms so it doesn't click;
 *  - LFO modes are BPM/SLOW/FAST with no 1-shot (spec §8): the engine pushes
 *    the per-mode Hz; FAST is true audio rate, so the Lfo is built with a
 *    2.8 kHz ceiling and a short slew like the monologue's (UNCONFIRMED slew);
 *  - the voice output stays MONO: VOICE SPREAD pan and the timbre buses live
 *    in the engine's sum stage (spec §13).
 *
 * SERVICE MODE taps: the xd layout (tapM = multi engine).
 */
import { Vco } from '../../dsp/osc'
import { MultiEngine, type VpmTrims } from '../../dsp/multiengine'
import { SvfFilter } from '../../dsp/filter'
import { AdsrEg } from '../../dsp/eg'
import { Lfo, LFO_MODE } from '../../dsp/lfo'
import { Drift } from '../../dsp/drift'
import {
  PROLOGUE_FILTER_CFG,
  LOW_CUT_HZ,
  EG_MAX_CUTOFF_OCTAVES,
  LFO_MAX_PITCH_CENTS,
  LFO_MAX_CUTOFF_OCTAVES,
  LFO_MAX_SHAPE,
} from './curves'

/** PITCH EG switch values (params.ts order, spec §3): VCO 2, VCO 1+2, ALL. */
const PT_VCO2 = 0
const PT_VCO12 = 1
const PT_ALL = 2

/** SYNC/RING exclusive switch values (timbre byte +25): RING, OFF, SYNC. */
const SR_RING = 0
const SR_SYNC = 2

/** LFO TARGET values: CUTOFF, SHAPE, PITCH. */
const LT_CUTOFF = 0
const LT_SHAPE = 1
const LT_PITCH = 2

/** LFO Target OSC menu: All, VCO1+2, VCO2, Multi. */
const TO_ALL = 0
const TO_VCO12 = 1
const TO_VCO2 = 2
const TO_MULTI = 3

/** FAST mode tops out at 2.8 kHz — true audio rate (spec §8). */
const LFO_MAX_HZ = 2800
/** Short slew so FAST squares stay square (monologue precedent; UNCONFIRMED). */
const LFO_SLEW_SEC = 0.0003

const RING_GAIN = 1.4 // UNCONFIRMED (family value, as in the xd voice)
const XMOD_SCALE = 3 // UNCONFIRMED (xd value)
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
  private readonly filter: SvfFilter
  private readonly ampEg: AdsrEg
  /** The shared mod EG — a second FULL ADSR (spec §5). */
  private readonly modEg: AdsrEg
  private readonly lfo: Lfo
  // Independent per-VCO drift (two physical analog oscillators); the digital
  // MULTI engine is deliberately drift-free.
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

  // --- filter / LOW CUT state ---
  private cutoffHz = 21000
  private ktAmt = 0
  private readonly lcCoef: number // LOW CUT one-pole coefficient
  private lcLp = 0 // LOW CUT lowpass state (hp = x - lp)
  private lcT = 0 // LOW CUT switch target (0/1)
  private lcMix = 0 // smoothed ~2 ms so the switch doesn't click

  // --- EG / velocity state ---
  private pitchEgCents = 0 // PITCH EG INT, mapped cents at full envelope
  private pitchEgTarget = PT_VCO2
  private cutoffEgInt01 = 0 // CUTOFF EG INT -1..1 (always active, spec §5)
  private egVel01 = 0 // EG (cutoff) Velocity menu /127
  private ampVel01 = 0.5 // Amp Velocity (program-global) /127
  private vel01 = 1

  // --- LFO state ---
  private lfoInt01 = 0 // -1..1 (bipolar center-512 store, spec §8)
  private lfoTarget = LT_PITCH
  private lfoTargetOsc = TO_ALL
  private lfoKeySync = false

  private voiceGain = 1

  constructor(sampleRate: number, voiceIndex: number) {
    const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
    this.sr = sr
    this.maxFreq = sr * 0.45
    this.levelCoef = 1 - Math.exp(-1 / (0.002 * sr))
    this.lcCoef = 1 - Math.exp((-2 * Math.PI * LOW_CUT_HZ) / sr)
    this.vco1 = new Vco(sr)
    this.vco2 = new Vco(sr)
    this.multi = new MultiEngine(sr)
    this.filter = new SvfFilter(sr, PROLOGUE_FILTER_CFG)
    this.ampEg = new AdsrEg(sr)
    this.modEg = new AdsrEg(sr)
    this.lfo = new Lfo(sr, LFO_MAX_HZ, LFO_SLEW_SEC)
    const vi = (voiceIndex | 0) + 1
    this.drift1 = new Drift(sr, vi * 2 * 0x9e3779b9)
    this.drift2 = new Drift(sr, (vi * 2 + 1) * 0x9e3779b9)
  }

  /* ------------------------------------------------------------- events -- */

  /**
   * Start / restart the note. retrigger=false is the legato path (the MONO
   * LEGATO menu): envelopes continue from their level, oscillator/multi
   * phases and drift untouched. glide=true approaches freqHz through the
   * portamento one-pole; otherwise the pitch snaps. Envelope restarts are
   * from the CURRENT level (family behavior; steal-kill approximates the
   * reported restart-from-zero quirk — implementation-notes.md).
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
      this.drift1.noteOn()
      this.drift2.noteOn()
      if (this.lfoKeySync) this.lfo.trigger() // no 1-shot on the prologue
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
    this.modEg.gateOff() // full ADSR: the shared EG has a real release
  }

  /** Fast-fade for voice stealing; the engine restarts the voice next block. */
  kill(): void {
    this.ampEg.kill()
  }

  /**
   * SERVICE MODE taps (xd ring layout): when tapOn, tick() stores its
   * intermediate stages and modulator values here for the debug panel.
   * Off = zero overhead beyond one predictable branch per sample.
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

  /** Octave as a frequency multiplier (engine maps the prologue's reversed
   *  2'->16' enum; 8' = 1). */
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

  /** SYNC/RING exclusive 3-position switch (spec §3): 0=RING, 1=OFF, 2=SYNC
   *  — never both; the CROSS MOD knob stacks with either. */
  setSyncRing(mode: number): void {
    const m = Math.round(mode)
    this.ring = m === SR_RING
    this.sync = m === SR_SYNC
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

  /** LOW CUT switch (spec §3): gentle non-resonant HPF post-VCF. */
  setLowCut(on: boolean): void {
    this.lcT = on ? 1 : 0
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

  /** The shared EG's full ADSR (spec §5 — a second complete envelope). */
  setModEg(attackSec: number, decaySec: number, sustain01: number, releaseSec: number): void {
    this.modEg.setAttack(attackSec)
    this.modEg.setDecay(decaySec)
    this.modEg.setSustain(sustain01)
    this.modEg.setRelease(releaseSec)
  }

  /** CUTOFF EG INT as percent -100..100 (curves.egIntToPercent) — the EG's
   *  ALWAYS-connected cutoff tap (spec §5). */
  setCutoffEgInt(pct: number): void {
    this.cutoffEgInt01 = (pct < -100 ? -100 : pct > 100 ? 100 : pct) / 100
  }

  /** PITCH EG switch (spec §3): 0=VCO 2, 1=VCO 1+2, 2=ALL(+multi). */
  setPitchEgTarget(t: number): void {
    this.pitchEgTarget = Math.round(t)
  }

  /** PITCH EG INT in mapped cents ±4800 (curves.pitchEgIntToCents). */
  setPitchEgCents(c: number): void {
    if (Number.isFinite(c)) this.pitchEgCents = c
  }

  /** EG Velocity (hardware CUTOFF VELOCITY): scales the cutoff tap only. */
  setEgVelocity(v127: number): void {
    this.egVel01 = clamp01(v127 / 127)
  }

  setAmpVelocity(v127: number): void {
    this.ampVel01 = clamp01(v127 / 127)
  }

  setLfoWave(w: number): void {
    this.lfo.setWave(w)
  }

  setLfoFreq(hz: number): void {
    this.lfo.setFreq(Number.isFinite(hz) && hz > 0 ? hz : 0)
  }

  /** LFO INT as -1..1 (curves.lfoIntTo01). */
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

  /** Per-voice output gain (duo stack / MONO sub-voice level). The timbre
   *  balance/XFADE weight and VOICE SPREAD pan are the ENGINE sum stage's
   *  business (spec §13), not this gain. */
  setVoiceGain(g: number): void {
    if (Number.isFinite(g)) this.voiceGain = g < 0 ? 0 : g > 1 ? 1 : g
  }

  /* --------------------------------------------------------------- tick -- */

  /**
   * Idle tick: the hardware's analog VCOs free-run, so their drift keeps
   * evolving while the voice is silent; the LFO free-runs too so a
   * non-key-synced note starts wherever the LFO genuinely is.
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
    const drift1C = this.drift1.tick()
    const drift2C = this.drift2.tick()
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

    // EG -> pitch per the PITCH EG switch (spec §5): every position includes
    // VCO2; VCO 1+2 adds VCO1; ALL adds VCO1 + the multi engine.
    const pt = this.pitchEgTarget
    const egPitch = this.pitchEgCents * egV
    const eg1 = pt >= PT_VCO12 ? egPitch : 0
    const eg2 = egPitch
    const egM = pt === PT_ALL ? egPitch : 0

    // LFO pitch routed by Target OSC (spec §8).
    const to = this.lfoTargetOsc
    const lfoPitch = this.lfoTarget === LT_PITCH ? this.lfoInt01 * LFO_MAX_PITCH_CENTS * lfoV : 0
    const lp1 = to === TO_ALL || to === TO_VCO12 ? lfoPitch : 0
    const lp2 = to !== TO_MULTI ? lfoPitch : 0
    const lpM = to === TO_ALL || to === TO_MULTI ? lfoPitch : 0

    const det = this.detuneCents
    const f1 = baseHz * this.oct1 * pow2((this.pitch1Cents + det + drift1C + eg1 + lp1) * CENT)
    const f2 = baseHz * this.oct2 * pow2((this.pitch2Cents + det + drift2C + eg2 + lp2) * CENT)
    const fM = baseHz * this.octM * pow2((det + egM + lpM) * CENT) // digital: no drift

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
    // The EG's cutoff tap is ALWAYS connected (spec §5), scaled by EG Velocity.
    const velScale = 1 + (this.vel01 - 1) * this.egVel01 // blends 1 -> vel
    const egOct = this.cutoffEgInt01 * EG_MAX_CUTOFF_OCTAVES * egV * velScale
    const lfoOct = this.lfoTarget === LT_CUTOFF ? this.lfoInt01 * LFO_MAX_CUTOFF_OCTAVES * lfoV : 0
    let fc = this.cutoffHz * pow2((this.ktAmt * (this._note - 60)) / 12 + egOct + lfoOct)
    if (!(fc >= MIN_CUTOFF)) fc = MIN_CUTOFF // also catches NaN
    else if (fc > this.maxFreq) fc = this.maxFreq
    this.filter.setCutoff(fc)
    let y = this.filter.tick(x)
    if (this.multiPost) y += this.lvlM * oM // Post VCF: multi bypasses filter

    // LOW CUT: one-pole HPF after the VCF, before the VCA (UNCONFIRMED
    // placement/corner, spec §17); the switch crossfades ~2 ms.
    this.lcMix += lc * (this.lcT - this.lcMix)
    this.lcLp += this.lcCoef * (y - this.lcLp)
    y -= this.lcMix * this.lcLp

    if (this.tapOn) {
      this.tapV1 = o1
      this.tapV2 = ch2
      this.tapM = oM
      this.tapMix = x
      this.tapFilt = y // post-VCF incl. LOW CUT (the filter section's output)
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
