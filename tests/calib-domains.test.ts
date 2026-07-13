/*
 * M3 integration: job-kind validation and the end-to-end replica
 * self-calibration property — running the render -> measure -> sweep-value ->
 * proposal pipeline on the replica's OWN output must recover the replica's
 * own curves.ts values. This is the plumbing proof the hardware sessions
 * stand on.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { loadJob } from '../tools/calib/lib/job'
import { renderJobPoint } from '../tools/calib/lib/render'
import {
  measureAny,
  sweepValues,
  buildProposals,
  unusableSweepPoints,
  type AnyResult,
} from '../tools/calib/lib/domains'
import { cutoffToHz, attackToSec } from '../src/synths/xd/curves'
import { setXdProfile, XD_DEFAULT_PROFILE } from '../src/synths/xd/profiles'

const JOBS = join(__dirname, '../tools/calib/jobs')

/** Render + measure a subset of a job's sweep as if both worlds were the replica. */
function selfResults(jobPath: string, points: number[]): { job: ReturnType<typeof loadJob>; results: AnyResult[] } {
  const job = loadJob(jobPath)
  const results: AnyResult[] = points.map((pt) => {
    const r = renderJobPoint(job, pt)
    const f = measureAny(r.samples, r.sr, r.onsetSample, job)
    return { point: pt, hw: f, rep: f }
  })
  return { job, results }
}

describe('unusableSweepPoints (feature-level nulls thin fits silently)', () => {
  const env = (releaseTimeSec: number | null): AnyResult['hw'] => ({
    peakDbfs: -20,
    attackSec: 0.01,
    decayTimeSec: 0.5,
    releaseTimeSec,
    sustainDb: -0.5,
  })
  const envJob = {
    id: 't',
    domain: 'eg.amp',
    notes: [{ midi: 69, vel: 100, onSec: 0.3, offSec: 1.5 }],
    captureSec: 3,
    sweep: { param: 'ampRelease', points: [0, 512, 1023] },
    features: { kind: 'envelope', env: 'release', nominalHz: 440 },
  } as ReturnType<typeof loadJob>

  it('flags null-valued envelope points, not the healthy ones', () => {
    const results: AnyResult[] = [
      { point: 0, hw: env(null), rep: env(null) }, // measured, no usable value
      { point: 512, hw: env(0.75), rep: env(0.75) },
      { point: 1023, hw: env(16.6), rep: env(16.6) },
    ]
    expect(unusableSweepPoints(envJob, results)).toEqual([0])
    expect(unusableSweepPoints(envJob, results.slice(1))).toEqual([])
  })

  it('does not count the noise kind\'s by-design-null reference point', () => {
    const { job, results } = (() => {
      const j = loadJob(join(JOBS, 'cutoff-sweep.json'))
      const pts = [512, 1023].map((pt) => {
        const r = renderJobPoint(j, pt)
        const f = measureAny(r.samples, r.sr, r.onsetSample, j)
        return { point: pt, hw: f, rep: f }
      })
      return { job: j, results: pts }
    })()
    // raw 1023 is the transfer reference (null by design) — not "unusable"
    expect(unusableSweepPoints(job, results)).toEqual([])
  })
})

describe('job kind validation', () => {
  const write = (features: object): string => {
    const dir = mkdtempSync(join(tmpdir(), 'calib-job-'))
    const path = join(dir, 'bad.json')
    writeFileSync(
      path,
      JSON.stringify({
        id: 'bad',
        domain: 'x',
        notes: [{ midi: 69, vel: 100, onSec: 0.3, offSec: 1.0 }],
        captureSec: 2,
        features,
      }),
    )
    return path
  }
  it('rejects unknown kinds and incomplete envelope specs', () => {
    expect(() => loadJob(write({ kind: 'spectral' }))).toThrow(/unknown features.kind/)
    expect(() => loadJob(write({ kind: 'envelope', nominalHz: 440 }))).toThrow(/features.env/)
    expect(() => loadJob(write({ kind: 'envelope', env: 'attack' }))).toThrow(/nominalHz/)
  })
  it('accepts the committed job files', () => {
    for (const j of ['cutoff-sweep', 'eg-attack', 'eg-decay', 'eg-release', 'vco1-a440']) {
      expect(() => loadJob(join(JOBS, `${j}.json`))).not.toThrow()
    }
  })
})

describe('replica self-calibration (end-to-end pipeline proof)', () => {
  // The proof is "the pipeline recovers KNOWN curves from the replica's own
  // output". Pin the profile whose curves the assertions reference — the
  // pitch check compares against the DOCUMENTED table, which only the v0
  // engine law matches (measured profiles deliberately diverge from it).
  beforeAll(() => setXdProfile('v0'))
  afterAll(() => setXdProfile(XD_DEFAULT_PROFILE))

  it('cutoff-sweep: fitted corners track cutoffToHz and the expMap proposal fits', () => {
    // raw 1023 is the transfer reference; mid points carry the fit
    const { job, results } = selfResults(join(JOBS, 'cutoff-sweep.json'), [128, 320, 512, 704, 896, 1023])
    const { unit, values } = sweepValues(job, results, 'rep')
    expect(unit).toBe('Hz')
    for (let i = 0; i < results.length; i++) {
      const v = values[i]
      if (results[i].point === 1023) {
        expect(v).toBeNull() // the reference point has no transfer of its own
        continue
      }
      // fitLpMag recovers the VCF cutoff within ~25% (reference-rolloff
      // division and critically-damped shape cost accuracy; see
      // measure-noise notes) — sufficient for expMap endpoint fitting
      const expected = cutoffToHz(results[i].point!)
      expect(v).not.toBeNull()
      expect(Math.abs(Math.log(v! / expected))).toBeLessThan(Math.log(1.3))
    }
    const proposals = buildProposals(job, results, 'rep')
    expect(proposals).toHaveLength(1)
    // cutoff proposes a table by standing decision (Matt, 2026-07-10); the
    // pipeline proof is that the table knots recover the KNOWN v0 curve
    expect(proposals[0].proposed).toContain('monotone table')
    expect(proposals[0].notes.some((n: string) => n.includes('standing decision'))).toBe(true)
    expect(proposals[0].notes.some((n: string) => n.includes('final table refit on all'))).toBe(true)
    for (const [raw, hz] of proposals[0].table!) {
      expect(Math.abs(Math.log(hz / cutoffToHz(raw)))).toBeLessThan(Math.log(1.3))
    }
  }, 60_000)

  it('eg-attack: shape-corrected rise recovers attackToSec', () => {
    const { job, results } = selfResults(join(JOBS, 'eg-attack.json'), [341, 512, 682, 852, 1023])
    const { unit, values } = sweepValues(job, results, 'rep')
    expect(unit).toBe('s')
    for (let i = 0; i < results.length; i++) {
      const expected = attackToSec(results[i].point!)
      expect(values[i]).not.toBeNull()
      // ATTACK_RISE_FACTOR maps the 10-90% rise back to displayed time
      expect(Math.abs(values[i]! / expected - 1)).toBeLessThan(0.15)
    }
    const proposals = buildProposals(job, results, 'rep')
    expect(proposals).toHaveLength(1)
    expect(proposals[0].domain).toContain('attack')
    expect(proposals[0].fitResidualPct).toBeLessThan(15)
  }, 60_000)

  it('tonal jobs produce cents sweep values and pitch-table verification', () => {
    const { job, results } = selfResults(join(JOBS, 'vco1-pitch-knob.json'), [4, 356, 512, 668, 1020])
    const { unit } = sweepValues(job, results, 'rep')
    expect(unit).toBe('¢')
    const proposals = buildProposals(job, results, 'rep')
    expect(proposals).toHaveLength(1)
    // the replica measured against its own pitchToCents: no >3¢ deviations
    expect(proposals[0].notes.filter((n) => n.includes('raw')).length).toBe(0)
  }, 60_000)
})
