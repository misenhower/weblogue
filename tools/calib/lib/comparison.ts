/* Reproducible hardware-vs-profile comparison from a promoted evidence set. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setXdProfile } from '../../../src/synths/xd/profiles'
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
  if (!setXdProfile(profile)) throw new Error(`unknown calibration profile "${profile}"`)
  const job = loadJob(join(dir, 'job.json'))
  const features = readFeatures(dir)
  const fresh: AnyResult[] = features.results.map((stored) => {
    const render = renderJobPoint(job, stored.point)
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
    const ladderError = (hardware: PointFeatures, replica: PointFeatures): number => {
      const count = Math.min(hardware.harmonicsDb.length, replica.harmonicsDb.length)
      const errors: number[] = []
      for (let harmonic = 1; harmonic < count; harmonic++) {
        const error = Math.abs(hardware.harmonicsDb[harmonic] - replica.harmonicsDb[harmonic])
        if (Number.isFinite(error)) errors.push(error)
      }
      return errors.length ? median(errors) : NaN
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
