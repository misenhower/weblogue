import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  corner3Db,
  fitLpMag,
  measureNoisePoint,
  transferDb,
} from '../tools/calib/lib/measure-noise'
import type { CalibJob } from '../tools/calib/lib/job'
import { loadJob } from '../tools/calib/lib/job'
import { renderJobPoint } from '../tools/calib/lib/render'
import { cutoffToHz } from '../src/synths/xd/curves'

const SR = 48000

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

function whiteNoise(seconds: number, seed: number): Float32Array {
  const rng = makeRng(seed)
  const x = new Float32Array(Math.round(seconds * SR))
  for (let i = 0; i < x.length; i++) x[i] = rng() * 2 - 1
  return x
}

/**
 * One-pole IIR lowpass with its half-power (-3.01 dB) point EXACTLY at fcHz:
 * y[n] = b*x[n] + r*y[n-1] with r solving 1 - 2r*cos(wc) + r^2 = 2(1-r)^2.
 */
function onePoleLp(x: Float32Array, fcHz: number, sr: number): Float32Array {
  const cw = Math.cos((2 * Math.PI * fcHz) / sr)
  const r = 2 - cw - Math.sqrt((2 - cw) ** 2 - 1)
  const b = 1 - r
  const out = new Float32Array(x.length)
  let y = 0
  for (let i = 0; i < x.length; i++) {
    y = b * x[i] + r * y
    out[i] = y
  }
  return out
}

/**
 * RBJ-cookbook biquad lowpass at Butterworth damping (Q = 1/sqrt(2)) — a
 * 2-pole 12 dB/oct rolloff whose gain at fcHz is exactly -3.01 dB.
 */
function biquadLp(x: Float32Array, fcHz: number, sr: number): Float32Array {
  const w0 = (2 * Math.PI * fcHz) / sr
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2)
  const cw = Math.cos(w0)
  const a0 = 1 + alpha
  const b0 = (1 - cw) / 2 / a0
  const b1 = (1 - cw) / a0
  const b2 = b0
  const a1 = (-2 * cw) / a0
  const a2 = (1 - alpha) / a0
  const out = new Float32Array(x.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < x.length; i++) {
    const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x[i]
    y2 = y1
    y1 = y
    out[i] = y
  }
  return out
}

/** Measure a bare synthetic signal: one full-length note, onset at sample 0. */
function measure(x: Float32Array) {
  const durSec = x.length / SR
  const job: CalibJob = {
    id: 'noise-test',
    domain: 'filter.cutoff',
    notes: [{ midi: 60, vel: 100, onSec: 0, offSec: durSec }],
    captureSec: durSec,
    features: {},
  }
  return measureNoisePoint(x, SR, 0, job)
}

/** Transfer value of the grid bin nearest hzWanted. */
function binAt(hz: number[], v: number[], hzWanted: number): number {
  let k = 0
  for (let i = 1; i < hz.length; i++) {
    if (Math.abs(hz[i] - hzWanted) < Math.abs(hz[k] - hzWanted)) k = i
  }
  return v[k]
}

// -----------------------------------------------------------------------------

describe('measureNoisePoint', () => {
  it('reports a flat-ish grid PSD, sane levels, and a fixed grid for white noise', () => {
    const f = measure(whiteNoise(4, 0xc0ffee))
    expect(f.psdHz.length).toBe(256)
    expect(f.psdDb.length).toBe(256)
    expect(f.psdHz[0]).toBeGreaterThan(20)
    expect(f.psdHz[255]).toBeLessThan(20000)
    // log-spaced: constant ratio between neighbors
    const ratio = f.psdHz[1] / f.psdHz[0]
    expect(f.psdHz[200] / f.psdHz[199]).toBeCloseTo(ratio, 6)
    // white: 1-20 kHz band levels agree within a few dB
    expect(Math.abs(binAt(f.psdHz, f.psdDb, 2000) - binAt(f.psdHz, f.psdDb, 15000))).toBeLessThan(3)
    expect(f.peakDbfs).toBeLessThanOrEqual(0)
    expect(f.peakDbfs).toBeGreaterThan(-1) // uniform noise peaks near full scale
    expect(f.rmsDb).toBeCloseTo(10 * Math.log10(1 / 3), 0) // uniform [-1,1] power 1/3
  })
})

describe('transferDb', () => {
  it('is ~0 everywhere for identical captures, and corner3Db finds no corner', () => {
    const x = whiteNoise(4, 7)
    const a = measure(x)
    const b = measure(x)
    const tr = transferDb(a, b)
    for (const v of tr) expect(Math.abs(v)).toBeLessThan(1e-9)
    expect(corner3Db(a.psdHz, tr)).toBeNull()
  })
})

describe('corner3Db + fitLpMag on synthetic filters', () => {
  it('recovers a 1 kHz one-pole corner from independent noise captures', () => {
    // 32 s: the one-pole knee slope is only 3 dB/oct, so Welch variance maps
    // to corner error at ~2x the 2-pole rate — buy margin with averaging
    const ref = measure(whiteNoise(32, 0x1111))
    const pt = measure(onePoleLp(whiteNoise(32, 0x2222), 1000, SR))
    const tr = transferDb(pt, ref)
    const corner = corner3Db(pt.psdHz, tr)
    expect(corner).not.toBeNull()
    expect(Math.abs(corner! - 1000) / 1000).toBeLessThan(0.08)
    const fit = fitLpMag(pt.psdHz, tr, 1)
    expect(Math.abs(fit.fcHz - 1000) / 1000).toBeLessThan(0.05)
    expect(fit.r2).toBeGreaterThan(0.98)
  })

  it('recovers a 1 kHz 2-pole (Butterworth biquad) corner and slope fit', () => {
    const ref = measure(whiteNoise(16, 0x3333))
    const pt = measure(biquadLp(whiteNoise(16, 0x4444), 1000, SR))
    const tr = transferDb(pt, ref)
    const corner = corner3Db(pt.psdHz, tr)
    expect(corner).not.toBeNull()
    expect(Math.abs(corner! - 1000) / 1000).toBeLessThan(0.08)
    const fit = fitLpMag(pt.psdHz, tr) // poles defaults to 2
    expect(Math.abs(fit.fcHz - 1000) / 1000).toBeLessThan(0.05)
    expect(fit.r2).toBeGreaterThan(0.98)
  })

  it('reference divide removes source coloration (pink-ish noise)', () => {
    // pink-ish source: white through a 300 Hz one-pole -> -6 dB/oct tilt above 300
    const refSrc = onePoleLp(whiteNoise(16, 0x5555), 300, SR)
    const ptSrc = onePoleLp(whiteNoise(16, 0x6666), 300, SR)
    const ref = measure(refSrc)
    const pt = measure(biquadLp(ptSrc, 1000, SR))
    // the raw reference PSD really is colored (tilts > 15 dB across the band)...
    expect(binAt(ref.psdHz, ref.psdDb, 100) - binAt(ref.psdHz, ref.psdDb, 5000)).toBeGreaterThan(15)
    const tr = transferDb(pt, ref)
    // ...but the divide flattens it: the transfer plateau (40-400 Hz, well
    // inside the tilted region) stays flat, and the corner still reads 1 kHz
    const band: number[] = []
    for (let i = 0; i < pt.psdHz.length; i++) {
      if (pt.psdHz[i] >= 40 && pt.psdHz[i] <= 400) band.push(tr[i])
    }
    const mid = band.slice().sort((a, b) => a - b)[band.length >> 1]
    for (const v of band) expect(Math.abs(v - mid)).toBeLessThan(2)
    const corner = corner3Db(pt.psdHz, tr)
    expect(corner).not.toBeNull()
    expect(Math.abs(corner! - 1000) / 1000).toBeLessThan(0.08)
  })
})

describe('replica render integration (cutoff-sweep job)', () => {
  it('measures the replica VCF corner at raw 512 near the cutoffToHz curve', () => {
    const job = loadJob(join(__dirname, '../tools/calib/jobs/cutoff-sweep.json'))
    const ref = renderJobPoint(job, 1023)
    const pt = renderJobPoint(job, 512)
    const fRef = measureNoisePoint(ref.samples, ref.sr, ref.onsetSample, job)
    const fPt = measureNoisePoint(pt.samples, pt.sr, pt.onsetSample, job)
    const tr = transferDb(fPt, fRef)
    const fc0 = cutoffToHz(512) // expMap(512, 16, 21000) ~ 582 Hz
    // fitLpMag matches the 12 dB/oct asymptote, whose position is set by fc
    // itself -> compares directly against the curve's fc
    const fit = fitLpMag(fPt.psdHz, tr)
    expect(Math.abs(fit.fcHz - fc0) / fc0).toBeLessThan(0.2)
    expect(fit.r2).toBeGreaterThan(0.9)
    // the replica VCF at res 0 is critically damped (k = 2, |H|^2 =
    // 1/(1+u^2)^2), so its HALF-POWER point sits at sqrt(sqrt(2)-1) ~ 0.644
    // of fc — corner3Db must land there, not at fc
    const halfPowerU = Math.sqrt(Math.SQRT2 - 1)
    const corner = corner3Db(fPt.psdHz, tr)
    expect(corner).not.toBeNull()
    expect(Math.abs(corner! - halfPowerU * fc0) / (halfPowerU * fc0)).toBeLessThan(0.2)
  })
})
