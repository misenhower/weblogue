import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  evaluateVerification,
  verificationThreshold,
  type VerificationPoint,
} from '../tools/calib/lib/workflow'
import { acceptEvidence, promoteEvidence, validateAcceptedResult } from '../tools/calib/lib/evidence'
import { profileLineageProblems } from '../tools/calib/lib/lineage'
import { verifyCommand } from '../tools/calib/lib/review'
import { renderJobPoint } from '../tools/calib/lib/render'
import { measureAny, type AnyResult } from '../tools/calib/lib/domains'
import {
  setXdProfile,
  XD_PROFILES,
  XD_DEFAULT_PROFILE,
  type XdCalibProfile,
} from '../src/synths/xd/profiles'
import type { CalibJob } from '../tools/calib/lib/job'

const point = (before: number, after: number): VerificationPoint => ({
  raw: 512,
  hardware: 1,
  before,
  after,
})

describe('calibration verification gate', () => {
  it('passes an independent, complete cutoff verification below the 5% threshold', () => {
    const result = evaluateVerification({
      domain: 'filter.cutoff',
      unit: 'Hz',
      independent: true,
      coverageComplete: true,
      points: [point(1.2, 1.03), point(0.8, 0.98), point(1.15, 1.02)],
    })

    expect(result.threshold).toBe(0.05)
    expect(result.afterScore).toBeLessThan(0.05)
    expect(result.passed).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('rejects reuse of the fitting session and incomplete coverage', () => {
    const result = evaluateVerification({
      domain: 'eg.amp',
      unit: 's',
      independent: false,
      coverageComplete: false,
      points: [point(1.5, 1.01)],
    })

    expect(result.passed).toBe(false)
    expect(result.reasons).toContain('verification must use a different session from the fit')
    expect(result.reasons).toContain('verification session has failed or unusable sweep points')
  })

  it('rejects a result that improved but still misses the domain threshold', () => {
    const result = evaluateVerification({
      domain: 'eg.amp',
      unit: 's',
      independent: true,
      coverageComplete: true,
      points: [point(1.5, 1.12), point(0.7, 0.9)],
    })

    expect(result.afterScore).toBeGreaterThan(0.05)
    expect(result.passed).toBe(false)
    expect(result.reasons.some((reason) => reason.includes('threshold'))).toBe(true)
  })

  it('rejects a material point regression even when aggregate RMS passes', () => {
    const result = evaluateVerification({
      domain: 'filter.cutoff',
      unit: 'Hz',
      independent: true,
      coverageComplete: true,
      points: [point(1.2, 1.01), point(0.98, 0.94)],
    })
    expect(result.afterScore).toBeLessThan(0.05)
    expect(result.passed).toBe(false)
    expect(result.reasons.some((reason) => reason.includes('regressed materially'))).toBe(true)
  })

  it('tolerates a point that got worse than baseline while staying within spec', () => {
    // capture repeatability, not a defect (the SQR verify false-fail):
    // before 0.07 dB -> after 0.64 dB against a 1.5 dB threshold must pass
    const result = evaluateVerification({
      domain: 'vco.shape',
      unit: 'dB',
      independent: true,
      coverageComplete: true,
      points: [
        { raw: 192, hardware: 0, before: 0.07, after: 0.64 },
        { raw: 576, hardware: 0, before: 2.27, after: 0.06 },
      ],
    })
    expect(result.passed).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('uses the documented 2-cent pitch threshold', () => {
    expect(verificationThreshold('vco.pitch', '¢')).toBe(2)
    const result = evaluateVerification({
      domain: 'vco.pitch',
      unit: '¢',
      independent: true,
      coverageComplete: true,
      points: [
        { raw: 400, hardware: -66, before: -80, after: -65 },
        { raw: 600, hardware: 42, before: 55, after: 43 },
      ],
    })
    expect(result.passed).toBe(true)
  })

  it('refuses domains without an implemented verification metric', () => {
    const result = evaluateVerification({
      domain: 'vco.drift',
      unit: '¢',
      independent: true,
      coverageComplete: true,
      points: [point(10, 1)],
    })
    expect(result.passed).toBe(false)
    expect(result.reasons).toContain('no acceptance threshold is implemented for vco.drift')
  })

  it('accepts SHAPE harmonic-ladder errors below 1.5 dB', () => {
    const result = evaluateVerification({
      domain: 'vco.shape',
      unit: 'dB',
      independent: true,
      coverageComplete: true,
      points: [
        { raw: 96, hardware: 0, before: 4.2, after: 1.1 },
        { raw: 608, hardware: 0, before: 5.8, after: 1.3 },
      ],
    })
    expect(result.threshold).toBe(1.5)
    expect(result.passed).toBe(true)
  })
})

describe('canonical calibration evidence', () => {
  it('requires real accepted results for every field changed by a procedure-declaring profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'calib-lineage-'))
    const base = XD_PROFILES.find((profile) => profile.id === 'v3')!
    const candidate: XdCalibProfile = {
      ...base,
      id: 'v5',
      procedure: { id: 'xd-hardware-calibration' as const, revision: 1 },
      cutoffHz: { kind: 'expMap' as const, lo: 18, hi: 19_000 },
      lfoMaxPitchCents: base.lfoMaxPitchCents + 1,
      lineage: {
        baseProfile: 'v3',
        evidence: {
          cutoffHz: 'calib/results/v5/filter.cutoff.json',
        },
      },
    }
    mkdirSync(join(root, 'calib', 'results', 'v5'), { recursive: true })
    writeFileSync(
      join(root, 'calib', 'results', 'v5', 'filter.cutoff.json'),
      JSON.stringify({
        profile: 'v5',
        profileDigest: 'candidate-digest',
        procedure: candidate.procedure,
        profileFields: ['cutoffHz'],
      }),
    )

    const missing = profileLineageProblems(root, candidate, [base, candidate], 'candidate-digest')
    expect(missing).toContain('changed field lfoMaxPitchCents has no accepted result')
    expect(missing.some((problem) => problem.includes('does not reference candidate evidence'))).toBe(true)
    candidate.lineage!.evidence.lfoMaxPitchCents = 'calib/results/v5/vco.lfo.json'
    writeFileSync(
      join(root, 'calib', 'results', 'v5', 'vco.lfo.json'),
      JSON.stringify({
        profile: 'v5',
        profileDigest: 'candidate-digest',
        procedure: candidate.procedure,
        profileFields: ['lfoMaxPitchCents'],
      }),
    )
    const fabricated = profileLineageProblems(root, candidate, [base, candidate], 'candidate-digest')
    expect(fabricated.some((problem) => problem.includes('does not reference candidate evidence'))).toBe(true)
  })

  it('rejects a profile whose procedure-declaring base has invalid lineage', () => {
    const root = mkdtempSync(join(tmpdir(), 'calib-lineage-base-'))
    const legacy = XD_PROFILES.find((profile) => profile.id === 'v3')!
    const invalidBase: XdCalibProfile = {
      ...legacy,
      id: 'v5',
      procedure: { id: 'xd-hardware-calibration', revision: 1 },
    }
    const child: XdCalibProfile = {
      ...invalidBase,
      id: 'v6',
      lineage: { baseProfile: 'v5', evidence: {} },
    }
    expect(profileLineageProblems(root, child, [legacy, invalidBase, child], 'child-digest')).toContain(
      'base v5: procedure-declaring profile has no lineage',
    )
  })

  it('promotes only derived artifacts and records their checksums', () => {
    const root = mkdtempSync(join(tmpdir(), 'calib-evidence-'))
    const session = join(root, 'calib', 'sessions', '2026-07-12T12-00-cutoff')
    mkdirSync(join(session, 'raw'), { recursive: true })
    for (const name of ['job.json', 'meta.json', 'features.json']) {
      writeFileSync(
        join(session, name),
        JSON.stringify({
          name,
          ...(name === 'meta.json'
            ? {
                procedure: { id: 'xd-hardware-calibration', revision: 1 },
                rig: {
                  hardwareUnit: { unitId: 'xd-unit-1' },
                  captureChain: { interface: 'test interface', sampleRateHz: 48_000 },
                },
              }
            : {}),
        }) + '\n',
      )
    }
    writeFileSync(join(session, 'report.md'), `Session: \`${session}\`\n`)
    writeFileSync(join(session, 'raw', 'point-000.wav'), 'not really a wav')

    const result = promoteEvidence(root, session)
    expect(result.name).toBe('2026-07-12T12-00-cutoff')
    expect(existsSync(join(result.dir, 'raw', 'point-000.wav'))).toBe(false)
    const manifest = JSON.parse(readFileSync(join(result.dir, 'evidence.json'), 'utf8')) as {
      files: Record<string, string>
      sourceSession: string
    }
    expect(Object.keys(manifest.files).sort()).toEqual([
      'features.json',
      'job.json',
      'meta.json',
      'report.md',
    ])
    expect(manifest.sourceSession).toBe('calib/sessions/2026-07-12T12-00-cutoff')
    expect(manifest.files['features.json']).toMatch(/^[a-f0-9]{64}$/)
    expect(readFileSync(join(result.dir, 'report.md'), 'utf8')).not.toContain(root)
  })

  it('accepts only a candidate with a passing independent verification artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'calib-accept-'))
    const base = JSON.parse(
      readFileSync(join(__dirname, '../tools/calib/jobs/vco1-pitch-knob.json'), 'utf8'),
    ) as CalibJob
    const job = (points: number[]): CalibJob => ({
      ...base,
      sweep: { ...base.sweep!, points },
    })
    const procedure = { id: 'xd-hardware-calibration', revision: 1 }
    const rig = {
      hardwareUnit: { unitId: 'xd-unit-1' },
      captureChain: { interface: 'test interface', sampleRateHz: 48_000 },
    }
    const writeSession = (name: string, value: CalibJob, features: unknown, date: string): string => {
      const dir = join(root, 'calib', 'sessions', name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'job.json'), JSON.stringify(value))
      writeFileSync(join(dir, 'meta.json'), JSON.stringify({ date, procedure, rig }))
      writeFileSync(join(dir, 'features.json'), JSON.stringify(features))
      writeFileSync(join(dir, 'report.md'), `# ${name}\n`)
      return dir
    }

    const fitSession = writeSession(
      'fit-session',
      job([356, 512]),
      { domain: 'vco.pitch', measuredDate: '2026-07-12', proposals: [{ proposed: 'table' }], results: [] },
      '2026-07-12T09:00:00.000Z',
    )
    const verificationJob = job([400, 600])
    const results: AnyResult[] = verificationJob.sweep!.points.map((raw) => {
      setXdProfile('v4')
      const hardwareRender = renderJobPoint(verificationJob, raw)
      const hardware = measureAny(hardwareRender.samples, hardwareRender.sr, hardwareRender.onsetSample, verificationJob)
      setXdProfile('v0')
      const baselineRender = renderJobPoint(verificationJob, raw)
      const baseline = measureAny(baselineRender.samples, baselineRender.sr, baselineRender.onsetSample, verificationJob)
      return { point: raw, hw: hardware, rep: baseline }
    })
    setXdProfile(XD_DEFAULT_PROFILE)
    const verificationSession = writeSession(
      'verify-session',
      verificationJob,
      {
        domain: 'vco.pitch',
        replicaProfile: 'v0',
        planned: results.length,
        results,
        pointFailures: [],
      },
      '2099-07-12T11:00:00.000Z',
    )
    const candidate = promoteEvidence(root, fitSession, 'v4').dir
    const verificationDir = promoteEvidence(root, verificationSession).dir
    const verificationPath = join(root, 'calib', 'verifications', 'fit-session--verify-session.json')
    expect(() => acceptEvidence(root, candidate, verificationPath)).toThrow(/not found/)
    // A FAILed verification (wrong --profile: evidence is bound to v4) writes
    // its artifact but must not burn the name — the re-run replaces it.
    expect(verifyCommand(root, candidate, verificationDir, 'v0').passed).toBe(false)
    expect(verifyCommand(root, candidate, verificationDir, 'v4').passed).toBe(true)
    // A PASSING artifact is immutable: acceptance references it.
    expect(() => verifyCommand(root, candidate, verificationDir, 'v4')).toThrow(/already exists/)
    const verification = JSON.parse(readFileSync(verificationPath, 'utf8'))
    // Acceptance must reproduce the comparison from checksummed evidence,
    // not trust editable point/result fields in this review artifact.
    verification.points = [point(100, 100)]
    verification.result = { passed: true, afterScore: 999 }
    writeFileSync(verificationPath, JSON.stringify(verification))
    const accepted = acceptEvidence(root, candidate, verificationPath)
    expect(accepted).toBe(join(root, 'calib', 'results', 'v4', 'vco1-pitch-knob.json'))
    const result = JSON.parse(readFileSync(accepted, 'utf8'))
    expect(result.profile).toBe('v4')
    expect(result.evidence).toBe('calib/evidence/fit-session')
    expect(result.verification.evidence).toBe('calib/evidence/verify-session')
    expect(validateAcceptedResult(root, accepted)).toEqual([])
    const acceptedFields = result.profileFields
    result.profileFields = ['driftConfig']
    writeFileSync(accepted, JSON.stringify(result))
    expect(validateAcceptedResult(root, accepted)).toContain(
      'accepted result fields do not match recomputed acceptance inputs',
    )
    result.profileFields = acceptedFields
    writeFileSync(accepted, JSON.stringify(result))
    const acceptedProposals = result.proposals
    result.proposals = [{ proposed: 'tampered' }]
    writeFileSync(accepted, JSON.stringify(result))
    expect(validateAcceptedResult(root, accepted)).toContain(
      'accepted result fields do not match recomputed acceptance inputs',
    )
    result.proposals = acceptedProposals
    writeFileSync(accepted, JSON.stringify(result))
    expect(() => acceptEvidence(root, candidate, verificationPath)).toThrow(/already exists/)

    verification.unit = 'Hz'
    writeFileSync(verificationPath, JSON.stringify(verification))
    expect(() => acceptEvidence(root, candidate, verificationPath)).toThrow(
      /verification metric does not match recomputed evidence/,
    )
    verification.unit = '¢'
    writeFileSync(verificationPath, JSON.stringify(verification))

    writeFileSync(join(verificationDir, 'features.json'), '{}')
    expect(() => acceptEvidence(root, candidate, verificationPath)).toThrow(/checksum mismatch/)
  }, 30_000)
})
