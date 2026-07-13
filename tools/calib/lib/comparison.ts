/* Reproducible hardware-vs-profile comparison from a promoted evidence set. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveXdProfile } from '../../../src/synths/xd/profiles'
import { loadJob } from './job'
import { renderJobPoint } from './render'
import { measureAny, sweepValues, unusableSweepPoints, type AnyResult } from './domains'
import type { PointFeatures } from './measure'
import type { VerificationPoint } from './workflow'

export interface StoredFeatures {
  domain: string
  replicaProfile?: string
  planned?: number
  results: AnyResult[]
  pointFailures?: unknown[]
  proposals?: unknown[]
}

export interface Comparison {
  domain: string
  unit: string
  rows: VerificationPoint[]
  coverageComplete: boolean
}

export function readFeatures(dir: string): StoredFeatures {
  return JSON.parse(readFileSync(join(dir, 'features.json'), 'utf8')) as StoredFeatures
}

/** Re-render one stored capture set under a candidate profile. */
export function compareEvidence(dir: string, profile: string): Comparison {
  if (!resolveXdProfile(profile)) throw new Error(`unknown calibration profile "${profile}"`)
  const job = loadJob(join(dir, 'job.json'))
  const features = readFeatures(dir)
  const fresh: AnyResult[] = features.results.map((stored) => {
    const render = renderJobPoint(job, stored.point, profile)
    return {
      point: stored.point,
      hw: stored.hw,
      rep: measureAny(render.samples, render.sr, render.onsetSample, job),
    }
  })
  if (job.domain === 'vco.shape') {
    const median = (values: number[]): number => {
      values.sort((a, b) => a - b)
      const mid = values.length >> 1
      return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2
    }
    // Harmonics below this (re H1) are floor/leakage, not signal: the analog
    // hardware leaks tiny even harmonics (~-45 dB) where an odd-symmetric
    // replica wave sits at NUMERICAL zero (-110 dB) — comparing those raw
    // would let 60+ dB of sub-floor garbage dominate the median (the TRI
    // verify false-fail, 2026-07-13). Same floor the envelope fits use.
    const LADDER_FLOOR_DB = -40
    const ladderError = (hardware: PointFeatures, replica: PointFeatures): number => {
      const count = Math.min(hardware.harmonicsDb.length, replica.harmonicsDb.length)
      const errors: number[] = []
      for (let harmonic = 1; harmonic < count; harmonic++) {
        const hw = hardware.harmonicsDb[harmonic]
        const rep = replica.harmonicsDb[harmonic]
        // both sub-floor: the harmonic carries no information — skipping it
        // keeps the median over SIGNAL harmonics (counting such pairs as
        // zero-error let a near-sine TRI degenerate the whole metric to 0.00)
        if (hw < LADDER_FLOOR_DB && rep < LADDER_FLOOR_DB) continue
        const error = Math.abs(Math.max(hw, LADDER_FLOOR_DB) - Math.max(rep, LADDER_FLOOR_DB))
        if (Number.isFinite(error)) errors.push(error)
      }
      // no informative harmonics at all = both worlds silent alike
      return errors.length ? median(errors) : 0
    }
    const rows: VerificationPoint[] = []
    for (let i = 0; i < fresh.length; i++) {
      const hardware = fresh[i].hw as PointFeatures
      const before = features.results[i].rep as PointFeatures
      const after = fresh[i].rep as PointFeatures
      const b = ladderError(hardware, before)
      const a = ladderError(hardware, after)
      if (Number.isFinite(b) && Number.isFinite(a)) {
        rows.push({ raw: fresh[i].point, hardware: 0, before: b, after: a })
      }
    }
    const failures = features.pointFailures?.length ?? 0
    const planned = features.planned ?? features.results.length + failures
    return {
      domain: features.domain ?? job.domain,
      unit: 'dB',
      rows,
      coverageComplete:
        failures === 0 && features.results.length === planned && rows.length === features.results.length,
    }
  }
  const { unit, values: hardware } = sweepValues(job, fresh, 'hw')
  const { values: after } = sweepValues(job, fresh, 'rep')
  const { values: before } = sweepValues(job, features.results, 'rep')
  const rows: VerificationPoint[] = []
  for (let i = 0; i < fresh.length; i++) {
    const h = hardware[i]
    const b = before[i]
    const a = after[i]
    if (
      h === null || b === null || a === null ||
      !Number.isFinite(h) || !Number.isFinite(b) || !Number.isFinite(a)
    ) continue
    rows.push({ raw: fresh[i].point, hardware: h, before: b, after: a })
  }
  const failures = features.pointFailures?.length ?? 0
  const planned = features.planned ?? features.results.length + failures
  const coverageComplete =
    failures === 0 && features.results.length === planned && unusableSweepPoints(job, fresh).length === 0
  return { domain: features.domain ?? job.domain, unit, rows, coverageComplete }
}
