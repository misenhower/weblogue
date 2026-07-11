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
import {
  CAPTURE_HPF_FC,
  fitSqrDuty,
  fitTriFold,
  fitSawChop,
  type ShapeFit,
} from './measure-shape'

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

/**
 * Swept points that measured "successfully" but yielded no usable sweep value
 * (e.g. a release too short for the follower floor, a railed noise corner) —
 * one layer below point failures, and just as capable of silently thinning a
 * fit. The noise kind's max-raw reference point is null BY DESIGN and is not
 * counted. Returns the raw values, for coverage notes.
 */
export function unusableSweepPoints(job: CalibJob, results: AnyResult[], world: 'hw' | 'rep' = 'hw'): number[] {
  const swept = results.filter((r) => r.point !== null)
  if (swept.length === 0) return []
  const { values } = sweepValues(job, swept, world)
  const refPoint =
    jobKind(job) === 'noise' ? swept.reduce((a, b) => ((a.point ?? -1) >= (b.point ?? -1) ? a : b)).point : null
  const out: number[] = []
  for (let i = 0; i < swept.length; i++) {
    const v = values[i]
    if ((v === null || !Number.isFinite(v)) && swept[i].point !== refPoint) out.push(swept[i].point!)
  }
  return out
}

/** Piecewise-linear interpolation through sorted xs, clamped at both ends. */
function interpClamped(xs: readonly number[], ys: readonly number[], x: number): number {
  const n = xs.length
  if (x <= xs[0]) return ys[0]
  if (x >= xs[n - 1]) return ys[n - 1]
  let i = 1
  while (xs[i] < x) i++
  const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1])
  return ys[i - 1] + t * (ys[i] - ys[i - 1])
}

/**
 * Invert the corner-measurement bias through the replica (analysis-by-
 * synthesis). The replica renders of this session ran a KNOWN cutoff law
 * (the active profile), and the identical pipeline measured them — so
 * ln(true/measured), sampled at the replica's measured corners, IS the
 * extractor's bias curve (reference-rolloff division, critically-damped
 * shape, LF fit inflation). Hardware captures pass through the same pipeline
 * with the same source spectrum and a near-identical filter shape, so
 * evaluating that curve at each hardware-measured corner recovers the
 * hardware's true corner. Measured 2026-07-10: the fit reads a true 16 Hz
 * replica corner as 27 Hz (+70%) and 1.4 kHz as 1.26 kHz (-12%); a table
 * through UNCORRECTED hw corners left compare at ~12% RMS with
 * point-dependent sign, i.e. the bias had been transplanted into the knots.
 */
function biasCorrectCorners(
  job: CalibJob,
  swept: AnyResult[],
  targetValues: readonly (number | null)[],
): SweepPoint[] {
  const rep = sweepValues(job, swept, 'rep').values
  const bias: { x: number; y: number }[] = []
  for (let i = 0; i < swept.length; i++) {
    const m = rep[i]
    if (m === null || !Number.isFinite(m) || m <= 0) continue
    bias.push({ x: Math.log(m), y: Math.log(cutoffToHz(swept[i].point!)) - Math.log(m) })
  }
  bias.sort((a, b) => a.x - b.x)
  const bx = bias.map((b) => b.x)
  const by = bias.map((b) => b.y)
  const out: SweepPoint[] = []
  for (let i = 0; i < swept.length; i++) {
    const m = targetValues[i]
    if (m === null || !Number.isFinite(m) || m <= 0) continue
    const lm = Math.log(m)
    out.push({
      raw: swept[i].point!,
      value: bias.length >= 2 ? Math.exp(lm + interpClamped(bx, by, lm)) : m,
    })
  }
  return out
}

/**
 * D2 SHAPE-morph proposals: per-point model-parameter fits from the stored
 * mean cycles (measure-shape.ts), one table per model parameter. The fit
 * chain matches the world: hardware cycles carry the capture coupling
 * (CAPTURE_HPF_FC in the loop), replica renders don't. Residuals are
 * waveform-relative — the tier-3 morph structure was reviewed separately;
 * these tables are its parameters.
 */
function proposeShapeModels(job: CalibJob, swept: AnyResult[], world: 'hw' | 'rep'): Proposal[] {
  const wave = Number(job.overrides?.['vco1Wave'] ?? 2)
  const fc = world === 'hw' ? CAPTURE_HPF_FC : 0
  const pts: { raw: number; f: PointFeatures }[] = []
  for (const r of swept) {
    const f = (world === 'hw' ? r.hw : r.rep) as PointFeatures
    if (f.shapeCycle) pts.push({ raw: r.point!, f })
  }
  if (pts.length < 4) return []

  const mkProposal = (
    domain: string,
    unit: string,
    current: string,
    fits: { raw: number; fit: ShapeFit }[],
    value: (f: ShapeFit) => number,
    extraNotes: string[] = [],
  ): Proposal => {
    const resMean = fits.reduce((a, p) => a + p.fit.res, 0) / fits.length
    const resMax = fits.reduce((a, p) => Math.max(a, p.fit.res), 0)
    return {
      domain,
      unit,
      current,
      proposed: `monotone-ish table (${fits.length} pts, waveform fit)`,
      fitResidualPct: resMean * 100,
      heldOutResidualPct: NaN,
      table: fits.map((p) => [p.raw, Number(value(p.fit).toPrecision(4))]),
      notes: [
        `per-point waveform residual: mean ${(resMean * 100).toFixed(1)}%, worst ${(resMax * 100).toFixed(1)}%`,
        `fit chain: ${fc > 0 ? `capture coupling ${fc} Hz in the loop` : 'replica (no coupling)'}`,
        ...extraNotes,
      ],
    }
  }

  if (wave === 0) {
    // SHAPE-max is measured SILENCE (duty 0) — fitting a pulse to the noise
    // floor there poisons the table and the swing check
    const silent = pts.filter((p) => p.f.peakDbfs < -50)
    const live = pts.filter((p) => p.f.peakDbfs >= -50)
    const fits = live.map((p) => ({ raw: p.raw, fit: fitSqrDuty(p.f.shapeCycle!, fc) }))
    const lv = fits.map((p) => p.fit.level).filter((l) => l > 0)
    const swing = lv.length > 1 ? Math.min(...lv) / Math.max(...lv) : 1
    const prop = mkProposal(
      'vco.shape SQR — sqrDuty',
      'duty',
      'profile sqrDuty table (v4) / legacy 0.5-0.5*shape',
      fits,
      (f) => f.param,
      [
        `constant-swing check: min/max fitted level = ${swing.toFixed(2)} (hardware measured ~0.9)`,
        ...(silent.length
          ? [`silent point(s) at ${silent.map((p) => p.raw).join(', ')} — recorded as duty 0, excluded from the fit stats`]
          : []),
      ],
    )
    for (const p of silent) prop.table!.push([p.raw, 0])
    prop.table!.sort((a, b) => a[0] - b[0])
    return [prop]
  }
  if (wave === 1) {
    // global knee first (drive refits per candidate), then per-point tables
    let bestKnee = 0
    let bestRes = Infinity
    for (let knee = 0; knee <= 0.31; knee += 0.03) {
      let acc = 0
      for (const p of pts) acc += fitTriFold(p.f.shapeCycle!, fc, knee).res
      if (acc < bestRes) {
        bestRes = acc
        bestKnee = knee
      }
    }
    const fits = pts.map((p) => ({ raw: p.raw, fit: fitTriFold(p.f.shapeCycle!, fc, bestKnee) }))
    const lv0 = fits[0].fit.level || 1
    return [
      mkProposal('vco.shape TRI — triFoldDrive', "g'", 'profile triFoldDrive table (v4)', fits, (f) => f.param, [
        `soft-fold knee fit: r = ${bestKnee.toFixed(2)} (triFoldKnee)`,
      ]),
      mkProposal('vco.shape TRI — triFoldLevel', 'x', 'profile triFoldLevel table (v4)', fits, (f) => f.level / lv0),
    ]
  }
  const fits = pts.map((p) => ({ raw: p.raw, fit: fitSawChop(p.f.shapeCycle!, fc) }))
  return [
    mkProposal('vco.shape SAW — sawChopDepth', 'm', 'profile sawChopDepth table (v4)', fits, (f) => f.param),
    mkProposal('vco.shape SAW — sawChopPhase', 'phi', 'profile sawChopPhase table (v4)', fits, (f) => f.param2, [
      'phi is unidentifiable where m ~ 0 (no flip transient) — ignore low-shape rows',
    ]),
  ]
}

/** Domain-aware Proposal builders — the fits behind the report's review gate. */
export function buildProposals(job: CalibJob, results: AnyResult[], world: 'hw' | 'rep' = 'hw'): Proposal[] {
  const swept = results.filter((r) => r.point !== null)
  if (swept.length < 4) return []
  if (job.domain === 'vco.shape') return proposeShapeModels(job, swept, world)
  const { values } = sweepValues(job, swept, world)
  const pts: SweepPoint[] = []
  for (let i = 0; i < swept.length; i++) {
    const v = values[i]
    if (v !== null && Number.isFinite(v)) pts.push({ raw: swept[i].point!, value: v })
  }
  if (pts.length < 4) return []

  if (job.domain === 'filter.cutoff' && jobKind(job) === 'noise') {
    const corrected = biasCorrectCorners(job, swept, values)
    return [
      proposeCurve('filter.cutoff — cutoffToHz', 'Hz', corrected, cutoffToHz(0), cutoffToHz(1023), {
        forceTable:
          'cutoff is a table, not an expMap (Matt, 2026-07-10); corners are bias-corrected ' +
          'through the replica inversion (see domains.ts biasCorrectCorners)',
      }),
    ]
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
