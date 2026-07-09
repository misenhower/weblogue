/*
 * Human-readable comparison report for a job run: per point, hardware vs
 * replica features side by side with deltas. Levels are reported but not
 * delta'd across worlds (different absolute scales); harmonics are relative
 * to H1 in each world, so their deltas are meaningful. When fitted curve
 * proposals are supplied, a '## Proposals' review-gate section is appended
 * (docs/hardware-calibration.md 'Review gate').
 */
import type { CalibJob } from './job'
import type { PointFeatures } from './measure'
import type { NoisePointFeatures } from './measure-noise'
import type { EnvPointFeatures } from './measure-env'
import { renderProposalMd, type Proposal } from './proposal'

export interface PointResult {
  point: number | null
  hw: PointFeatures | NoisePointFeatures | EnvPointFeatures
  rep: PointFeatures | NoisePointFeatures | EnvPointFeatures
}

const f1 = (x: number): string => x.toFixed(1)
const f2 = (x: number): string => x.toFixed(2)
const sign = (x: number, fmt: (v: number) => string): string => (x >= 0 ? '+' : '') + fmt(x)

/**
 * Render the comparison report. `proposals` is optional and additive: callers
 * that omit it get exactly the pre-proposal output; when present (and
 * non-empty) each Proposal is rendered via renderProposalMd under a
 * '## Proposals' heading, tagged MEASURED(measuredDate).
 */
export function renderReport(
  job: CalibJob,
  results: PointResult[],
  meta: { dir: string },
  proposals?: { measuredDate: string; items: Proposal[] },
): string {
  const lines: string[] = []
  lines.push(`# Calibration report: ${job.id}`)
  lines.push('')
  lines.push(`Domain: \`${job.domain}\` — ${job.description ?? ''}`)
  lines.push(`Session: \`${meta.dir}\``)
  lines.push('')
  const kind = job.features.kind ?? 'tonal'
  for (const r of results) {
    const label = r.point === null ? 'base patch' : `${job.sweep!.param} = ${r.point}`
    lines.push(`## ${label}`)
    lines.push('')
    lines.push('| metric | hardware | replica | Δ |')
    lines.push('|---|---|---|---|')
    if (kind === 'noise') {
      const [h, p] = [r.hw as NoisePointFeatures, r.rep as NoisePointFeatures]
      lines.push(`| rms | ${f1(h.rmsDb)} dBFS | ${f1(p.rmsDb)} dBFS | (scales differ) |`)
      lines.push(`| peak | ${f1(h.peakDbfs)} dBFS | ${f1(p.peakDbfs)} dBFS | (scales differ) |`)
      lines.push('')
      continue
    }
    if (kind === 'envelope') {
      const [h, p] = [r.hw as EnvPointFeatures, r.rep as EnvPointFeatures]
      const sec = (v: number | null): string => (v === null ? 'n/a' : v < 1 ? `${(v * 1000).toFixed(1)} ms` : `${v.toFixed(2)} s`)
      const pct = (a: number | null, b: number | null): string =>
        a === null || b === null || b === 0 ? '' : sign((a / b - 1) * 100, f1) + '%'
      for (const [name, hv, pv] of [
        ['attack 10-90%', h.attackSec, p.attackSec],
        ['decay (displayed)', h.decayTimeSec, p.decayTimeSec],
        ['release (displayed)', h.releaseTimeSec, p.releaseTimeSec],
      ] as const) {
        if (hv !== null || pv !== null) lines.push(`| ${name} | ${sec(hv)} | ${sec(pv)} | ${pct(hv, pv)} |`)
      }
      if (h.sustainDb !== null) lines.push(`| sustain | ${f1(h.sustainDb)} dB | ${p.sustainDb === null ? 'n/a' : f1(p.sustainDb)} dB | |`)
      lines.push(`| peak | ${f1(h.peakDbfs)} dBFS | ${f1(p.peakDbfs)} dBFS | (scales differ) |`)
      lines.push('')
      continue
    }
    const hw = r.hw as PointFeatures
    const rep = r.rep as PointFeatures
    lines.push(
      `| f0 (median) | ${f2(hw.f0Hz)} Hz (${sign(hw.cents, f1)}¢) | ${f2(rep.f0Hz)} Hz ` +
        `(${sign(rep.cents, f1)}¢) | ${sign(hw.cents - rep.cents, f1)}¢ |`,
    )
    if (hw.strikes.length > 1) {
      const list = (fs: { cents: number }[]): string => fs.map((s) => sign(s.cents, f1)).join(' / ')
      lines.push(
        `| per strike (¢) | ${list(hw.strikes)} | ${list(rep.strikes)} | |`,
        `| voice spread | ${f1(hw.centsSpread)}¢ | ${f1(rep.centsSpread)}¢ | ${sign(hw.centsSpread - rep.centsSpread, f1)}¢ |`,
      )
    }
    const kMax = Math.min(hw.harmonicsDb.length, rep.harmonicsDb.length)
    for (let k = 1; k < kMax; k++) {
      const dh = hw.harmonicsDb[k]
      const dr = rep.harmonicsDb[k]
      lines.push(`| H${k + 1} | ${f1(dh)} dB | ${f1(dr)} dB | ${sign(dh - dr, f1)} dB |`)
    }
    lines.push(`| peak | ${f1(hw.peakDbfs)} dBFS | ${f1(rep.peakDbfs)} dBFS | (scales differ) |`)
    lines.push('')
  }
  lines.push('Harmonics are dB relative to H1 within each world, so Δ is comparable;')
  lines.push('peak levels are absolute per world (interface gain vs engine units).')
  lines.push('')
  if (proposals && proposals.items.length > 0) {
    lines.push('## Proposals')
    lines.push('')
    for (const p of proposals.items) {
      lines.push(renderProposalMd(p, proposals.measuredDate))
      lines.push('')
    }
  }
  return lines.join('\n')
}
