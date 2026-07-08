/*
 * M2 job runner: spec validation, program building, and the replica render +
 * shared measurement path (the offline half of the vertical slice).
 */
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { loadJob, jobPoints, jobProgram } from '../tools/calib/lib/job'
import { renderJobPoint } from '../tools/calib/lib/render'
import { measurePoint } from '../tools/calib/lib/measure'
import { PARAM_BY_KEY } from '../src/synths/xd/params'

const JOBS = join(__dirname, '../tools/calib/jobs')

describe('job spec', () => {
  it('loads and validates vco1-a440.json', () => {
    const job = loadJob(join(JOBS, 'vco1-a440.json'))
    expect(job.id).toBe('vco1-a440')
    expect(jobPoints(job)).toEqual([null])
    const prog = jobProgram(job, null)
    expect(prog.params[PARAM_BY_KEY.get('cutoff')!.id]).toBe(1023)
    expect(prog.params[PARAM_BY_KEY.get('vco2Level')!.id]).toBe(0)
    expect(prog.name).toBe('VCO1-A440')
  })

  it('rejects unknown param keys and bad timing', () => {
    expect(() =>
      loadJob(join(__dirname, 'helpers/no-such-job.json')),
    ).toThrow()
  })

  it('bakes sweep points into the program', () => {
    const job = loadJob(join(JOBS, 'vco1-a440.json'))
    job.sweep = { param: 'cutoff', points: [0, 512] }
    const prog = jobProgram(job, 512)
    expect(prog.params[PARAM_BY_KEY.get('cutoff')!.id]).toBe(512)
  })
})

describe('replica render + measure', () => {
  it('vco1-a440 renders A4 within a few cents and a saw-like ladder', () => {
    const job = loadJob(join(JOBS, 'vco1-a440.json'))
    const r = renderJobPoint(job, null)
    expect(r.samples.length).toBe(Math.round(job.captureSec * r.sr))
    const f = measurePoint(r.samples, r.sr, r.onsetSample, job)
    // 4 strikes: round-robin covers all 4 voices
    expect(f.strikes.length).toBe(4)
    // replica drift is seeded and bounded (<4.2 cents worst case per strike)
    expect(Math.abs(f.cents)).toBeLessThan(5)
    expect(f.centsSpread).toBeGreaterThanOrEqual(0)
    expect(f.centsSpread).toBeLessThan(10)
    expect(f.harmonicsDb.length).toBe(8)
    expect(f.harmonicsDb[0]).toBe(0) // H1 reference
    // saw: H2 should sit near -6 dB re H1, well above -20
    expect(f.harmonicsDb[1]).toBeGreaterThan(-20)
    expect(f.harmonicsDb[1]).toBeLessThan(0)
    expect(f.peakDbfs).toBeLessThan(0)
  })

  it('is deterministic across renders', () => {
    const job = loadJob(join(JOBS, 'vco1-a440.json'))
    const a = renderJobPoint(job, null)
    const b = renderJobPoint(job, null)
    expect(a.samples).toEqual(b.samples)
  })
})
