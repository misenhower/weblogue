/*
 * Fritsch-Carlson monotone cubic (PCHIP) evaluator over fixed knots. This is
 * the evaluation half of tools/calib/lib/fit.ts monotoneTable (which also
 * sorts/pools its input); the calibration fits build tables through the same
 * slope math, so a table measured there and stored in a calibration profile
 * (synth profiles.ts modules) evaluates identically here. Clamps outside the knot
 * range. Knots must be sorted by strictly increasing x.
 */

/** MATLAB-style pchip endpoint: three-point one-sided slope, sign-clamped. */
function endSlope(h0: number, h1: number, d0: number, d1: number): number {
  let m = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1)
  if (m * d0 <= 0) m = 0
  else if (d0 * d1 <= 0 && Math.abs(m) > 3 * Math.abs(d0)) m = 3 * d0
  return m
}

export function monotoneCubic(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
): (x: number) => number {
  const n = xs.length

  // Fritsch-Carlson slopes: 0 across flats/reversals, weighted harmonic mean.
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

  return (x: number): number => {
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
}
