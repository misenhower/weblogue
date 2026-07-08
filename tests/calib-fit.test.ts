/*
 * tools/calib fitting toolkit: closed-form fits recover the xd curve families
 * (expMap for envelope times / cutoff, power tapers for levels) from noisy
 * calibration grids, and the monotone table stays monotone under noise.
 */
import { describe, it, expect } from 'vitest'
import { expMap } from '../src/shared/maps'
import { linFit, fitExpMap, fitPowerTaper, monotoneTable, median, mad } from '../tools/calib/lib/fit'

/** mulberry32 — deterministic fuzz. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), s | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Standard normal via Box-Muller over a uniform rng. */
function makeGauss(rng: () => number): () => number {
  return () => {
    const u = Math.max(rng(), 1e-12)
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
  }
}

/** The 17-point calibration grid: 64-step raw detents 0..960 plus the 1023 cap. */
const GRID = Array.from({ length: 17 }, (_, i) => Math.min(1023, i * 64))

// -----------------------------------------------------------------------------

describe('fitExpMap', () => {
  it('recovers lo=16 hi=21000 exactly from clean cutoff samples', () => {
    const pts = GRID.map(raw => ({ raw, value: expMap(raw, 16, 21000) }))
    const f = fitExpMap(pts)
    expect(f.lo / 16).toBeCloseTo(1, 9)
    expect(f.hi / 21000).toBeCloseTo(1, 9)
    expect(f.residualLogRms).toBeLessThan(1e-9)
  })

  it('recovers lo within 15% and hi within 10% under 3% multiplicative noise', () => {
    const gauss = makeGauss(makeRng(0xc0ffee))
    const pts = GRID.map(raw => ({
      raw,
      value: expMap(raw, 16, 21000) * Math.exp(0.03 * gauss()),
    }))
    const f = fitExpMap(pts)
    expect(f.lo).toBeGreaterThan(16 * 0.85)
    expect(f.lo).toBeLessThan(16 * 1.15)
    expect(f.hi).toBeGreaterThan(21000 * 0.9)
    expect(f.hi).toBeLessThan(21000 * 1.1)
    // Residual sits near the injected log-noise level (sigma = 0.03).
    expect(f.residualLogRms).toBeGreaterThan(0.005)
    expect(f.residualLogRms).toBeLessThan(0.08)
  })

  it('drops non-positive values instead of producing NaN', () => {
    const pts = [{ raw: 0, value: 0 }, ...GRID.slice(1).map(raw => ({ raw, value: expMap(raw, 16, 21000) }))]
    const f = fitExpMap(pts)
    expect(f.lo / 16).toBeCloseTo(1, 9)
    expect(f.hi / 21000).toBeCloseTo(1, 9)
  })
})

describe('fitPowerTaper', () => {
  it('is exact on the clean resonance taper (exponent 1.1)', () => {
    const pts = GRID.map(raw => ({ raw01: raw / 1023, value: Math.pow(raw / 1023, 1.1) }))
    const f = fitPowerTaper(pts)
    expect(f.exponent).toBeCloseTo(1.1, 9)
    expect(f.scale).toBeCloseTo(1, 9)
    expect(f.residualLogRms).toBeLessThan(1e-9)
  })

  it('recovers exponent 1.1 within 0.05 from 17 noisy points', () => {
    const gauss = makeGauss(makeRng(0xbada55))
    const pts = GRID.map(raw => ({
      raw01: raw / 1023,
      value: Math.pow(raw / 1023, 1.1) * Math.exp(0.03 * gauss()),
    }))
    const f = fitPowerTaper(pts)
    expect(Math.abs(f.exponent - 1.1)).toBeLessThan(0.05)
    expect(f.scale).toBeGreaterThan(0.9)
    expect(f.scale).toBeLessThan(1.1)
  })
})

describe('linFit', () => {
  it('is exact on a known line with r2 = 1', () => {
    const pts = [-2, 0, 1, 3, 7].map(x => ({ x, y: 2.5 - 1.25 * x }))
    const f = linFit(pts)
    expect(f.a).toBeCloseTo(2.5, 12)
    expect(f.b).toBeCloseTo(-1.25, 12)
    expect(f.r2).toBeCloseTo(1, 12)
  })

  it('r2 drops below 1 with noise while the slope stays close', () => {
    const rng = makeRng(1234)
    const pts = Array.from({ length: 50 }, (_, i) => ({
      x: i / 10,
      y: 1 + 2 * (i / 10) + (rng() - 0.5),
    }))
    const f = linFit(pts)
    expect(f.r2).toBeLessThan(1)
    expect(f.r2).toBeGreaterThan(0.9)
    expect(Math.abs(f.b - 2)).toBeLessThan(0.2)
  })
})

describe('monotoneTable', () => {
  it('at() is non-decreasing everywhere on noisy monotone data', () => {
    const rng = makeRng(42)
    const pts = Array.from({ length: 33 }, (_, i) => {
      const x = i / 32
      return { x, y: 3 * x * x + (rng() - 0.5) * 0.15 }
    })
    const t = monotoneTable(pts)
    let prev = t.at(0)
    for (let i = 1; i <= 1000; i++) {
      const v = t.at(i / 1000)
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12)
      prev = v
    }
  })

  it('pools adjacent violators and interpolates exactly through the knots', () => {
    const t = monotoneTable([
      { x: 0, y: 0 },
      { x: 1, y: 5 },
      { x: 2, y: 3 }, // violator: pooled with the previous knot -> (4, 4)
      { x: 3, y: 8 },
    ])
    expect(Array.from(t.xs)).toEqual([0, 1, 2, 3])
    expect(Array.from(t.ys)).toEqual([0, 4, 4, 8])
    for (let i = 0; i < t.xs.length; i++) {
      expect(t.at(t.xs[i])).toBeCloseTo(t.ys[i], 12)
    }
  })

  it('averages duplicate x before fitting', () => {
    const t = monotoneTable([
      { x: 2, y: 5 },
      { x: 1, y: 2 },
      { x: 0, y: 0 },
      { x: 1, y: 4 },
    ])
    expect(Array.from(t.xs)).toEqual([0, 1, 2])
    expect(Array.from(t.ys)).toEqual([0, 3, 5])
    expect(t.at(1)).toBeCloseTo(3, 12)
  })

  it('clamps outside the domain', () => {
    const t = monotoneTable([
      { x: 0, y: 1 },
      { x: 2, y: 4 },
      { x: 4, y: 9 },
    ])
    expect(t.at(-100)).toBe(1)
    expect(t.at(100)).toBe(9)
    expect(t.at(0)).toBe(1)
    expect(t.at(4)).toBe(9)
  })
})

describe('median and mad', () => {
  it('median handles odd, even, and single-element arrays', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([7])).toBe(7)
  })

  it('mad on known arrays', () => {
    expect(mad([1, 2, 3, 4, 5])).toBe(1)
    expect(mad([1, 1, 4, 4])).toBe(1.5)
    expect(mad([5, 5, 5])).toBe(0)
  })
})
