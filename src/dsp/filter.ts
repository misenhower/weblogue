/*
 * XdFilter — minilogue xd analog filter model.
 *
 * 2-pole (12 dB/oct) resonant lowpass built on the Zavalishin TPT
 * (topology-preserving transform / trapezoidal) state-variable filter, with:
 *
 *  - OTA-style nonlinearity: the bandpass state (the resonance feedback
 *    signal) is soft-limited with a tanh shaper each step, so high resonance
 *    compresses musically and self-oscillation stays bounded instead of
 *    blowing up or clipping harshly.
 *  - Bass compensation: a touch of the (driven, saturated) input is mixed
 *    back into the output proportional to resonance, like real OTA designs,
 *    so cranking resonance doesn't fully gut the low end.
 *  - 3-position DRIVE: input gain stages (~1x / ~2.6x / ~6x) into a tanh
 *    saturator feeding the filter, with output makeup gain (~1x / 0.7x /
 *    0.45x) so perceived loudness stays in the same ballpark.
 *  - 2x internal oversampling (linear-interpolation upsample, averaging
 *    decimation) so drive + resonance nonlinearities don't alias badly.
 *  - Zipper-free parameter changes: cutoff/resonance are smoothed with a
 *    ~3 ms one-pole, drive gain/makeup with a ~5 ms one-pole.
 *
 * Plain TS class: no DOM, no worklet globals, no allocation in the audio
 * path. Per-sample entry point is tick(); reset() clears state and snaps
 * smoothers to their targets.
 */

/** Input gain per DRIVE position (OFF / 50% / 100%). */
const DRIVE_GAIN_0 = 1.0
const DRIVE_GAIN_1 = 2.6
const DRIVE_GAIN_2 = 6.0

/** Output makeup gain per DRIVE position. */
const DRIVE_MAKEUP_0 = 1.0
const DRIVE_MAKEUP_1 = 0.7
const DRIVE_MAKEUP_2 = 0.45

/** Damping k = 1/Q mapping: k = K_MIN + (K_MAX - K_MIN) * (1-r)^RES_CURVE. */
const K_MAX = 2.0 // r = 0: critically damped, no resonant hump
const K_MIN = 0.025 // r = 1: Q = 40 — rings hard, just shy of self-oscillation
const RES_CURVE = 1.4 // musical taper: resonance ramps in over the upper half

/** Soft limit level for the bandpass (resonance feedback) state. */
const SAT_LEVEL = 1.25
const SAT_LEVEL_INV = 1 / SAT_LEVEL

/** Bass compensation: dry (saturated) input mixed in at full resonance. */
const BASS_COMP = 0.15

/** State safety clamp and denormal flush threshold. */
const STATE_CLAMP = 8
const DENORMAL_EPS = 1e-15

const MIN_CUTOFF_HZ = 10

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

export class XdFilter {
  private readonly fs: number
  private readonly maxCutoff: number
  /** pi / (2*fs): cutoff-to-g prewarp factor at the 2x oversampled rate. */
  private readonly piOver2Fs: number
  /** One-pole smoothing coefficients (~3 ms params, ~5 ms drive). */
  private readonly aParam: number
  private readonly aDrive: number

  // --- parameter targets ---
  private fcTarget: number
  private resTarget = 0
  private kTarget = K_MAX
  private driveGainTarget = DRIVE_GAIN_0
  private makeupTarget = DRIVE_MAKEUP_0

  // --- smoothed parameter values ---
  private fcSm: number
  private resSm = 0
  private kSm = K_MAX
  private driveGainSm = DRIVE_GAIN_0
  private makeupSm = DRIVE_MAKEUP_0

  // --- filter state (TPT SVF integrator states, at the 2x rate) ---
  private ic1 = 0 // bandpass integrator state
  private ic2 = 0 // lowpass integrator state
  /** Previous input sample, for linear-interpolation upsampling. */
  private prevX = 0

  constructor(sampleRate: number) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) sampleRate = 48000
    this.fs = sampleRate
    this.maxCutoff = sampleRate * 0.45
    this.piOver2Fs = Math.PI / (2 * sampleRate)
    this.aParam = 1 - Math.exp(-1 / (0.003 * sampleRate))
    this.aDrive = 1 - Math.exp(-1 / (0.005 * sampleRate))
    this.fcTarget = Math.min(1000, this.maxCutoff)
    this.fcSm = this.fcTarget
  }

  /** Cutoff in Hz, clamped to [10, 0.45*fs]. Smoothed internally (~3 ms). */
  setCutoff(hz: number): void {
    if (!Number.isFinite(hz)) return
    this.fcTarget = hz < MIN_CUTOFF_HZ ? MIN_CUTOFF_HZ : hz > this.maxCutoff ? this.maxCutoff : hz
  }

  /** Resonance 0..1. At 1 it rings hard, just short of self-oscillation. */
  setResonance(r: number): void {
    if (!Number.isFinite(r)) return
    const res = r < 0 ? 0 : r > 1 ? 1 : r
    this.resTarget = res
    this.kTarget = K_MIN + (K_MAX - K_MIN) * Math.pow(1 - res, RES_CURVE)
  }

  /** DRIVE position: 0 = OFF, 1 = 50%, 2 = 100%. Smoothed to avoid clicks. */
  setDrive(d: number): void {
    if (!Number.isFinite(d)) return
    const pos = d < 0.5 ? 0 : d < 1.5 ? 1 : 2
    if (pos === 0) {
      this.driveGainTarget = DRIVE_GAIN_0
      this.makeupTarget = DRIVE_MAKEUP_0
    } else if (pos === 1) {
      this.driveGainTarget = DRIVE_GAIN_1
      this.makeupTarget = DRIVE_MAKEUP_1
    } else {
      this.driveGainTarget = DRIVE_GAIN_2
      this.makeupTarget = DRIVE_MAKEUP_2
    }
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

    // TPT coefficients at the 2x oversampled rate. fc <= 0.45*fs means the
    // prewarp argument stays <= 0.225*pi, so g is well-behaved (< 0.86).
    const g = Math.tan(this.fcSm * this.piOver2Fs)
    const k = this.kSm
    const d = 1 / (1 + g * (g + k))
    const comp = BASS_COMP * this.resSm
    const dg = this.driveGainSm

    // 2x upsample: midpoint by linear interpolation, then the sample itself.
    const xMid = 0.5 * (this.prevX + x)
    this.prevX = x

    const y0 = this.step(xMid, g, k, d, dg, comp)
    const y1 = this.step(x, g, k, d, dg, comp)

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

    // Averaging decimation back to the base rate, then makeup gain.
    return 0.5 * (y0 + y1) * this.makeupSm
  }

  /** One half-step of the nonlinear TPT SVF at the 2x rate. */
  private step(xin: number, g: number, k: number, d: number, dg: number, comp: number): number {
    // Drive stage: gain into a tanh saturator feeding the filter.
    const xd = fastTanh(xin * dg)
    // Zero-delay-feedback solve (linear prediction of the bandpass output).
    const v1Lin = (this.ic1 + g * (xd - this.ic2)) * d
    // OTA-style soft limit on the resonance feedback signal.
    const v1 = SAT_LEVEL * fastTanh(v1Lin * SAT_LEVEL_INV)
    const v2 = this.ic2 + g * v1
    // Trapezoidal integrator state updates.
    this.ic1 = 2 * v1 - this.ic1
    this.ic2 = 2 * v2 - this.ic2
    // Lowpass output plus resonance-proportional bass compensation.
    return v2 + comp * xd
  }

  /** Clear all state and snap parameter smoothers to their targets. */
  reset(): void {
    this.ic1 = 0
    this.ic2 = 0
    this.prevX = 0
    this.fcSm = this.fcTarget
    this.resSm = this.resTarget
    this.kSm = this.kTarget
    this.driveGainSm = this.driveGainTarget
    this.makeupSm = this.makeupTarget
  }
}
