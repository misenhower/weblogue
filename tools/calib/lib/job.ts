/*
 * Calibration job specs: a committed JSON file describing one measurement —
 * base patch (param-KEY overrides on the init program), optional single-param
 * sweep, a note plan, capture length, and what to extract. Params are
 * referenced by their stable string key (PARAM_BY_KEY), never numeric id.
 */
import { readFileSync } from 'node:fs'
import { PARAM_BY_KEY, clampParam } from '../../../src/synths/xd/params'
import { initProgram } from '../../../src/synths/xd/program'
import type { Program } from '../../../src/shared/program'
import { XD_CALIBRATION_FIELDS, type XdCalibrationField } from '../../../src/synths/xd/profiles'

export interface JobNote {
  midi: number
  vel: number
  onSec: number
  offSec: number
}

export interface CalibJob {
  id: string
  domain: string
  description?: string
  /** Exact versioned profile fields this job can authorize on acceptance. */
  profileFields?: XdCalibrationField[]
  /** param key -> raw value, applied over initProgram() */
  overrides?: Record<string, number>
  /** optional single-param sweep; absent = one point at the base patch */
  sweep?: { param: string; points: number[] }
  /** present = job is not runnable yet; the value says why (skipped by `run all`) */
  disabled?: string
  notes: JobNote[]
  /**
   * Repeat the note plan this many times per capture (default 1), each
   * repetition shifted by repeatEverySec. Round-robin allocation means each
   * strike lands on a different voice — 4 repeats covers all xd voices and
   * the report shows median + per-strike spread.
   */
  repeat?: number
  repeatEverySec?: number
  captureSec: number
  features: {
    nominalHz?: number
    harmonics?: number
    /** measurement kind: tonal (default), noise (PSD transfer), envelope (EG segment) */
    kind?: 'tonal' | 'noise' | 'envelope'
    /** which EG segment an envelope job measures */
    env?: 'attack' | 'decay' | 'release' | 'sustain'
    /**
     * Fundamental ratios (vs nominalHz) the pitch seed also accepts — for
     * model-informed sweeps whose true fundamental legitimately moves: the
     * SAW morph period-doubles (0.5) and the TRI fold ends at an exact
     * triple (3). Absent = [1].
     */
    nominalRatios?: number[]
  }
}

/** Trusted mapping from measurement design to fields it can authorize.
 * A job may describe these fields for review, but cannot expand this set. */
export function expectedProfileFields(job: CalibJob): XdCalibrationField[] {
  if (job.domain === 'filter.cutoff') return ['cutoffHz']
  if (job.domain === 'eg.amp') {
    if (job.features?.env === 'attack') return ['egAttackSec']
    if (job.features?.env === 'decay') return ['egDecaySec']
    // the release measurement also establishes the fall-curve power (D5)
    if (job.features?.env === 'release') return ['egReleaseSec', 'egFallPower']
    return []
  }
  if (job.domain === 'vco.pitch' && job.sweep?.param === 'vco1Pitch') return ['vcoPitchCents']
  if (job.domain === 'vco.shape') {
    const wave = Number(job.overrides?.vco1Wave)
    if (wave === 0) return ['sqrDuty', 'sqrPwMin']
    if (wave === 1) return ['triFoldDrive', 'triFoldLevel', 'triFoldKnee']
    if (wave === 2) return ['sawMirrorW']
  }
  return []
}

/** The note plan with repeats expanded to absolute times. */
export function expandNotes(job: CalibJob): JobNote[] {
  const reps = job.repeat ?? 1
  const period = job.repeatEverySec ?? 0
  const out: JobNote[] = []
  for (let r = 0; r < reps; r++) {
    for (const n of job.notes) {
      out.push({ ...n, onSec: n.onSec + r * period, offSec: n.offSec + r * period })
    }
  }
  return out
}

/** Parse + validate a job file; throws with a readable message on bad specs. */
export function loadJob(path: string): CalibJob {
  const job = JSON.parse(readFileSync(path, 'utf8')) as CalibJob
  const fail = (msg: string): never => {
    throw new Error(`${path}: ${msg}`)
  }
  if (!job.id || typeof job.id !== 'string') fail('missing "id"')
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(job.id)) fail('"id" must be a safe lowercase file slug')
  if (!job.domain || typeof job.domain !== 'string') fail('missing "domain"')
  if (job.profileFields !== undefined) {
    if (!Array.isArray(job.profileFields) || job.profileFields.length === 0) fail('empty "profileFields"')
    for (const field of job.profileFields) {
      if (!(XD_CALIBRATION_FIELDS as readonly string[]).includes(field)) fail(`unknown profile field "${field}"`)
    }
    // The trusted mapping CAPS what a measurement design can authorize; a job
    // may deliberately declare a SUBSET (and older frozen session copies stay
    // loadable when the mapping later widens), never anything outside it.
    const declared = [...new Set(job.profileFields)]
    const expected = expectedProfileFields(job)
    const outside = declared.filter((field) => !expected.includes(field))
    if (outside.length > 0) {
      fail(`profileFields exceed the trusted mapping (${expected.join(', ') || '(none)'}): ${outside.join(', ')}`)
    }
  }
  if (!Array.isArray(job.notes) || job.notes.length === 0) fail('missing "notes"')
  for (const n of job.notes) {
    if (!(n.midi >= 0 && n.midi <= 127)) fail(`bad note midi ${n.midi}`)
    if (!(n.vel >= 1 && n.vel <= 127)) fail(`bad note vel ${n.vel}`)
    if (!(n.onSec >= 0 && n.offSec > n.onSec)) fail(`bad note timing ${n.onSec}..${n.offSec}`)
  }
  if (!(job.captureSec > 0 && job.captureSec <= 120)) fail('bad "captureSec"')
  const reps = job.repeat ?? 1
  if (!(reps >= 1 && reps <= 100)) fail('bad "repeat"')
  if (reps > 1) {
    const span = Math.max(...job.notes.map((n) => n.offSec))
    if (!(job.repeatEverySec !== undefined && job.repeatEverySec > span))
      fail(`"repeatEverySec" must exceed the note plan span (${span}s)`)
  }
  const last = Math.max(...expandNotes(job).map((n) => n.offSec))
  if (last >= job.captureSec) fail(`notes end at ${last}s but captureSec is ${job.captureSec}s`)
  for (const key of Object.keys(job.overrides ?? {})) {
    if (!PARAM_BY_KEY.has(key)) fail(`unknown override param key "${key}"`)
  }
  if (job.sweep) {
    if (!PARAM_BY_KEY.has(job.sweep.param)) fail(`unknown sweep param key "${job.sweep.param}"`)
    if (!Array.isArray(job.sweep.points) || job.sweep.points.length === 0) fail('empty sweep points')
  }
  const kind = job.features?.kind ?? 'tonal'
  if (!['tonal', 'noise', 'envelope'].includes(kind)) fail(`unknown features.kind "${kind}"`)
  if (kind === 'envelope') {
    if (!job.features.env) fail('envelope jobs need features.env (attack|decay|release|sustain)')
    if (!job.features.nominalHz) fail('envelope jobs need features.nominalHz (tone-locked follower)')
  }
  return job
}

/** The job's sweep points, or a single null point for non-sweep jobs. */
export function jobPoints(job: CalibJob): (number | null)[] {
  return job.sweep ? job.sweep.points : [null]
}

/**
 * Build the full Program for one point: init + overrides (+ the sweep value
 * baked in, so a SysEx push of this program is the complete state — no CC
 * needed). Values are clamped to each param's legal range.
 */
export function jobProgram(job: CalibJob, point: number | null): Program {
  const prog = initProgram()
  prog.name = job.id.toUpperCase().replace(/[^ -~]/g, ' ').slice(0, 12)
  for (const [key, raw] of Object.entries(job.overrides ?? {})) {
    const meta = PARAM_BY_KEY.get(key)!
    prog.params[meta.id] = clampParam(meta.id, raw)
  }
  if (job.sweep && point !== null) {
    const meta = PARAM_BY_KEY.get(job.sweep.param)!
    prog.params[meta.id] = clampParam(meta.id, point)
  }
  return prog
}
