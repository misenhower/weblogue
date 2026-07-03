/*
 * SvfFilter — 'logue-family analog lowpass filter model.
 *
 * Resonant lowpass built on the Zavalishin TPT (topology-preserving
 * transform / trapezoidal) state-variable filter, voiced per synth by an
 * SvfCfg record (the xd's voicing lives in synths/xd/curves.ts):
 *
 *  - OTA-style nonlinearity: the bandpass state (the resonance feedback
 *    signal) is soft-limited with a tanh shaper each step, so high resonance
 *    compresses musically and self-oscillation stays bounded instead of
 *    blowing up or clipping harshly.
 *  - Bass compensation: a touch of the (driven, saturated) input is mixed
 *    back into the output proportional to resonance (cfg.bassComp), and/or
 *    resonance-proportional level LOSS (cfg.resLoss) for designs like the
 *    original minilogue whose feedback path audibly guts level/low end.
 *  - Optional stepped DRIVE: input gain stages into a tanh saturator feeding
 *    the filter, with output makeup gain (cfg.driveGains/driveMakeups; null
 *    for synths without a drive stage).
 *  - 2-pole (12 dB/oct) or 4-pole (24 dB/oct): a second critically-damped
 *    SVF stage cascades after the resonant stage; runtime-switchable
 *    (setPoles) with a smoothed crossfade so the panel switch doesn't click.
 *  - 2x internal oversampling (linear-interpolation upsample, averaging
 *    decimation) so drive + resonance nonlinearities don't alias badly.
 *  - Zipper-free parameter changes: cutoff/resonance smoothed with a ~3 ms
 *    one-pole, drive gain/makeup with a ~5 ms one-pole.
 *
 * Plain TS class: no DOM, no worklet globals, no allocation in the audio
 * path. Per-sample entry point is tick(); reset() clears state and snaps
 * smoothers to their targets.
 */

/** Per-synth filter voicing. */
export interface SvfCfg {
  /** Damping k = kMin + (kMax - kMin) * (1-r)^resCurve. kMax 2 = critically
   *  damped at r=0; kMin sets how hard r=1 rings (0 = self-oscillation). */
  kMax: number
  kMin: number
  resCurve: number
  /** Stepped drive: input gains + output makeups per position; null = none. */
  driveGains: readonly number[] | null
  driveMakeups: readonly number[] | null
  /** Soft-limit level for the bandpass (resonance feedback) state. */
  satLevel: number
  /** Dry (saturated) input mixed into the output at full resonance. */
  bassComp: number
  /** Output level LOSS at full resonance (0..1) — the OG's res-vs-bass tradeoff. */
  resLoss: number
  /** Default pole count (2 or 4); runtime-switchable via setPoles(). */
  poles: 2 | 4
}

/** State safety clamp and denormal flush threshold. */
const STATE_CLAMP = 8
const DENORMAL_EPS = 1e-15

const MIN_CUTOFF_HZ = 10

/** Critically-damped k for the non-resonant second (4-pole) stage. */
const STAGE2_K = 2

/**
 * Fast tanh: 3rd/2nd-order Padé approximant, input clamped to +-3 where the
 * approximant hits exactly +-1 with zero slope (C1-continuous). Monotonic,
 * odd, max error < 1% over the audio range — plenty for an OTA model.
 */
function fastTanh(x: number): number {
  const t = x < -3 ? -3 : x > 3 ? 3 : x
  const t2 = t * t
  return (t * (27 + t2)) / (27 + 9 * t2)
}

export class SvfFilter {
  private readonly cfg: SvfCfg
  private readonly maxCutoff: number
  /** pi / (2*fs): cutoff-to-g prewarp factor at the 2x oversampled rate. */
  private readonly piOver2Fs: number
  /** One-pole smoothing coefficients (~3 ms params, ~5 ms drive). */
  private readonly aParam: number
  private readonly aDrive: number

  // --- parameter targets ---
  private fcTarget: number
  private resTarget = 0
  private kTarget: number
  private driveGainTarget = 1
  private makeupTarget = 1
  private mix4Target = 0 // 0 = 2-pole, 1 = 4-pole

  // --- smoothed parameter values ---
  private fcSm: number
  private resSm = 0
  private kSm: number
  private driveGainSm = 1
  private makeupSm = 1
  private mix4Sm = 0

  // --- filter state (TPT SVF integrator states, at the 2x rate) ---
  private ic1 = 0 // stage 1 bandpass integrator state
  private ic2 = 0 // stage 1 lowpass integrator state
  private ic3 = 0 // stage 2 bandpass integrator state (4-pole)
  private ic4 = 0 // stage 2 lowpass integrator state (4-pole)
  /** Previous input sample, for linear-interpolation upsampling. */
  private prevX = 0

  constructor(sampleRate: number, cfg: SvfCfg) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) sampleRate = 48000
    this.cfg = cfg
    this.maxCutoff = sampleRate * 0.45
    this.piOver2Fs = Math.PI / (2 * sampleRate)
    this.aParam = 1 - Math.exp(-1 / (0.003 * sampleRate))
    this.aDrive = 1 - Math.exp(-1 / (0.005 * sampleRate))
    this.fcTarget = Math.min(1000, this.maxCutoff)
    this.fcSm = this.fcTarget
    this.kTarget = cfg.kMax
    this.kSm = cfg.kMax
    this.mix4Target = cfg.poles === 4 ? 1 : 0
    this.mix4Sm = this.mix4Target
  }

  /** Cutoff in Hz, clamped to [10, 0.45*fs]. Smoothed internally (~3 ms). */
  setCutoff(hz: number): void {
    if (!Number.isFinite(hz)) return
    this.fcTarget = hz < MIN_CUTOFF_HZ ? MIN_CUTOFF_HZ : hz > this.maxCutoff ? this.maxCutoff : hz
  }

  /** Resonance 0..1. Behavior at 1 depends on the cfg's kMin. */
  setResonance(r: number): void {
    if (!Number.isFinite(r)) return
    const res = r < 0 ? 0 : r > 1 ? 1 : r
    this.resTarget = res
    const c = this.cfg
    this.kTarget = c.kMin + (c.kMax - c.kMin) * Math.pow(1 - res, c.resCurve)
  }

  /** DRIVE position index into the cfg's gain tables (no-op without drive). */
  setDrive(d: number): void {
    if (!Number.isFinite(d)) return
    const gains = this.cfg.driveGains
    const makeups = this.cfg.driveMakeups
    if (!gains || !makeups || gains.length === 0) return
    let pos = Math.round(d)
    if (pos < 0) pos = 0
    if (pos >= gains.length) pos = gains.length - 1
    this.driveGainTarget = gains[pos]
    this.makeupTarget = makeups[pos] ?? 1
  }

  /** Pole count: 2 (12 dB/oct) or 4 (24 dB/oct); crossfaded, click-free. */
  setPoles(p: number): void {
    this.mix4Target = p >= 3 ? 1 : 0
  }

  /** Process one sample at the base sample rate (2x oversampled inside). */
  tick(x: number): number {
    if (!Number.isFinite(x)) x = 0

    // Parameter smoothing (one sample of the base rate).
    const aP = this.aParam
    const aD = this.aDrive
    this.fcSm += aP * (this.fcTarget - this.fcSm)
    this.kSm += aP * (this.kTarget - this.kSm)
    this.resSm += aP * (this.resTarget - this.resSm)
    this.driveGainSm += aD * (this.driveGainTarget - this.driveGainSm)
    this.makeupSm += aD * (this.makeupTarget - this.makeupSm)
    this.mix4Sm += aP * (this.mix4Target - this.mix4Sm)

    // Snap + idle the second stage when fully faded back to 2-pole.
    let mix4 = this.mix4Sm
    if (this.mix4Target === 0 && mix4 < 1e-4) {
      mix4 = 0
      this.mix4Sm = 0
      this.ic3 = 0
      this.ic4 = 0
    } else if (this.mix4Target === 1 && mix4 > 1 - 1e-4) {
      mix4 = 1
      this.mix4Sm = 1
    }

    // TPT coefficients at the 2x oversampled rate. fc <= 0.45*fs means the
    // prewarp argument stays <= 0.225*pi, so g is well-behaved (< 0.86).
    const g = Math.tan(this.fcSm * this.piOver2Fs)
    const k = this.kSm
    const d = 1 / (1 + g * (g + k))
    const comp = this.cfg.bassComp * this.resSm
    const dg = this.driveGainSm

    // 2x upsample: midpoint by linear interpolation, then the sample itself.
    const xMid = 0.5 * (this.prevX + x)
    this.prevX = x

    const y0 = this.step(xMid, g, k, d, dg, comp, mix4)
    const y1 = this.step(x, g, k, d, dg, comp, mix4)

    // State housekeeping: NaN/Inf guard, safety clamp, denormal flush.
    let i1 = this.ic1
    let i2 = this.ic2
    if (!Number.isFinite(i1) || !Number.isFinite(i2)) {
      i1 = 0
      i2 = 0
    } else {
      if (i1 > STATE_CLAMP) i1 = STATE_CLAMP
      else if (i1 < -STATE_CLAMP) i1 = -STATE_CLAMP
      else if (i1 < DENORMAL_EPS && i1 > -DENORMAL_EPS) i1 = 0
      if (i2 > STATE_CLAMP) i2 = STATE_CLAMP
      else if (i2 < -STATE_CLAMP) i2 = -STATE_CLAMP
      else if (i2 < DENORMAL_EPS && i2 > -DENORMAL_EPS) i2 = 0
    }
    this.ic1 = i1
    this.ic2 = i2
    if (mix4 > 0) {
      let i3 = this.ic3
      let i4 = this.ic4
      if (!Number.isFinite(i3) || !Number.isFinite(i4)) {
        i3 = 0
        i4 = 0
      } else {
        if (i3 > STATE_CLAMP) i3 = STATE_CLAMP
        else if (i3 < -STATE_CLAMP) i3 = -STATE_CLAMP
        else if (i3 < DENORMAL_EPS && i3 > -DENORMAL_EPS) i3 = 0
        if (i4 > STATE_CLAMP) i4 = STATE_CLAMP
        else if (i4 < -STATE_CLAMP) i4 = -STATE_CLAMP
        else if (i4 < DENORMAL_EPS && i4 > -DENORMAL_EPS) i4 = 0
      }
      this.ic3 = i3
      this.ic4 = i4
    }

    // Averaging decimation to the base rate, res-loss voicing, makeup gain.
    const loss = 1 - this.cfg.resLoss * this.resSm
    return 0.5 * (y0 + y1) * loss * this.makeupSm
  }

  /** One half-step of the nonlinear TPT SVF cascade at the 2x rate. */
  private step(xin: number, g: number, k: number, d: number, dg: number, comp: number, mix4: number): number {
    // Drive stage: gain into a tanh saturator feeding the filter.
    const xd = fastTanh(xin * dg)
    // Zero-delay-feedback solve (linear prediction of the bandpass output).
    const v1Lin = (this.ic1 + g * (xd - this.ic2)) * d
    // OTA-style soft limit on the resonance feedback signal.
    const sat = this.cfg.satLevel
    const v1 = sat * fastTanh(v1Lin / sat)
    const v2 = this.ic2 + g * v1
    // Trapezoidal integrator state updates.
    this.ic1 = 2 * v1 - this.ic1
    this.ic2 = 2 * v2 - this.ic2
    let y = v2
    if (mix4 > 0) {
      // Second stage: clean critically-damped 2-pole on the stage-1 output.
      const d2 = 1 / (1 + g * (g + STAGE2_K))
      const w1 = (this.ic3 + g * (v2 - this.ic4)) * d2
      const w2 = this.ic4 + g * w1
      this.ic3 = 2 * w1 - this.ic3
      this.ic4 = 2 * w2 - this.ic4
      y = v2 + (w2 - v2) * mix4
    }
    // Output plus resonance-proportional bass compensation.
    return y + comp * xd
  }

  /** Clear all state and snap parameter smoothers to their targets. */
  reset(): void {
    this.ic1 = 0
    this.ic2 = 0
    this.ic3 = 0
    this.ic4 = 0
    this.prevX = 0
    this.fcSm = this.fcTarget
    this.resSm = this.resTarget
    this.kSm = this.kTarget
    this.driveGainSm = this.driveGainTarget
    this.makeupSm = this.makeupTarget
    this.mix4Sm = this.mix4Target
  }
}
