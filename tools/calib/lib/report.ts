/*
 * Human-readable comparison report for a job run: per point, hardware vs
 * replica features side by side with deltas. Levels are reported but not
 * delta'd across worlds (different absolute scales); harmonics are relative
 * to H1 in each world, so their deltas are meaningful.
 */
import type { CalibJob } from './job'
import type { PointFeatures } from './measure'

export interface PointResult {
  point: number | null
  hw: PointFeatures
  rep: PointFeatures
}

const f1 = (x: number): string => x.toFixed(1)
const f2 = (x: number): string => x.toFixed(2)
const sign = (x: number, fmt: (v: number) => string): string => (x >= 0 ? '+' : '') + fmt(x)

export function renderReport(job: CalibJob, results: PointResult[], meta: { dir: string }): string {
  const lines: string[] = []
  lines.push(`# Calibration report: ${job.id}`)
  lines.push('')
  lines.push(`Domain: \`${job.domain}\` — ${job.description ?? ''}`)
  lines.push(`Session: \`${meta.dir}\``)
  lines.push('')
  for (const r of results) {
    const label = r.point === null ? 'base patch' : `${job.sweep!.param} = ${r.point}`
    lines.push(`## ${label}`)
    lines.push('')
    lines.push('| metric | hardware | replica | Δ |')
    lines.push('|---|---|---|---|')
    lines.push(
      `| f0 (median) | ${f2(r.hw.f0Hz)} Hz (${sign(r.hw.cents, f1)}¢) | ${f2(r.rep.f0Hz)} Hz ` +
        `(${sign(r.rep.cents, f1)}¢) | ${sign(r.hw.cents - r.rep.cents, f1)}¢ |`,
    )
    if (r.hw.strikes.length > 1) {
      const list = (fs: { cents: number }[]): string => fs.map((s) => sign(s.cents, f1)).join(' / ')
      lines.push(
        `| per strike (¢) | ${list(r.hw.strikes)} | ${list(r.rep.strikes)} | |`,
        `| voice spread | ${f1(r.hw.centsSpread)}¢ | ${f1(r.rep.centsSpread)}¢ | ${sign(r.hw.centsSpread - r.rep.centsSpread, f1)}¢ |`,
      )
    }
    const kMax = Math.min(r.hw.harmonicsDb.length, r.rep.harmonicsDb.length)
    for (let k = 1; k < kMax; k++) {
      const dh = r.hw.harmonicsDb[k]
      const dr = r.rep.harmonicsDb[k]
      lines.push(`| H${k + 1} | ${f1(dh)} dB | ${f1(dr)} dB | ${sign(dh - dr, f1)} dB |`)
    }
    lines.push(`| peak | ${f1(r.hw.peakDbfs)} dBFS | ${f1(r.rep.peakDbfs)} dBFS | (scales differ) |`)
    lines.push('')
  }
  lines.push('Harmonics are dB relative to H1 within each world, so Δ is comparable;')
  lines.push('peak levels are absolute per world (interface gain vs engine units).')
  lines.push('')
  return lines.join('\n')
}
