/*
 * Calibration fitting toolkit — closed-form least squares in transformed
 * domains, targeting the curve families in src/synths/xd/curves.ts:
 *
 *   expMap(raw, lo, hi) = lo * (hi/lo)^(raw/1023)   -> log-linear fit
 *   power tapers  value = scale * raw01^exponent    -> log-log fit
 *   non-analytic monotone shapes                    -> isotonic lookup table
 *                                                      (PAV + Fritsch-Carlson
 *                                                      monotone cubic)
 *
 * No iterative optimizers here; analysis-by-synthesis grids live elsewhere.
 * Pure math only (no node imports) so the root DOM-lib tsc can check it.
 */

export interface XY {
  x: number
  y: number
}

/** Ordinary least squares y = a + b*x; r2 is the coefficient of determination. */
export function linFit(pts: readonly XY[]): { a: number; b: number; r2: number } {
  const n = pts.length
  if (n === 0) return { a: NaN, b: NaN, r2: NaN }
  let sx = 0
  let sy = 0
  for (const p of pts) {
    sx += p.x
    sy += p.y
  }
  const mx = sx / n
  const my = sy / n
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (const p of pts) {
    const dx = p.x - mx
    const dy = p.y - my
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
  }
  const b = sxx > 0 ? sxy / sxx : 0
  const a = my - b * mx
  let ssRes = 0
  for (const p of pts) {
    const e = p.y - (a + b * p.x)
    ssRes += e * e
  }
  // Degenerate SStot (constant y): perfect fit counts as 1, anything else 0.
  const r2 = syy > 0 ? 1 - ssRes / syy : ssRes === 0 ? 1 : 0
  return { a, b, r2 }
}

/** RMS of the linFit residuals over already-transformed points. */
function residualRms(pts: readonly XY[], a: number, b: number): number {
  if (pts.length === 0) return NaN
  let acc = 0
  for (const p of pts) {
    const e = p.y - (a + b * p.x)
    acc += e * e
  }
  return Math.sqrt(acc / pts.length)
}

/**
 * Fit expMap(raw, lo, hi) = lo * (hi/lo)^(raw/1023) by log-linear least
 * squares: ln(value) = ln(lo) + (raw/1023) * ln(hi/lo). Points with
 * value <= 0 are dropped (no log). residualLogRms is the RMS error in
 * ln(value), i.e. roughly the fractional error of the fit.
 */
export function fitExpMap(
  pts: readonly { raw: number; value: number }[]
): { lo: number; hi: number; residualLogRms: number } {
  const xy: XY[] = []
  for (const p of pts) {
    if (Number.isFinite(p.raw) && p.value > 0) {
      xy.push({ x: p.raw / 1023, y: Math.log(p.value) })
    }
  }
  const { a, b } = linFit(xy)
  return { lo: Math.exp(a), hi: Math.exp(a + b), residualLogRms: residualRms(xy, a, b) }
}

/**
 * Fit value = scale * raw01^exponent by log-log least squares:
 * ln(value) = ln(scale) + exponent * ln(raw01). Points with raw01 <= 0 or
 * value <= 0 are dropped (no log).
 */
export function fitPowerTaper(
  pts: readonly { raw01: number; value: number }[]
): { exponent: number; scale: number; residualLogRms: number } {
  const xy: XY[] = []
  for (const p of pts) {
    if (p.raw01 > 0 && p.value > 0) {
      xy.push({ x: Math.log(p.raw01), y: Math.log(p.value) })
    }
  }
  const { a, b } = linFit(xy)
  return { exponent: b, scale: Math.exp(a), residualLogRms: residualRms(xy, a, b) }
}

/** MATLAB-style pchip endpoint: three-point one-sided slope, sign-clamped. */
function endSlope(h0: number, h1: number, d0: number, d1: number): number {
  let m = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1)
  if (m * d0 <= 0) m = 0
  else if (d0 * d1 <= 0 && Math.abs(m) > 3 * Math.abs(d0)) m = 3 * d0
  return m
}

/**
 * Monotone lookup table for non-analytic shapes: sort by x, average duplicate
 * x (weights carried into the projection), isotonic-project ys to
 * non-decreasing via pool-adjacent-violators, then evaluate with a
 * Fritsch-Carlson monotone cubic (PCHIP). at() clamps outside [xs[0], xs[N-1]].
 */
export function monotoneTable(pts: readonly XY[]): {
  xs: Float64Array
  ys: Float64Array
  at(x: number): number
} {
  const sorted = pts
    .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((p, q) => p.x - q.x)

  // Average duplicate x, keeping the sample count of each knot as its weight.
  const kx: number[] = []
  const ky: number[] = []
  const kw: number[] = []
  for (const p of sorted) {
    const last = kx.length - 1
    if (last >= 0 && kx[last] === p.x) {
      ky[last] += (p.y - ky[last]) / (kw[last] + 1)
      kw[last]++
    } else {
      kx.push(p.x)
      ky.push(p.y)
      kw.push(1)
    }
  }
  const n = kx.length

  // Pool adjacent violators: weighted-average blocks until non-decreasing.
  const by: number[] = [] // block mean
  const bw: number[] = [] // block weight
  const bn: number[] = [] // knots pooled into the block
  let top = -1
  for (let i = 0; i < n; i++) {
    let y = ky[i]
    let w = kw[i]
    let cnt = 1
    while (top >= 0 && by[top] > y) {
      y = (y * w + by[top] * bw[top]) / (w + bw[top])
      w += bw[top]
      cnt += bn[top]
      top--
    }
    top++
    by[top] = y
    bw[top] = w
    bn[top] = cnt
  }
  const xs = Float64Array.from(kx)
  const ys = new Float64Array(n)
  for (let b = 0, k = 0; b <= top; b++) {
    for (let j = 0; j < bn[b]; j++) ys[k++] = by[b]
  }

  // Fritsch-Carlson slopes: 0 across flats, weighted harmonic mean otherwise.
  const m = new Float64Array(n)
  if (n === 2) {
    const d = (ys[1] - ys[0]) / (xs[1] - xs[0])
    m[0] = d
    m[1] = d
  } else if (n > 2) {
    const h = new Float64Array(n - 1)
    const d = new Float64Array(n - 1)
    for (let i = 0; i < n - 1; i++) {
      h[i] = xs[i + 1] - xs[i]
      d[i] = (ys[i + 1] - ys[i]) / h[i]
    }
    for (let i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) {
        m[i] = 0
      } else {
        const w1 = 2 * h[i] + h[i - 1]
        const w2 = h[i] + 2 * h[i - 1]
        m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
      }
    }
    m[0] = endSlope(h[0], h[1], d[0], d[1])
    m[n - 1] = endSlope(h[n - 2], h[n - 3], d[n - 2], d[n - 3])
  }

  function at(x: number): number {
    if (n === 0) return NaN
    if (x <= xs[0]) return ys[0]
    if (x >= xs[n - 1]) return ys[n - 1]
    let lo = 0
    let hi = n - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (xs[mid] <= x) lo = mid
      else hi = mid
    }
    const span = xs[hi] - xs[lo]
    const t = (x - xs[lo]) / span
    const t2 = t * t
    const t3 = t2 * t
    return (
      (2 * t3 - 3 * t2 + 1) * ys[lo] +
      (t3 - 2 * t2 + t) * span * m[lo] +
      (-2 * t3 + 3 * t2) * ys[hi] +
      (t3 - t2) * span * m[hi]
    )
  }

  return { xs, ys, at }
}

/** Median (average of the middle two for even lengths); NaN on empty. */
export function median(xs: readonly number[]): number {
  const n = xs.length
  if (n === 0) return NaN
  const s = xs.slice().sort((a, b) => a - b)
  const mid = n >> 1
  return n % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Median absolute deviation (unscaled). */
export function mad(xs: readonly number[]): number {
  const m = median(xs)
  return median(xs.map(v => Math.abs(v - m)))
}
