/*
 * Promotion from an exploratory local session into a small, trackable
 * evidence bundle. Raw audio never crosses this seam: it stays in the
 * gitignored session directory and can be retained or archived separately.
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, relative } from 'node:path'
import { evaluateVerification, type VerificationPoint } from './workflow'
import { XD_PROFILES } from '../../../src/synths/xd/profiles'
import { compareEvidence } from './comparison'
import { loadJob } from './job'
import { publishJsonImmutable } from './publish'
import { repoRelativePath, resolveRepoPath } from './repo-path'

const DERIVED_FILES = ['job.json', 'meta.json', 'features.json', 'report.md'] as const

export interface EvidencePromotion {
  name: string
  dir: string
}

interface VerificationArtifact {
  schema: number
  domain: string
  unit: string
  profile: string
  profileDigest: string
  procedure: { id: string; revision: number }
  candidateEvidence: string
  verificationEvidence: string
  passed: boolean
  coverageComplete: boolean
  points: VerificationPoint[]
  result: { passed?: boolean; [key: string]: unknown }
}

export interface EvidenceManifest {
  sourceSession?: string
  files?: Record<string, string>
  promotedAt?: string
  candidateProfile?: string | null
  candidateProfileDigest?: string | null
  procedure?: { id?: string; revision?: number } | null
}

interface AcceptanceReplay {
  verificationResult?: ReturnType<typeof evaluateVerification>
  proposals?: unknown[]
}

interface EvidenceJob {
  sweep?: { points?: number[] }
  notes?: Array<{ midi?: number }>
}

/** Requirements that make a verification capture genuinely unseen. */
export function verificationDesignReasons(
  candidateDir: string,
  verificationDir: string,
  profile: string,
  domain: string,
): string[] {
  const candidateManifest = JSON.parse(
    readFileSync(join(candidateDir, 'evidence.json'), 'utf8'),
  ) as EvidenceManifest
  const verificationManifest = JSON.parse(
    readFileSync(join(verificationDir, 'evidence.json'), 'utf8'),
  ) as EvidenceManifest
  const reasons: string[] = []
  if (candidateManifest.candidateProfile !== profile) {
    reasons.push(
      `candidate evidence is bound to profile ${candidateManifest.candidateProfile ?? 'none'}, not ${profile}`,
    )
  }
  const currentDigest = profileDigest(profile)
  if (!currentDigest || candidateManifest.candidateProfileDigest !== currentDigest) {
    reasons.push('candidate profile content has changed since the evidence was frozen')
  }
  if (
    candidateManifest.sourceSession &&
    candidateManifest.sourceSession === verificationManifest.sourceSession
  ) {
    reasons.push('candidate and verification evidence came from the same source session')
  }
  if (
    !candidateManifest.procedure ||
    !verificationManifest.procedure ||
    candidateManifest.procedure.id !== verificationManifest.procedure.id ||
    candidateManifest.procedure.revision !== verificationManifest.procedure.revision
  ) {
    reasons.push('candidate and verification evidence must use the same versioned calibration procedure')
  }
  // A profile that declares a procedure must match the evidence exactly.
  // Dev-era profiles (v0-v4) declare none and may still be verified —
  // diagnostics stay possible — but the lineage gate (lineage.ts) prevents
  // untagged profiles from ever authorizing provenance.
  const profileConfig = XD_PROFILES.find((candidate) => candidate.id === profile)
  if (
    profileConfig?.procedure &&
    (!candidateManifest.procedure ||
      profileConfig.procedure.id !== candidateManifest.procedure.id ||
      profileConfig.procedure.revision !== candidateManifest.procedure.revision)
  ) {
    reasons.push('candidate profile declares a different procedure than the evidence')
  }

  const verificationMeta = JSON.parse(
    readFileSync(join(verificationDir, 'meta.json'), 'utf8'),
  ) as { date?: string }
  const promotedAt = Date.parse(candidateManifest.promotedAt ?? '')
  const capturedAt = Date.parse(verificationMeta.date ?? '')
  if (!Number.isFinite(promotedAt) || !Number.isFinite(capturedAt) || capturedAt <= promotedAt) {
    reasons.push('verification capture must occur after the candidate profile evidence is frozen')
  }

  const candidateJob = JSON.parse(readFileSync(join(candidateDir, 'job.json'), 'utf8')) as EvidenceJob
  const verificationJob = JSON.parse(readFileSync(join(verificationDir, 'job.json'), 'utf8')) as EvidenceJob
  const fitPoints = new Set(candidateJob.sweep?.points ?? [])
  const verificationInterior = (verificationJob.sweep?.points ?? []).filter((raw) => raw !== 0 && raw !== 1023)
  const overlap = verificationInterior.filter((raw) => fitPoints.has(raw))
  if (verificationInterior.length === 0 || overlap.length > 0) {
    reasons.push(
      overlap.length
        ? `verification reuses fitting-grid raw values: ${overlap.join(', ')}`
        : 'verification job has no off-grid interior sweep points',
    )
  }

  if (domain === 'vco.shape') {
    const fitNotes = new Set((candidateJob.notes ?? []).map((note) => note.midi))
    const hasDifferentNote = (verificationJob.notes ?? []).some((note) => !fitNotes.has(note.midi))
    if (!hasDifferentNote) reasons.push('SHAPE verification must include a different note or octave')
  }
  return reasons
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

export function profileDigest(profileId: string): string | null {
  const profile = XD_PROFILES.find((candidate) => candidate.id === profileId)
  return profile ? sha256(Buffer.from(JSON.stringify(profile))) : null
}

function verifyManifestFiles(dir: string, manifest: EvidenceManifest): void {
  const expectedFiles = [...DERIVED_FILES].sort()
  const actualFiles = Object.keys(manifest.files ?? {}).sort()
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`evidence manifest must checksum exactly: ${expectedFiles.join(', ')}`)
  }
  for (const [file, expected] of Object.entries(manifest.files!)) {
    if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error(`invalid evidence checksum: ${file}`)
    const path = join(dir, file)
    if (!existsSync(path) || sha256(readFileSync(path)) !== expected) {
      throw new Error(`evidence checksum mismatch: ${file}`)
    }
  }
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as {
    procedure?: { id?: string; revision?: number }
  }
  if (
    !manifest.procedure ||
    meta.procedure?.id !== manifest.procedure.id ||
    meta.procedure?.revision !== manifest.procedure.revision
  ) {
    throw new Error('evidence manifest procedure does not match checksummed meta.json')
  }
}

export function validateEvidenceBundle(dir: string): EvidenceManifest {
  const manifestPath = join(dir, 'evidence.json')
  if (!existsSync(manifestPath)) throw new Error(`evidence manifest not found: ${manifestPath}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as EvidenceManifest
  verifyManifestFiles(dir, manifest)
  return manifest
}

/** Promote one completed session; existing evidence is immutable. */
export function promoteEvidence(root: string, sessionDir: string, candidateProfile?: string): EvidencePromotion {
  const name = basename(sessionDir)
  const dir = join(root, 'calib', 'evidence', name)
  if (existsSync(dir)) throw new Error(`evidence already exists: ${relative(root, dir)}`)
  if (candidateProfile && !profileDigest(candidateProfile)) {
    throw new Error(`unknown candidate profile: ${candidateProfile}`)
  }
  for (const file of DERIVED_FILES) {
    if (!existsSync(join(sessionDir, file))) throw new Error(`session is missing ${file}`)
  }
  const sessionMeta = JSON.parse(readFileSync(join(sessionDir, 'meta.json'), 'utf8')) as {
    procedure?: { id?: string; revision?: number }
    rig?: {
      hardwareUnit?: { unitId?: string }
      captureChain?: { interface?: string; sampleRateHz?: number }
    } | null
  }
  if (!sessionMeta.procedure?.id || !Number.isFinite(sessionMeta.procedure.revision)) {
    throw new Error('session predates versioned calibration procedures and cannot become canonical evidence')
  }
  if (
    !sessionMeta.rig?.hardwareUnit?.unitId ||
    !sessionMeta.rig.captureChain?.interface ||
    !Number.isFinite(sessionMeta.rig.captureChain.sampleRateHz)
  ) {
    throw new Error('versioned-procedure evidence requires a hardware unit and capture-chain snapshot')
  }

  const parent = join(root, 'calib', 'evidence')
  mkdirSync(parent, { recursive: true })
  const tempDir = join(parent, `.${name}.tmp-${process.pid}-${Date.now()}`)
  mkdirSync(tempDir)
  try {
    const files: Record<string, string> = {}
    for (const file of DERIVED_FILES) {
      const source = readFileSync(join(sessionDir, file))
      // Reports historically embedded an absolute local Session path. Evidence
      // uses a portable path without changing any measured feature values.
      const output =
        file === 'report.md'
          ? Buffer.from(source.toString('utf8').split(sessionDir).join(`calib/evidence/${name}`))
          : source
      writeFileSync(join(tempDir, file), output)
      files[file] = sha256(output)
    }
    const manifest = {
      schema: 1,
      sourceSession: relative(root, sessionDir),
      promotedAt: new Date().toISOString(),
      candidateProfile: candidateProfile ?? null,
      candidateProfileDigest: candidateProfile ? profileDigest(candidateProfile) : null,
      procedure: sessionMeta.procedure,
      rawAudio: 'local-only; not included',
      files,
    }
    writeFileSync(join(tempDir, 'evidence.json'), JSON.stringify(manifest, null, 2) + '\n')
    validateEvidenceBundle(tempDir)
    renameSync(tempDir, dir)
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true })
    throw error
  }
  return { name, dir }
}

/**
 * Archive a reviewed proposal only after its independent verification has
 * passed. The result is deliberately small; the immutable evidence bundles
 * contain the full reports and measured features.
 */
export function acceptEvidence(
  root: string,
  candidateDir: string,
  verificationPath: string,
  writeResult = true,
  replay?: AcceptanceReplay,
): string {
  const candidateRelative = repoRelativePath(root, candidateDir, 'candidate evidence')
  repoRelativePath(root, verificationPath, 'verification artifact')
  if (!existsSync(join(candidateDir, 'evidence.json'))) {
    throw new Error('candidate must be a promoted evidence bundle')
  }
  if (!existsSync(verificationPath)) throw new Error(`verification artifact not found: ${verificationPath}`)
  const verification = JSON.parse(readFileSync(verificationPath, 'utf8')) as VerificationArtifact
  if (!verification.passed || verification.result?.passed !== true) {
    throw new Error('candidate verification did not pass')
  }
  if (profileDigest(verification.profile) !== verification.profileDigest) {
    throw new Error('verified profile content has changed; run verification again')
  }
  if (verification.candidateEvidence !== candidateRelative) {
    throw new Error('verification artifact belongs to a different candidate evidence bundle')
  }
  if (verification.candidateEvidence === verification.verificationEvidence) {
    throw new Error('verification evidence must be independent from the candidate evidence')
  }
  const verificationDir = resolveRepoPath(
    root,
    verification.verificationEvidence,
    'verification evidence',
  )
  if (!existsSync(join(verificationDir, 'evidence.json'))) {
    throw new Error(`verification evidence not found: ${verification.verificationEvidence}`)
  }
  const candidateManifest = validateEvidenceBundle(candidateDir)
  const verificationManifest = validateEvidenceBundle(verificationDir)
  if (
    verification.procedure.id !== candidateManifest.procedure?.id ||
    verification.procedure.revision !== candidateManifest.procedure?.revision
  ) {
    throw new Error('verification artifact procedure does not match candidate evidence')
  }
  if (
    candidateManifest.sourceSession &&
    candidateManifest.sourceSession === verificationManifest.sourceSession
  ) {
    throw new Error('candidate and verification evidence came from the same source session')
  }

  const features = JSON.parse(readFileSync(join(candidateDir, 'features.json'), 'utf8')) as {
    domain?: string
    measuredDate?: string
    proposals?: unknown[]
  }
  const candidateJob = loadJob(join(candidateDir, 'job.json'))
  if (!candidateJob.profileFields?.length) {
    throw new Error('candidate job must declare profileFields')
  }
  if (!features.domain || !features.proposals?.length) throw new Error('candidate evidence has no proposals')
  if (features.domain !== verification.domain) throw new Error('verification domain does not match candidate')
  const designReasons = verificationDesignReasons(
    candidateDir,
    verificationDir,
    verification.profile,
    verification.domain,
  )
  const comparison = compareEvidence(verificationDir, verification.profile)
  if (comparison.domain !== verification.domain || comparison.unit !== verification.unit) {
    throw new Error(
      `verification metric does not match recomputed evidence: ` +
      `${verification.domain} (${verification.unit}) != ${comparison.domain} (${comparison.unit})`,
    )
  }
  const recomputed = evaluateVerification({
    domain: verification.domain,
    unit: verification.unit,
    independent: verification.candidateEvidence !== verification.verificationEvidence,
    coverageComplete: comparison.coverageComplete,
    points: comparison.rows,
    designReasons,
  })
  if (!recomputed.passed) throw new Error(`verification artifact no longer passes: ${recomputed.reasons.join('; ')}`)
  if (replay) {
    replay.verificationResult = recomputed
    replay.proposals = features.proposals
  }

  const outDir = join(root, 'calib', 'results', verification.profile)
  const outPath = join(outDir, `${candidateJob.id}.json`)
  if (!writeResult) return outPath
  mkdirSync(outDir, { recursive: true })
  if (existsSync(outPath)) throw new Error(`accepted result already exists: ${relative(root, outPath)}`)
  const result = {
    schema: 1,
    domain: features.domain,
    profile: verification.profile,
    profileDigest: verification.profileDigest,
    profileFields: candidateJob.profileFields ?? [],
    procedure: verification.procedure,
    measuredDate: features.measuredDate,
    acceptedAt: new Date().toISOString(),
    evidence: relative(root, candidateDir),
    verification: {
      evidence: verification.verificationEvidence,
      artifact: relative(root, verificationPath),
      result: recomputed,
    },
    proposals: features.proposals,
  }
  try {
    publishJsonImmutable(outPath, result)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('artifact already exists:')) {
      throw new Error(`accepted result already exists: ${relative(root, outPath)}`)
    }
    throw error
  }
  return outPath
}

interface StoredAcceptedResult {
  domain?: string
  profile?: string
  profileDigest?: string
  profileFields?: string[]
  procedure?: { id?: string; revision?: number }
  proposals?: unknown[]
  evidence?: string
  verification?: { artifact?: string; evidence?: string; result?: unknown }
}

/** Re-run the same evidence/profile/design/metric checks used by acceptance
 * without writing anything. Used by the profile-lineage gate so a fabricated
 * result-shaped JSON file cannot authorize a field. */
export function validateAcceptedResult(root: string, resultPath: string): string[] {
  let stored: StoredAcceptedResult
  try {
    stored = JSON.parse(readFileSync(resultPath, 'utf8')) as StoredAcceptedResult
  } catch {
    return ['accepted result is not valid JSON']
  }
  if (!stored.evidence || !stored.verification?.artifact) {
    return ['accepted result does not reference candidate evidence and verification']
  }
  try {
    const candidateDir = resolveRepoPath(root, stored.evidence, 'accepted candidate evidence')
    const artifactPath = resolveRepoPath(root, stored.verification.artifact, 'accepted verification artifact')
    const replay: AcceptanceReplay = {}
    const expected = acceptEvidence(
      root,
      candidateDir,
      artifactPath,
      false,
      replay,
    )
    const candidateJob = loadJob(join(candidateDir, 'job.json'))
    const features = JSON.parse(readFileSync(join(candidateDir, 'features.json'), 'utf8')) as {
      domain?: string
    }
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as VerificationArtifact
    const sameFields =
      JSON.stringify([...(stored.profileFields ?? [])].sort()) ===
      JSON.stringify([...(candidateJob.profileFields ?? [])].sort())
    const labelsMatch =
      stored.domain === features.domain &&
      stored.profile === artifact.profile &&
      stored.profileDigest === artifact.profileDigest &&
      stored.procedure?.id === artifact.procedure.id &&
      stored.procedure?.revision === artifact.procedure.revision &&
      stored.evidence === artifact.candidateEvidence &&
      stored.verification.evidence === artifact.verificationEvidence &&
      sameFields &&
      JSON.stringify(stored.proposals) === JSON.stringify(replay.proposals) &&
      JSON.stringify(stored.verification.result) === JSON.stringify(replay.verificationResult)
    const problems: string[] = []
    if (expected !== resultPath) problems.push('accepted result path does not match its profile and job')
    if (!labelsMatch) problems.push('accepted result fields do not match recomputed acceptance inputs')
    return problems
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)]
  }
}
