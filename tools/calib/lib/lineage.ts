/* Domain-level provenance validation for procedure-R2+ synth profiles. */
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import {
  profileChangedFields,
  type XdCalibProfile,
  type XdCalibrationField,
} from '../../../src/synths/xd/profiles'
import { validateAcceptedResult } from './evidence'

interface AcceptedResult {
  profile?: string
  profileDigest?: string
  procedure?: { id?: string; revision?: number }
  profileFields?: XdCalibrationField[]
}

function insideRoot(root: string, path: string): string | null {
  if (isAbsolute(path)) return null
  const full = resolve(root, path)
  const rel = relative(resolve(root), full)
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? null : full
}

/** Return every provenance problem; an empty list certifies the lineage. */
export function profileLineageProblems(
  root: string,
  profile: XdCalibProfile,
  registry: readonly XdCalibProfile[],
  digest: string,
): string[] {
  const visiting = new Set<string>()
  const digestOf = (value: XdCalibProfile): string =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex')

  const visit = (current: XdCalibProfile, currentDigest: string): string[] => {
    if ((current.procedure?.revision ?? 0) < 2) return []
    if (visiting.has(current.id)) return [`profile lineage cycle includes ${current.id}`]
    visiting.add(current.id)
    const problems: string[] = []
    const lineage = current.lineage
    if (!lineage) {
      visiting.delete(current.id)
      return ['procedure-R2+ profile has no lineage']
    }
    const base = registry.find((candidate) => candidate.id === lineage.baseProfile)
    if (!base) {
      visiting.delete(current.id)
      return [`base profile ${lineage.baseProfile} does not exist`]
    }
    for (const problem of visit(base, digestOf(base))) {
      problems.push(`base ${base.id}: ${problem}`)
    }
    const changed = profileChangedFields(base, current)
    const changedSet = new Set<XdCalibrationField>(changed)
    for (const field of Object.keys(lineage.evidence) as XdCalibrationField[]) {
      if (!changedSet.has(field)) problems.push(`unchanged field ${field} has an accepted result`)
    }
    for (const field of changed) {
      const path = lineage.evidence[field]
      if (!path) {
        problems.push(`changed field ${field} has no accepted result`)
        continue
      }
      const full = insideRoot(root, path)
      if (!full || !existsSync(full)) {
        problems.push(`accepted result for ${field} is missing or outside the repository: ${path}`)
        continue
      }
      let result: AcceptedResult
      try {
        result = JSON.parse(readFileSync(full, 'utf8')) as AcceptedResult
      } catch {
        problems.push(`accepted result for ${field} is not valid JSON: ${path}`)
        continue
      }
      if (result.profile !== current.id || result.profileDigest !== currentDigest) {
        problems.push(`accepted result for ${field} is bound to a different profile`)
      }
      if (
        result.procedure?.id !== current.procedure?.id ||
        result.procedure?.revision !== current.procedure?.revision
      ) {
        problems.push(`accepted result for ${field} uses a different procedure`)
      }
      if (!result.profileFields?.includes(field)) {
        problems.push(`accepted result for ${field} does not authorize that field`)
      }
      for (const problem of validateAcceptedResult(root, full)) {
        problems.push(`accepted result for ${field} is invalid: ${problem}`)
      }
    }
    visiting.delete(current.id)
    return problems
  }

  return visit(profile, digest)
}
