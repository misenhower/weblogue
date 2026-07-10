/*
 * Integration glue between job kinds and the measurement/fit modules: one
 * measure dispatch used identically for hardware captures and replica
 * renders, per-kind one-line summaries for the live view, sweep-value
 * extraction (the per-point physical value a domain fit consumes), and the
 * domain -> Proposal builders behind the report's review gate.
 */
import type { CalibJob } from './job'
import { measurePoint, type PointFeatures } from './measure'
import { measureNoisePoint, transferDb, fitLpMag, type NoisePointFeatures } from './measure-noise'
import { measureEnvPoint, type EnvPointFeatures, type EnvSegment } from './measure-env'
import { proposeCurve, verifyPitchTable, type Proposal, type SweepPoint } from './proposal'
import { median } from './fit'
import { attackToSec, decayToSec, releaseToSec, cutoffToHz } from '../../../src/synths/xd/curves'

export type JobKind = 'tonal' | 'noise' | 'envelope'
export type AnyFeatures = PointFeatures | NoisePointFeatures | EnvPointFeatures

export interface AnyResult {
  point: number | null
  hw: AnyFeatures
  rep: AnyFeatures
}

export function jobKind(job: CalibJob): JobKind {
  return job.features.kind ?? 'tonal'
}

/** The one measurement entry point — hardware WAVs and replica renders alike. */
export function measureAny(x: Float32Array, sr: number, onsetSample: number, job: CalibJob): AnyFeatures {
  switch (jobKind(job)) {
    case 'noise':
      return measureNoisePoint(x, sr, onsetSample, job)
    case 'envelope':
      return measureEnvPoint(x, sr, onsetSample, job, job.features.env ?? 'attack')
    default:
      return measurePoint(x, sr, onsetSample, job)
  }
}

const ms = (s: number | null): string => (s === null ? 'n/a' : s < 1 ? `${(s * 1000).toFixed(1)} ms` : `${s.toFixed(2)} s`)

/** One-line feature summary per kind (live status lines + dashboard notes). */
export function summarize(job: CalibJob, f: AnyFeatures): string {
  switch (jobKind(job)) {
    case 'noise': {
      const n = f as NoisePointFeatures
      return `rms ${n.rmsDb.toFixed(1)} dBFS`
    }
    case 'envelope': {
      const e = f as EnvPointFeatures
      const seg = job.features.env ?? 'attack'
      if (seg === 'attack') return `attack ${ms(e.attackSec)}`
      if (seg === 'decay') return `decay ${ms(e.decayTimeSec)}`
      if (seg === 'release') return `release ${ms(e.releaseTimeSec)}`
      return `sustain ${e.sustainDb === null ? 'n/a' : e.sustainDb.toFixed(1) + ' dB'}`
    }
    default: {
      const t = f as PointFeatures
      const c = t.cents
      return `${t.f0Hz.toFixed(2)} Hz (${c >= 0 ? '+' : ''}${c.toFixed(1)}¢)`
    }
  }
}

/**
 * The AMP EG attack charges toward 1.3 and clips at 1.0 (src/dsp/eg.ts), so a
 * measured 10-90% rise is ln(3)/ln(13/3) ≈ 0.7492 of the displayed attack
 * time. Fits against attackToSec divide the measured rise by this factor;
 * whether the HARDWARE segment law shares the shape is itself a D5 question —
 * the raw rise stays in the features, only the fit applies the factor.
 */
export const ATTACK_RISE_FACTOR = Math.log(3) / Math.log(13 / 3)

/**
 * Per-point physical values a domain fit consumes, from one world's features.
 * noise: fitted 2-pole corner (fitLpMag.fcHz, NOT the -3 dB read — at res 0
 * the critically-damped VCF's half-power point sits at ~0.64*fc) of each
 * point's transfer vs the same world's max-raw reference point (which itself
 * yields null). envelope: displayed-time seconds (attack shape-corrected).
 * tonal: cents vs nominal.
 */
export function sweepValues(
  job: CalibJob,
  results: AnyResult[],
  world: 'hw' | 'rep',
): { unit: string; values: (number | null)[] } {
  const pick = (r: AnyResult): AnyFeatures => (world === 'hw' ? r.hw : r.rep)
  switch (jobKind(job)) {
    case 'noise': {
      const ref = results.reduce((a, b) => ((a.point ?? -1) >= (b.point ?? -1) ? a : b))
      const refF = pick(ref) as NoisePointFeatures
      // rail/r2 gate: near-closed-filter captures are noise-floor garbage —
      // the corner search rails toward its bound with a poor fit
      const gated = (fit: { fcHz: number; r2: number }): number | null =>
        fit.fcHz > 40000 || fit.r2 < 0.6 ? null : fit.fcHz
      return {
        unit: 'Hz',
        values: results.map((r) => {
          if (r === ref) return null
          const p = pick(r) as NoisePointFeatures
          // Per-strike path: strike k of every point lands on the same voice
          // (round-robin, repeat a multiple of 4), so transfer k measures
          // voice k's analog VCF — the point value is the median corner over
          // voices instead of whichever single voice the note landed on.
          const n = Math.min(p.strikePsdDb?.length ?? 0, refF.strikePsdDb?.length ?? 0)
          if (n >= 2) {
            const corners: number[] = []
            for (let k = 0; k < n; k++) {
              const t = p.strikePsdDb![k].map((d, i) => d - refF.strikePsdDb![k][i])
              const c = gated(fitLpMag(p.psdHz, t))
              if (c !== null) corners.push(c)
            }
            if (corners.length > 0) return median(corners)
          }
          return gated(fitLpMag(p.psdHz, transferDb(p, refF)))
        }),
      }
    }
    case 'envelope': {
      const seg: EnvSegment = job.features.env ?? 'attack'
      return {
        unit: 's',
        values: results.map((r) => {
          const e = pick(r) as EnvPointFeatures
          if (seg === 'attack') return e.attackSec === null ? null : e.attackSec / ATTACK_RISE_FACTOR
          if (seg === 'decay') return e.decayTimeSec
          if (seg === 'release') return e.releaseTimeSec
          return e.sustainDb
        }),
      }
    }
    default:
      return { unit: '¢', values: results.map((r) => (pick(r) as PointFeatures).cents) }
  }
}

/** Domain-aware Proposal builders — the fits behind the report's review gate. */
export function buildProposals(job: CalibJob, results: AnyResult[], world: 'hw' | 'rep' = 'hw'): Proposal[] {
  const swept = results.filter((r) => r.point !== null)
  if (swept.length < 4) return []
  const { values } = sweepValues(job, swept, world)
  const pts: SweepPoint[] = []
  for (let i = 0; i < swept.length; i++) {
    const v = values[i]
    if (v !== null && Number.isFinite(v)) pts.push({ raw: swept[i].point!, value: v })
  }
  if (pts.length < 4) return []

  if (job.domain === 'filter.cutoff' && jobKind(job) === 'noise') {
    return [proposeCurve('filter.cutoff — cutoffToHz', 'Hz', pts, cutoffToHz(0), cutoffToHz(1023))]
  }
  if (jobKind(job) === 'envelope') {
    const seg = job.features.env
    if (seg === 'attack') return [proposeCurve('eg.amp attack — attackToSec', 's', pts, attackToSec(0), attackToSec(1023))]
    if (seg === 'decay') return [proposeCurve('eg.amp decay — decayToSec', 's', pts, decayToSec(0), decayToSec(1023))]
    if (seg === 'release') return [proposeCurve('eg.amp release — releaseToSec', 's', pts, releaseToSec(0), releaseToSec(1023))]
    return []
  }
  if (job.domain === 'vco.pitch' && job.sweep?.param === 'vco1Pitch') {
    return [verifyPitchTable(pts)]
  }
  return []
}
