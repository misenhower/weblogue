/*
 * D5 envelope measurement: synthetic sine bursts shaped by known piecewise
 * envelopes (closed-form, deterministic), then replica self-consistency of
 * the eg-* job specs against src/synths/xd/curves.ts EG-time maps.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { join } from 'node:path'
import { measureEnvPoint } from '../tools/calib/lib/measure-env'
import type { CalibJob } from '../tools/calib/lib/job'
import { loadJob } from '../tools/calib/lib/job'
import { renderJobPoint } from '../tools/calib/lib/render'
import { attackToSec, decayToSec, releaseToSec } from '../src/synths/xd/curves'
import { setXdProfile, XD_DEFAULT_PROFILE } from '../src/synths/xd/profiles'

afterEach(() => {
  setXdProfile(XD_DEFAULT_PROFILE)
})

const SR = 48000
const JOBS = join(__dirname, '../tools/calib/jobs')

/**
 * The replica attack charges toward 1.3 clipped at 1.0 (src/dsp/eg.ts), so
 * its 10-90% rise is ln(3)*tau while the displayed time is ln(1.3/0.3)*tau:
 * measured 10-90 = ~0.7492 * attackToSec(raw).
 */
const ATTACK_1090_RATIO = Math.log(3) / Math.log(1.3 / 0.3)

/** Minimal envelope job around a single fixed note. */
function envJob(onSec: number, offSec: number, captureSec: number): CalibJob {
  return {
    id: 'synthetic-env',
    domain: 'eg.amp',
    notes: [{ midi: 69, vel: 100, onSec, offSec }],
    captureSec,
    features: { nominalHz: 440 },
  }
}

/** 440 Hz sine shaped by a closed-form amplitude envelope env(t). */
function shapedSine(env: (t: number) => number, seconds: number): Float32Array {
  const n = Math.round(seconds * SR)
  const x = new Float32Array(n)
  const w = (2 * Math.PI * 440) / SR
  for (let i = 0; i < n; i++) x[i] = env(i / SR) * Math.sin(w * i)
  return x
}

const onset = (job: CalibJob) => Math.round(job.notes[0].onSec * SR)

describe('measureEnvPoint attack (synthetic)', () => {
  it('reads a 100 ms linear attack as its 80 ms 10-90 rise within max(5%, 3 ms)', () => {
    const job = envJob(0.2, 1.2, 1.5)
    const T = 0.1
    const x = shapedSine((t) => {
      if (t < 0.2) return 0
      if (t < 0.2 + T) return (0.8 * (t - 0.2)) / T
      return t < 1.2 ? 0.8 : 0
    }, 1.5)
    const f = measureEnvPoint(x, SR, onset(job), job, 'attack')
    expect(f.attackSec).not.toBeNull()
    expect(Math.abs(f.attackSec! - 0.8 * T)).toBeLessThan(Math.max(0.05 * 0.8 * T, 0.003))
    // only the requested segment is computed
    expect(f.decayTimeSec).toBeNull()
    expect(f.releaseTimeSec).toBeNull()
    expect(f.sustainDb).toBeNull()
    expect(Math.abs(f.peakDbfs - 20 * Math.log10(0.8))).toBeLessThan(0.2)
  })

  it('reads a 10 ms linear attack within 3 ms (follower-limited scale)', () => {
    const job = envJob(0.2, 0.7, 1.0)
    const T = 0.01
    const x = shapedSine((t) => {
      if (t < 0.2) return 0
      if (t < 0.2 + T) return (0.8 * (t - 0.2)) / T
      return t < 0.7 ? 0.8 : 0
    }, 1.0)
    const f = measureEnvPoint(x, SR, onset(job), job, 'attack')
    expect(f.attackSec).not.toBeNull()
    expect(Math.abs(f.attackSec! - 0.8 * T)).toBeLessThan(0.003)
  })

  it('returns null on silence', () => {
    const job = envJob(0.2, 1.2, 1.5)
    const f = measureEnvPoint(new Float32Array(Math.round(1.5 * SR)), SR, onset(job), job, 'attack')
    expect(f.attackSec).toBeNull()
    expect(f.peakDbfs).toBe(-Infinity)
  })
})

describe('measureEnvPoint decay (synthetic)', () => {
  it('recovers tau = 0.4 s as displayed 1.2 s within 8%', () => {
    const job = envJob(0.3, 3.3, 3.5)
    const tau = 0.4
    const x = shapedSine((t) => {
      if (t < 0.3 || t >= 3.3) return 0
      return Math.exp(-(t - 0.3) / tau)
    }, 3.5)
    const f = measureEnvPoint(x, SR, onset(job), job, 'decay')
    expect(f.decayTimeSec).not.toBeNull()
    expect(Math.abs(f.decayTimeSec! - 3 * tau) / (3 * tau)).toBeLessThan(0.08)
    expect(f.attackSec).toBeNull()
  })

  it('extrapolates a tau = 2 s decay (displayed 6 s) from a 3 s hold within 8%', () => {
    const job = envJob(0.3, 3.3, 3.5)
    const tau = 2.0
    const x = shapedSine((t) => {
      if (t < 0.3 || t >= 3.3) return 0
      return Math.exp(-(t - 0.3) / tau)
    }, 3.5)
    const f = measureEnvPoint(x, SR, onset(job), job, 'decay')
    expect(f.decayTimeSec).not.toBeNull()
    expect(Math.abs(f.decayTimeSec! - 3 * tau) / (3 * tau)).toBeLessThan(0.08)
  })
})

describe('measureEnvPoint release (synthetic)', () => {
  it('recovers a tau = 0.5 s release step at note-off as displayed 1.5 s within 8%', () => {
    const job = envJob(0.3, 1.0, 3.5)
    const tau = 0.5
    const x = shapedSine((t) => {
      if (t < 0.3) return 0
      if (t < 1.0) return 0.9
      return 0.9 * Math.exp(-(t - 1.0) / tau)
    }, 3.5)
    const f = measureEnvPoint(x, SR, onset(job), job, 'release')
    expect(f.releaseTimeSec).not.toBeNull()
    expect(Math.abs(f.releaseTimeSec! - 3 * tau) / (3 * tau)).toBeLessThan(0.08)
    expect(f.attackSec).toBeNull()
    expect(f.sustainDb).toBeNull()
  })

  it('extrapolates a tau = 2 s release from a 2.5 s tail within 8%', () => {
    const job = envJob(0.3, 1.0, 3.5)
    const tau = 2.0
    const x = shapedSine((t) => {
      if (t < 0.3) return 0
      if (t < 1.0) return 0.9
      return 0.9 * Math.exp(-(t - 1.0) / tau)
    }, 3.5)
    const f = measureEnvPoint(x, SR, onset(job), job, 'release')
    expect(f.releaseTimeSec).not.toBeNull()
    expect(Math.abs(f.releaseTimeSec! - 3 * tau) / (3 * tau)).toBeLessThan(0.08)
  })
})

describe('measureEnvPoint sustain (synthetic)', () => {
  it('reads a 0.5-of-peak plateau as -6.02 dB within 0.5 dB', () => {
    const job = envJob(0.2, 2.2, 2.5)
    const x = shapedSine((t) => {
      if (t < 0.2 || t >= 2.2) return 0
      return 0.5 + 0.5 * Math.exp(-(t - 0.2) / 0.15)
    }, 2.5)
    const f = measureEnvPoint(x, SR, onset(job), job, 'sustain')
    expect(f.sustainDb).not.toBeNull()
    expect(Math.abs(f.sustainDb! - 20 * Math.log10(0.5))).toBeLessThan(0.5)
    expect(f.decayTimeSec).toBeNull()
  })
})

describe('eg-* job specs', () => {
  // attack: 13 points; decay/release: 15 (knots 896/980 added when the long
  // tail blow-up was measured, 2026-07-10)
  it.each([
    ['eg-attack', 13],
    ['eg-decay', 15],
    ['eg-release', 15],
  ] as const)('%s loads with %i sweep points', (id, n) => {
    // loadJob must accept the new features.kind/env keys today (unvalidated)
    const job = loadJob(join(JOBS, `${id}.json`))
    expect(job.sweep!.points).toHaveLength(n)
    expect(job.sweep!.points[0]).toBe(0)
    expect(job.sweep!.points[n - 1]).toBe(1023)
    expect(job.features.nominalHz).toBe(440)
    const extra = job.features as Record<string, unknown>
    expect(extra.kind).toBe('envelope')
    expect(['attack', 'decay', 'release']).toContain(extra.env)
  })
})

describe('replica self-consistency (renderJobPoint)', () => {
  it.each([512, 938])(
    'eg-attack point %i: 10-90 rise matches 0.749 * attackToSec within max(15%, 5 ms)',
    (raw) => {
      const job = loadJob(join(JOBS, 'eg-attack.json'))
      const r = renderJobPoint(job, raw)
      const f = measureEnvPoint(r.samples, r.sr, r.onsetSample, job, 'attack')
      const want = ATTACK_1090_RATIO * attackToSec(raw)
      expect(f.attackSec).not.toBeNull()
      expect(Math.abs(f.attackSec! - want)).toBeLessThan(Math.max(0.15 * want, 0.005))
    },
  )

  // Each fall convention pairs with ITS extractor field: legacy exponential
  // profiles (v0) with the 3*tau displayed-time fit, cubic-fall profiles
  // (v1, egFallPower) with the time-to-zero fit.
  it('eg-decay point 682: v0 exponential matches the 3*tau fit; v1 cubic matches the T fit', () => {
    const job = loadJob(join(JOBS, 'eg-decay.json'))
    const legacy = renderJobPoint(job, 682, 'v0')
    const fLegacy = measureEnvPoint(legacy.samples, legacy.sr, legacy.onsetSample, job, 'decay')
    setXdProfile('v0')
    const wantLegacy = decayToSec(682)
    expect(fLegacy.decayTimeSec).not.toBeNull()
    expect(Math.abs(fLegacy.decayTimeSec! - wantLegacy) / wantLegacy).toBeLessThan(0.1)
    const cubic = renderJobPoint(job, 682, 'v1')
    const fCubic = measureEnvPoint(cubic.samples, cubic.sr, cubic.onsetSample, job, 'decay')
    setXdProfile('v1')
    const wantCubic = decayToSec(682)
    expect(fCubic.fallTimeSec).not.toBeNull()
    expect(Math.abs(fCubic.fallTimeSec! - wantCubic) / wantCubic).toBeLessThan(0.1)
  })

  it('eg-release point 682: v0 exponential matches the 3*tau fit; v1 cubic matches the T fit', () => {
    const job = loadJob(join(JOBS, 'eg-release.json'))
    const legacy = renderJobPoint(job, 682, 'v0')
    const fLegacy = measureEnvPoint(legacy.samples, legacy.sr, legacy.onsetSample, job, 'release')
    setXdProfile('v0')
    const wantLegacy = releaseToSec(682)
    expect(fLegacy.releaseTimeSec).not.toBeNull()
    expect(Math.abs(fLegacy.releaseTimeSec! - wantLegacy) / wantLegacy).toBeLessThan(0.1)
    const cubic = renderJobPoint(job, 682, 'v1')
    const fCubic = measureEnvPoint(cubic.samples, cubic.sr, cubic.onsetSample, job, 'release')
    setXdProfile('v1')
    const wantCubic = releaseToSec(682)
    expect(fCubic.fallTimeSec).not.toBeNull()
    expect(Math.abs(fCubic.fallTimeSec! - wantCubic) / wantCubic).toBeLessThan(0.1)
  })
})
