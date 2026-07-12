import { isAbsolute, relative, resolve } from 'node:path'

/** Resolve a stored repository-relative provenance path without allowing it
 * to escape through absolute paths or `..` traversal. */
export function resolveRepoPath(root: string, storedPath: string, label: string): string {
  if (isAbsolute(storedPath)) throw new Error(`${label} must be repository-relative`)
  const full = resolve(root, storedPath)
  const rel = relative(resolve(root), full)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${label} escapes the repository: ${storedPath}`)
  }
  return full
}

export function repoRelativePath(root: string, fullPath: string, label: string): string {
  const rel = relative(resolve(root), resolve(fullPath))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${label} is outside the repository: ${fullPath}`)
  }
  return rel
}
