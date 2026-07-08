/*
 * Session directory lifecycle: calib/sessions/<stamp>-<jobid>/ holds a frozen
 * copy of the job, a meta.json snapshot (git rev, rig, versions), the
 * gitignored raw WAVs, and the committed features.json + report.md.
 */
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CalibJob } from './job'
import { loadRig, calibDir } from './rig'

export interface Session {
  dir: string
  rawDir: string
}

export function createSession(root: string, job: CalibJob): Session {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)
  const dir = join(calibDir(root), 'sessions', `${stamp}-${job.id}`)
  const rawDir = join(dir, 'raw')
  mkdirSync(rawDir, { recursive: true })

  let gitRev = 'unknown'
  try {
    gitRev = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim()
  } catch {
    /* not fatal: sessions can run outside a checkout */
  }
  writeFileSync(join(dir, 'job.json'), JSON.stringify(job, null, 2) + '\n')
  const meta = {
    date: new Date().toISOString(),
    gitRev,
    node: process.version,
    rig: loadRig(root),
  }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
  return { dir, rawDir }
}

export function saveJson(dir: string, name: string, data: unknown): void {
  writeFileSync(join(dir, name), JSON.stringify(data, null, 2) + '\n')
}

export function saveText(dir: string, name: string, text: string): void {
  writeFileSync(join(dir, name), text)
}
