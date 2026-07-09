/*
 * tools/calib proposal pipeline: proposeExpMap recovers known curves from
 * noisy sweeps with an honest held-out residual (the overfit alarm),
 * verifyPitchTable flags deviations from the documented pitchToCents and
 * only proposes a table when >1/3 of points deviate, and renderReport stays
 * byte-identical for callers that pass no proposals.
 */
import { describe, it, expect } from 'vitest'
import { expMap } from '../src/shared/maps'
import { pitchToCents } from '../src/synths/xd/curves'
import { proposeExpMap, verifyPitchTable, renderProposalMd, type SweepPoint } from '../tools/calib/lib/proposal'
import { renderReport, type PointResult } from '../tools/calib/lib/report'
import type { CalibJob } from '../tools/calib/lib/job'
import type { PointFeatures } from '../tools/calib/lib/measure'

/** mulberry32 — deterministic fuzz. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), s | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Standard normal via Box-Muller over a uniform rng. */
function makeGauss(rng: () => number): () => number {
  return () => {
    const u = Math.max(rng(), 1e-12)
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
  }
}

/** The 17-point calibration grid: 64-step raw detents 0..960 plus the 1023 cap. */
const GRID = Array.from({ length: 17 }, (_, i) => Math.min(1023, i * 64))

/** Parse the lo/hi endpoints back out of an 'expMap(raw, lo, hi)' expression. */
function parseExpMap(expr: string): { lo: number; hi: number } {
  const m = /^expMap\(raw, ([0-9.eE+-]+), ([0-9.eE+-]+)\)$/.exec(expr)
  expect(m, `not an expMap expression: ${expr}`).toBeTruthy()
  return { lo: parseFloat(m![1]), hi: parseFloat(m![2]) }
}

// -----------------------------------------------------------------------------

describe('proposeExpMap', () => {
  it('recovers lo/hi within 3% from a noisy sweep and reports comparable residuals', () => {
    const gauss = makeGauss(makeRng(0x5eed))
    const pts: SweepPoint[] = GRID.map(raw => ({
      raw,
      value: expMap(raw, 22.4, 18700) * Math.exp(0.005 * gauss()),
    }))
    const p = proposeExpMap('cutoff', 'Hz', pts, 16, 21000)
    expect(p.domain).toBe('cutoff')
    expect(p.unit).toBe('Hz')
    expect(p.current).toBe('expMap(raw, 16, 21000)')
    const { lo, hi } = parseExpMap(p.proposed)
    expect(Math.abs(lo / 22.4 - 1)).toBeLessThan(0.03)
    expect(Math.abs(hi / 18700 - 1)).toBeLessThan(0.03)
    // Held-out points (indices 3, 7, 11, 15) see the same noise level, so the
    // two residuals land in the same ballpark — both near sigma = 0.5%.
    expect(p.fitResidualPct).toBeGreaterThan(0.05)
    expect(p.fitResidualPct).toBeLessThan(2)
    expect(p.heldOutResidualPct).toBeGreaterThan(0.05)
    expect(p.heldOutResidualPct).toBeLessThan(2)
    expect(Math.abs(p.heldOutResidualPct - p.fitResidualPct)).toBeLessThan(1)
    expect(p.notes.some(n => n.includes('held out'))).toBe(true)
  })

  it('raises the overfit alarm when held-out points disagree with the fit', () => {
    // Fit points follow the curve exactly; every held-out point is corrupted
    // by x1.6 (ln 1.6 ~ 47% log error) — a fit that ignores its validation set.
    const pts: SweepPoint[] = GRID.map((raw, i) => ({
      raw,
      value: expMap(raw, 16, 21000) * (i % 4 === 3 ? 1.6 : 1),
    }))
    const p = proposeExpMap('cutoff', 'Hz', pts, 16, 21000)
    expect(p.fitResidualPct).toBeLessThan(0.1)
    expect(p.heldOutResidualPct).toBeGreaterThan(20)
    expect(p.heldOutResidualPct).toBeGreaterThan(10 * Math.max(p.fitResidualPct, 1e-12))
    expect(p.notes.some(n => n.includes('overfit'))).toBe(true)
  })

  it('fits on all points and reports NaN held-out with a note when < 8 points', () => {
    const pts: SweepPoint[] = GRID.slice(0, 6).map(raw => ({ raw, value: expMap(raw, 0.0006, 3.0) }))
    const p = proposeExpMap('attack', 's', pts, 0.0006, 3.0)
    expect(p.proposed).toBe('expMap(raw, 0.0006, 3)')
    expect(p.fitResidualPct).toBeLessThan(1e-6)
    expect(Number.isNaN(p.heldOutResidualPct)).toBe(true)
    expect(p.notes.some(n => n.includes('< 8'))).toBe(true)
  })
})

// -----------------------------------------------------------------------------

/** 21-point breakpoint-clustered PITCH grid (protocol: PITCH sweeps 21 points). */
const PITCH_GRID = [
  0, 4, 100, 200, 300, 356, 400, 440, 476, 492, 512, 532, 548, 600, 668, 700, 800, 900, 1000,
  1020, 1023,
]

/** Documented pitch response plus deterministic sub-cent noise (< 1c). */
function cleanPitchPoints(seed: number): SweepPoint[] {
  const rng = makeRng(seed)
  return PITCH_GRID.map(raw => ({ raw, value: pitchToCents(raw) + (rng() - 0.5) * 1.6 }))
}

describe('verifyPitchTable', () => {
  it('flags nothing and proposes no change when measurements match within 1c noise', () => {
    const p = verifyPitchTable(cleanPitchPoints(0xd1ce))
    expect(p.domain).toBe('pitch')
    expect(p.unit).toBe('cents')
    expect(p.proposed).toContain('no change')
    expect(p.table).toBeUndefined()
    expect(p.notes.filter(n => n.includes('vs documented')).length).toBe(0)
    expect(p.notes.some(n => n.includes('within'))).toBe(true)
    // 0.8c worst-case noise ~ 0.046% log RMS ceiling.
    expect(p.fitResidualPct).toBeLessThan(0.05)
    expect(p.heldOutResidualPct).toBeLessThan(0.05)
  })

  it('flags each raw whose deviation exceeds 3c, without proposing a table for 5/21', () => {
    const shifted = [2, 6, 10, 13, 17] // raws 100, 440, 512, 600, 900
    const pts = cleanPitchPoints(0xd1ce).map((p, i) =>
      shifted.includes(i) ? { raw: p.raw, value: p.value + 150 } : p,
    )
    const p = verifyPitchTable(pts)
    const flags = p.notes.filter(n => n.includes('vs documented'))
    expect(flags.length).toBe(5)
    for (const i of shifted) {
      const flag = flags.find(n => n.startsWith(`raw ${PITCH_GRID[i]}:`))
      expect(flag, `raw ${PITCH_GRID[i]} not flagged`).toBeTruthy()
      expect(flag).toMatch(/Δ\+(149|150)\.\d¢/)
    }
    // 5 of 21 is under the 1/3 threshold: documented-exact policy holds.
    expect(p.table).toBeUndefined()
    expect(p.proposed).toContain('no change')
  })

  it('proposes a monotone table when >1/3 of points deviate (0.39x mid-range response)', () => {
    // The 2026-07-08 hardware finding: mid-range pitch response scaled ~0.39x.
    const pts: SweepPoint[] = PITCH_GRID.map(raw => {
      const doc = pitchToCents(raw)
      return { raw, value: raw >= 300 && raw <= 700 ? doc * 0.39 : doc }
    })
    const p = verifyPitchTable(pts)
    expect(p.proposed).toMatch(/^monotone table \(\d+ pts\)$/)
    expect(p.table).toBeDefined()
    // Fit points only (16 of 21): held-out raws never become table knots.
    expect(p.table!.length).toBe(16)
    for (const [raw, value] of p.table!) {
      expect(PITCH_GRID.includes(raw)).toBe(true)
      expect(Number.isFinite(value)).toBe(true)
    }
    expect(Number.isFinite(p.fitResidualPct)).toBe(true)
    expect(Number.isFinite(p.heldOutResidualPct)).toBe(true)
    expect(p.notes.some(n => n.includes('monotone replacement table'))).toBe(true)
  })
})

// -----------------------------------------------------------------------------

describe('renderProposalMd', () => {
  it('renders current, proposed, residuals, and the MEASURED provenance tag', () => {
    const pts: SweepPoint[] = GRID.map(raw => ({ raw, value: expMap(raw, 22.4, 18700) }))
    const p = proposeExpMap('cutoff', 'Hz', pts, 16, 21000)
    const md = renderProposalMd(p, '2026-07-08')
    expect(md).toContain('expMap(raw, 16, 21000)')
    expect(md).toContain(p.proposed)
    expect(md).toContain('MEASURED(2026-07-08)')
    expect(md).toContain('held-out')
  })

  it('renders the raw -> value table for table proposals', () => {
    const md = renderProposalMd(
      {
        domain: 'pitch',
        unit: 'cents',
        current: 'pitchToCents(raw) (documented table)',
        proposed: 'monotone table (2 pts)',
        fitResidualPct: 0.1,
        heldOutResidualPct: NaN,
        table: [
          [0, -1200],
          [1023, 1200],
        ],
        notes: ['synthetic'],
      },
      '2026-07-08',
    )
    expect(md).toContain('| raw | cents |')
    expect(md).toContain('| 0 | -1200 |')
    expect(md).toContain('| 1023 | 1200 |')
    expect(md).toContain('held-out n/a')
  })
})

// -----------------------------------------------------------------------------

const REPORT_JOB: CalibJob = {
  id: 'd3-cutoff',
  domain: 'filter',
  description: 'cutoff staircase',
  sweep: { param: 'CUTOFF', points: [0, 512] },
  notes: [{ midi: 69, vel: 100, onSec: 0.1, offSec: 1.1 }],
  captureSec: 2,
  features: { nominalHz: 440, harmonics: 3 },
}

function reportFeats(f0Hz: number, cents: number, spread: number): PointFeatures {
  return {
    peakDbfs: -12.3,
    f0Hz,
    cents,
    centsSpread: spread,
    strikes: [
      { f0Hz, cents },
      { f0Hz: f0Hz * 1.0002, cents: cents + 0.3 },
    ],
    harmonicsDb: [0, -6.2, -12.8],
    waveSnap: [],
  }
}

const REPORT_RESULTS: PointResult[] = [
  { point: 0, hw: reportFeats(439.32, -2.7, 0.6), rep: reportFeats(440.11, 0.4, 0.1) },
  { point: 512, hw: reportFeats(441.05, 4.1, 0.9), rep: reportFeats(440.02, 0.1, 0.2) },
]

/** renderReport output for the fixture above, pinned before proposals existed. */
const REPORT_BASELINE = [
  '# Calibration report: d3-cutoff',
  '',
  'Domain: `filter` — cutoff staircase',
  'Session: `sessions/2026-07-09-d3-cutoff`',
  '',
  '## CUTOFF = 0',
  '',
  '| metric | hardware | replica | Δ |',
  '|---|---|---|---|',
  '| f0 (median) | 439.32 Hz (-2.7¢) | 440.11 Hz (+0.4¢) | -3.1¢ |',
  '| per strike (¢) | -2.7 / -2.4 | +0.4 / +0.7 | |',
  '| voice spread | 0.6¢ | 0.1¢ | +0.5¢ |',
  '| H2 | -6.2 dB | -6.2 dB | +0.0 dB |',
  '| H3 | -12.8 dB | -12.8 dB | +0.0 dB |',
  '| peak | -12.3 dBFS | -12.3 dBFS | (scales differ) |',
  '',
  '## CUTOFF = 512',
  '',
  '| metric | hardware | replica | Δ |',
  '|---|---|---|---|',
  '| f0 (median) | 441.05 Hz (+4.1¢) | 440.02 Hz (+0.1¢) | +4.0¢ |',
  '| per strike (¢) | +4.1 / +4.4 | +0.1 / +0.4 | |',
  '| voice spread | 0.9¢ | 0.2¢ | +0.7¢ |',
  '| H2 | -6.2 dB | -6.2 dB | +0.0 dB |',
  '| H3 | -12.8 dB | -12.8 dB | +0.0 dB |',
  '| peak | -12.3 dBFS | -12.3 dBFS | (scales differ) |',
  '',
  'Harmonics are dB relative to H1 within each world, so Δ is comparable;',
  'peak levels are absolute per world (interface gain vs engine units).',
  '',
].join('\n')

describe('renderReport with proposals', () => {
  it('is byte-identical to the pre-proposal output when no proposals are passed', () => {
    const md = renderReport(REPORT_JOB, REPORT_RESULTS, { dir: 'sessions/2026-07-09-d3-cutoff' })
    expect(md).toBe(REPORT_BASELINE)
  })

  it('is byte-identical when the proposals list is empty', () => {
    const md = renderReport(
      REPORT_JOB,
      REPORT_RESULTS,
      { dir: 'sessions/2026-07-09-d3-cutoff' },
      { measuredDate: '2026-07-08', items: [] },
    )
    expect(md).toBe(REPORT_BASELINE)
  })

  it('appends a ## Proposals section rendering each proposal', () => {
    const pts: SweepPoint[] = GRID.map(raw => ({ raw, value: expMap(raw, 22.4, 18700) }))
    const p = proposeExpMap('cutoff', 'Hz', pts, 16, 21000)
    const md = renderReport(
      REPORT_JOB,
      REPORT_RESULTS,
      { dir: 'sessions/2026-07-09-d3-cutoff' },
      { measuredDate: '2026-07-08', items: [p] },
    )
    expect(md.startsWith(REPORT_BASELINE)).toBe(true)
    expect(md).toContain('## Proposals')
    expect(md).toContain(renderProposalMd(p, '2026-07-08'))
    expect(md).toContain('MEASURED(2026-07-08)')
  })
})
