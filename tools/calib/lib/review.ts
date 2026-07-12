/*
 * Node-side orchestration for calibration review commands. The CLI delegates
 * here so evidence promotion, independent verification, and acceptance form
 * one coherent module instead of three loosely-related command handlers.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { evaluateVerification, type VerificationResult } from './workflow'
import {
  acceptEvidence,
  profileDigest,
  promoteEvidence,
  validateEvidenceBundle,
  verificationDesignReasons,
} from './evidence'
import { compareEvidence, readFeatures } from './comparison'

function resolveDir(root: string, name: string, kind: 'session' | 'evidence' | 'either'): string | null {
  if (existsSync(join(name, 'features.json'))) return name
  const candidates =
    kind === 'session'
      ? [join(root, 'calib', 'sessions', name)]
      : kind === 'evidence'
        ? [join(root, 'calib', 'evidence', name)]
        : [join(root, 'calib', 'evidence', name), join(root, 'calib', 'sessions', name)]
  return candidates.find((dir) => existsSync(join(dir, 'features.json'))) ?? null
}

function fmtMetric(value: number, unit: string): string {
  if (unit === '¢' || unit === 'dB') return `${value.toFixed(2)}${unit}`
  return `${(value * 100).toFixed(2)}%`
}

/** Diagnostic comparison; unlike verify, this never creates acceptance evidence. */
export function compareCommand(root: string, name: string, profile: string): number {
  const dir = resolveDir(root, name, 'either')
  if (!dir) throw new Error(`session/evidence not found: ${name}`)
  const comparison = compareEvidence(dir, profile)
  const result = evaluateVerification({
    domain: comparison.domain,
    unit: comparison.unit,
    points: comparison.rows,
    coverageComplete: comparison.coverageComplete,
    independent: true,
    // Compare is diagnostic: report the metrics without manufacturing an
    // acceptance failure merely because this may be the fit session.
  })
  console.log(`\n${basename(dir)} — diagnostic comparison under profile ${profile} (${comparison.unit})`)
  console.log('| point | hardware | before | after |')
  console.log('|---|---:|---:|---:|')
  for (const row of comparison.rows) {
    console.log(`| ${row.raw ?? 'base'} | ${row.hardware.toPrecision(6)} | ${row.before.toPrecision(6)} | ${row.after.toPrecision(6)} |`)
  }
  console.log(`\n${result.metric}: ${fmtMetric(result.beforeScore, comparison.unit)} -> ${fmtMetric(result.afterScore, comparison.unit)}`)
  if (!comparison.coverageComplete) console.log('WARNING: capture coverage is incomplete')
  return result.afterScore < result.beforeScore ? 0 : 1
}

/**
 * Verify a candidate evidence bundle against a different promoted capture
 * set. The artifact is written beside the candidate and is required by
 * acceptEvidence.
 */
export function verifyCommand(
  root: string,
  candidateName: string,
  verificationName: string,
  profile: string,
): VerificationResult {
  const candidateDir = resolveDir(root, candidateName, 'evidence')
  const verificationDir = resolveDir(root, verificationName, 'evidence')
  if (!candidateDir) throw new Error(`candidate evidence not found: ${candidateName}`)
  if (!verificationDir) throw new Error(`verification evidence not found: ${verificationName}`)
  const candidateManifest = validateEvidenceBundle(candidateDir)
  const verificationManifest = validateEvidenceBundle(verificationDir)
  if (
    candidateManifest.sourceSession &&
    candidateManifest.sourceSession === verificationManifest.sourceSession
  ) {
    throw new Error('candidate and verification evidence came from the same source session')
  }
  const candidateFeatures = readFeatures(candidateDir)
  if (!candidateFeatures.proposals?.length) throw new Error('candidate evidence has no proposals')
  const comparison = compareEvidence(verificationDir, profile)
  if (comparison.domain !== candidateFeatures.domain) {
    throw new Error(`verification domain ${comparison.domain} does not match candidate ${candidateFeatures.domain}`)
  }
  const result = evaluateVerification({
    domain: comparison.domain,
    unit: comparison.unit,
    points: comparison.rows,
    coverageComplete: comparison.coverageComplete,
    independent: candidateDir !== verificationDir,
    designReasons: verificationDesignReasons(
      candidateDir,
      verificationDir,
      profile,
      comparison.domain,
    ),
  })
  const artifact = {
    schema: 1,
    createdAt: new Date().toISOString(),
    domain: comparison.domain,
    unit: comparison.unit,
    profile,
    profileDigest: profileDigest(profile)!,
    procedure: candidateManifest.procedure!,
    candidateEvidence: relative(root, candidateDir),
    verificationEvidence: relative(root, verificationDir),
    baselineProfile: readFeatures(verificationDir).replicaProfile ?? 'unknown',
    passed: result.passed,
    coverageComplete: comparison.coverageComplete,
    result,
    points: comparison.rows,
  }
  const verificationOutDir = join(root, 'calib', 'verifications')
  mkdirSync(verificationOutDir, { recursive: true })
  const verificationOut = join(
    verificationOutDir,
    `${basename(candidateDir)}--${basename(verificationDir)}.json`,
  )
  writeFileSync(verificationOut, JSON.stringify(artifact, null, 2) + '\n')
  console.log(`verification ${result.passed ? 'PASS' : 'FAIL'}: ${fmtMetric(result.beforeScore, comparison.unit)} -> ${fmtMetric(result.afterScore, comparison.unit)}`)
  console.log(`artifact: ${relative(root, verificationOut)}`)
  for (const reason of result.reasons) console.log(`- ${reason}`)
  return result
}

export function evidenceCommand(root: string, sessionName: string, candidateProfile?: string): string {
  const sessionDir = resolveDir(root, sessionName, 'session')
  if (!sessionDir) throw new Error(`session not found: ${sessionName}`)
  const promoted = promoteEvidence(root, sessionDir, candidateProfile)
  console.log(`promoted derived evidence -> ${relative(root, promoted.dir)} (raw WAVs remain local)`)
  return promoted.dir
}

export function acceptCommand(root: string, candidateName: string, verificationName: string): string {
  const candidateDir = resolveDir(root, candidateName, 'evidence')
  if (!candidateDir) throw new Error(`candidate evidence not found: ${candidateName}`)
  const verificationPath = existsSync(verificationName)
    ? verificationName
    : join(root, 'calib', 'verifications', verificationName)
  const out = acceptEvidence(root, candidateDir, verificationPath)
  console.log(`accepted -> ${relative(root, out)}`)
  return out
}
