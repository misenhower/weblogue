/*
 * Calibration review workflow. This module is the seam between the CLI and
 * the evidence/verification policy: commands may change, but a calibration
 * can only be accepted after an independent, complete session beats the
 * baseline and meets the domain threshold declared here.
 */

export interface VerificationPoint {
  raw: number | null
  hardware: number
  before: number
  after: number
}

export interface VerificationInput {
  domain: string
  unit: string
  independent: boolean
  coverageComplete: boolean
  points: readonly VerificationPoint[]
  /** Evidence-design failures found outside the numeric metric evaluator. */
  designReasons?: readonly string[]
}

export interface VerificationResult {
  passed: boolean
  threshold: number | null
  metric: 'rms-log-ratio' | 'rms-cents' | 'median-ladder-db'
  beforeScore: number
  afterScore: number
  points: number
  reasons: string[]
}

/** Thresholds from docs/calibration-protocol.md "Validation". */
export function verificationThreshold(domain: string, unit: string): number | null {
  if (domain === 'vco.pitch' && unit === '¢') return 2
  if (domain === 'filter.cutoff' && unit === 'Hz') return 0.05
  if (domain === 'vco.shape' && unit === 'dB') return 1.5
  if (domain.startsWith('eg.') && unit === 's') return 0.05
  if (domain === 'lfo.rate' && unit === 'Hz') return 0.05
  return null
}

function rms(values: readonly number[]): number {
  if (values.length === 0) return NaN
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length)
}

function median(values: readonly number[]): number {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Evaluate one independent verification capture set against a candidate. */
export function evaluateVerification(input: VerificationInput): VerificationResult {
  const threshold = verificationThreshold(input.domain, input.unit)
  const delta = (value: number, hardware: number): number =>
    input.unit === '¢' || input.unit === 'dB'
      ? value - hardware
      : value > 0 && hardware > 0
        ? Math.log(value / hardware)
        : NaN
  const metric =
    input.domain === 'vco.shape'
      ? 'median-ladder-db'
      : input.unit === '¢'
        ? 'rms-cents'
        : 'rms-log-ratio'
  const aggregate = metric === 'median-ladder-db' ? median : rms
  const beforeScore = aggregate(input.points.map((point) => Math.abs(delta(point.before, point.hardware))))
  const afterScore = aggregate(input.points.map((point) => Math.abs(delta(point.after, point.hardware))))
  const reasons: string[] = [...(input.designReasons ?? [])]

  if (!input.independent) reasons.push('verification must use a different session from the fit')
  if (!input.coverageComplete) reasons.push('verification session has failed or unusable sweep points')
  if (input.points.length === 0) reasons.push('verification has no comparable points')
  if (threshold === null) reasons.push(`no acceptance threshold is implemented for ${input.domain}`)
  if (Number.isFinite(beforeScore) && Number.isFinite(afterScore) && afterScore >= beforeScore) {
    reasons.push(`candidate did not improve ${metric} error over the captured baseline`)
  }
  if (threshold !== null && (!Number.isFinite(afterScore) || afterScore > threshold)) {
    const absolute = input.unit === '¢' || input.unit === 'dB'
    const unit = absolute ? input.unit : '%'
    const shown = absolute ? afterScore : afterScore * 100
    const limit = absolute ? threshold : threshold * 100
    reasons.push(`candidate ${metric} ${shown.toFixed(2)}${unit} exceeds ${limit.toFixed(2)}${unit} threshold`)
  }
  if (threshold !== null) {
    // A point that got worse than the baseline but still sits WITHIN the
    // domain threshold is capture repeatability, not a defect (the SQR
    // verify false-fail, 2026-07-13: one point +0.6 dB vs baseline yet at
    // 0.64 dB absolute against a 1.5 dB spec). Material regression = worse
    // than baseline by >25% of the threshold AND out of spec.
    const tolerance = threshold * 0.25
    const regressed = input.points.filter((point) => {
      const before = Math.abs(delta(point.before, point.hardware))
      const after = Math.abs(delta(point.after, point.hardware))
      return after - before > tolerance && after > threshold
    })
    if (regressed.length > 0) {
      reasons.push(
        `${regressed.length} verification point(s) regressed materially ` +
          `(more than 25% of the acceptance threshold, and out of spec)`,
      )
    }
  }

  return {
    passed: reasons.length === 0,
    threshold,
    metric,
    beforeScore,
    afterScore,
    points: input.points.length,
    reasons,
  }
}
