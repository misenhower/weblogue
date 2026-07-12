/* Atomic, no-replace publication for canonical JSON artifacts. */
import { existsSync, linkSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export function publishJsonImmutable(path: string, value: unknown): void {
  const temp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${Date.now()}`)
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
    linkSync(temp, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`artifact already exists: ${path}`)
    }
    throw error
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
}
