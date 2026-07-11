/*
 * Fit -> reviewed-proposal pipeline (M3, docs/hardware-calibration.md 'Review
 * gate'): turns measured sweep points into explicit curve proposals for
 * report.md — current vs proposed expression, fit residual, and a held-out
 * residual as the overfit alarm. Per docs/calibration-protocol.md
 * 'Validation', every 4th sweep point (0-based indices 3, 7, 11, ...) never
 * enters a fit and is scored separately. Values are applied to curves.ts by
 * hand after review; nothing here mutates the replica.
 *
 * Pure math + string building only (no node imports); the ISO date for the
 * MEASURED provenance tag is passed in by the caller.
 */
import { expMap } from '../../../src/shared/maps'
import { pitchToCents } from '../../../src/synths/xd/curves'
import { fitExpMap, monotoneTable } from './fit'

/** One measured sweep point; value is in the domain's physical unit (Hz, seconds, cents). */
export interface SweepPoint {
  raw: number
  value: number
}

/** A reviewable curve proposal, rendered into report.md via renderProposalMd. */
export interface Proposal {
  domain: string
  unit: string
  /** current curves.ts expression, e.g. 'expMap(raw, 16, 21000)' */
  current: string
  /** proposed replacement, e.g. 'expMap(raw, 22.4, 18700)' or 'monotone table (N pts)' */
  proposed: string
  /** RMS log-domain residual on the FIT points, as % */
  fitResidualPct: number
  /** same on the held-out points (every 4th point, protocol rule); NaN when < 8 points */
  heldOutResidualPct: number
  /** raw -> fitted value, for tier-2 table proposals */
  table?: [number, number][]
  notes: string[]
}

/** Deviations beyond this many cents get flagged by verifyPitchTable. */
const PITCH_FLAG_CENTS = 3

/** Log-frequency ratio per cent: ln(2)/1200 (cents are already a log unit). */
const LN_PER_CENT = Math.log(2) / 1200

/** Round to 3 significant figures and drop trailing zeros ('22.4', '18700'). */
function sig3(x: number): string {
  return Number.isFinite(x) ? Number(x.toPrecision(3)).toString() : String(x)
}

/** '+4.1' / '-2.7' — signed one-decimal, for cent deltas in notes. */
function signed1(x: number): string {
  return (x >= 0 ? '+' : '') + x.toFixed(1)
}

/** '1.23%' or 'n/a' for NaN residuals. */
function fmtPct(x: number): string {
  return Number.isFinite(x) ? `${sig3(x)}%` : 'n/a'
}

/**
 * Split sweep points into fit and held-out sets per the protocol rule
 * (0-based indices 3, 7, 11, ... held out). With < 8 points there is no
 * held-out set: fit on everything and report heldOut as NaN.
 */
function splitHeldOut(points: readonly SweepPoint[]): { fit: SweepPoint[]; held: SweepPoint[] } {
  if (points.length < 8) return { fit: points.slice(), held: [] }
  const fit: SweepPoint[] = []
  const held: SweepPoint[] = []
  points.forEach((p, i) => (i % 4 === 3 ? held : fit).push(p))
  return { fit, held }
}

/** RMS of ln(value / predicted) over points, as %; NaN when nothing is comparable. */
function logResidualPct(points: readonly SweepPoint[], predict: (raw: number) => number): number {
  let acc = 0
  let n = 0
  for (const p of points) {
    const pred = predict(p.raw)
    if (p.value > 0 && pred > 0) {
      const e = Math.log(p.value / pred)
      acc += e * e
      n++
    }
  }
  return n > 0 ? Math.sqrt(acc / n) * 100 : NaN
}

/** RMS of (value - predictedCents) in cents; NaN on empty. */
function centsResidualRms(points: readonly SweepPoint[], predict: (raw: number) => number): number {
  if (points.length === 0) return NaN
  let acc = 0
  for (const p of points) {
    const e = p.value - predict(p.raw)
    acc += e * e
  }
  return Math.sqrt(acc / points.length)
}

/**
 * When an expMap fit's residual exceeds this, the shape isn't exponential —
 * fall back to a tier-2 monotone lookup table (docs/hardware-calibration.md
 * tier model; the measured EG time curves are segmented, not expMap-shaped).
 */
export const TABLE_FALLBACK_PCT = 25

/**
 * Analytic-first curve proposal: try expMap; when its fit residual says the
 * curve family is wrong — or the domain has a standing table decision
 * (forceTable) — refit the same fit points as a monotone table (log-domain
 * PCHIP for positive units) and score held-out points against the table
 * instead. Non-positive values can't be log-fitted, so they always fall back
 * to the expMap proposal.
 */
export function proposeCurve(
  domain: string,
  unit: string,
  points: SweepPoint[],
  currentLo: number,
  currentHi: number,
  opts?: { forceTable?: string },
): Proposal {
  const exp = proposeExpMap(domain, unit, points, currentLo, currentHi)
  const wantTable = opts?.forceTable !== undefined || exp.fitResidualPct > TABLE_FALLBACK_PCT
  if (!wantTable || points.some((p) => p.value <= 0)) return exp
  const { fit, held } = splitHeldOut(points)
  const table = monotoneTable(fit.map((p) => ({ x: p.raw, y: Math.log(p.value) })))
  const at = (raw: number): number => Math.exp(table.at(raw))
  const knots: [number, number][] = Array.from(table.xs, (x, i) => [x, Math.exp(table.ys[i])])
  return {
    domain,
    unit,
    current: exp.current,
    proposed: `monotone table (${knots.length} pts, log-PCHIP)`,
    fitResidualPct: logResidualPct(fit, at),
    heldOutResidualPct: held.length ? logResidualPct(held, at) : NaN,
    table: knots,
    notes: [
      opts?.forceTable !== undefined
        ? `table by standing decision: ${opts.forceTable} (best expMap was ${exp.proposed}, residual ${exp.fitResidualPct.toFixed(1)}%)`
        : `expMap rejected: residual ${exp.fitResidualPct.toFixed(1)}% > ${TABLE_FALLBACK_PCT}% — curve is not exponential (best expMap was ${exp.proposed})`,
      ...exp.notes,
    ],
  }
}

/**
 * Propose replacement expMap endpoints for a swept domain: log-linear least
 * squares (fit.ts fitExpMap) on the fit points, held-out residual scored
 * against the fitted curve. Endpoints are rounded to 3 significant figures in
 * the proposed expression. A held-out residual far above the fit residual is
 * called out as a possible overfit / wrong curve family.
 */
export function proposeExpMap(
  domain: string,
  unit: string,
  points: SweepPoint[],
  currentLo: number,
  currentHi: number,
): Proposal {
  const notes: string[] = []
  const { fit, held } = splitHeldOut(points)
  const f = fitExpMap(fit)
  const fitResidualPct = f.residualLogRms * 100
  const heldOutResidualPct =
    held.length > 0 ? logResidualPct(held, raw => expMap(raw, f.lo, f.hi)) : NaN
  if (held.length === 0) {
    notes.push(`only ${points.length} points (< 8): fit on all points, no held-out validation`)
  } else {
    notes.push(`fit on ${fit.length} points, ${held.length} held out (every 4th)`)
    if (heldOutResidualPct > Math.max(3 * fitResidualPct, 1)) {
      notes.push(
        `held-out residual ${fmtPct(heldOutResidualPct)} far exceeds fit residual ` +
          `${fmtPct(fitResidualPct)} — possible overfit or wrong curve family`,
      )
    }
  }
  return {
    domain,
    unit,
    current: `expMap(raw, ${sig3(currentLo)}, ${sig3(currentHi)})`,
    proposed: `expMap(raw, ${sig3(f.lo)}, ${sig3(f.hi)})`,
    fitResidualPct,
    heldOutResidualPct,
    notes,
  }
}

/**
 * Verify measured pitch-knob response (value = measured cents) against the
 * DOCUMENTED-exact pitchToCents table in src/synths/xd/curves.ts. Policy:
 * deviations > 3¢ are flagged in notes (each raw + delta), and a monotone
 * replacement table (fit.ts monotoneTable over the fit points) is proposed
 * only when more than 1/3 of the points deviate. Residuals are cent RMS
 * converted to log-frequency % (1¢ = ln(2)/1200), split fit/held-out by the
 * protocol rule even though the documented curve has no free parameters.
 */
export function verifyPitchTable(points: SweepPoint[]): Proposal {
  const notes: string[] = []
  const { fit, held } = splitHeldOut(points)

  const flagged = points.filter(p => Math.abs(p.value - pitchToCents(p.raw)) > PITCH_FLAG_CENTS)
  for (const p of flagged) {
    notes.push(`raw ${p.raw}: Δ${signed1(p.value - pitchToCents(p.raw))}¢ vs documented pitchToCents`)
  }

  const proposeTable = flagged.length * 3 > points.length
  let predict: (raw: number) => number = pitchToCents
  let proposed = 'no change (documented-exact)'
  let table: [number, number][] | undefined
  if (proposeTable) {
    const t = monotoneTable(fit.map(p => ({ x: p.raw, y: p.value })))
    predict = raw => t.at(raw)
    proposed = `monotone table (${t.xs.length} pts)`
    table = Array.from(t.xs, (x, i) => [x, t.ys[i]])
    notes.push(
      `${flagged.length}/${points.length} points deviate > ${PITCH_FLAG_CENTS}¢ — proposing a monotone replacement table`,
    )
  } else if (flagged.length === 0) {
    notes.push(`all ${points.length} points within ±${PITCH_FLAG_CENTS}¢ of documented pitchToCents`)
  }

  const fitCents = centsResidualRms(fit, predict)
  const heldCents = held.length > 0 ? centsResidualRms(held, predict) : NaN
  if (held.length === 0) {
    notes.push(`only ${points.length} points (< 8): fit on all points, no held-out validation`)
  }
  notes.push(
    `pitch residual: fit ${fitCents.toFixed(2)}¢ RMS, held-out ` +
      `${Number.isFinite(heldCents) ? heldCents.toFixed(2) + '¢ RMS' : 'n/a'}`,
  )
  return {
    domain: 'pitch',
    unit: 'cents',
    current: 'pitchToCents(raw) (documented table)',
    proposed,
    fitResidualPct: fitCents * LN_PER_CENT * 100,
    heldOutResidualPct: heldCents * LN_PER_CENT * 100,
    table,
    notes,
  }
}

/**
 * Markdown block for one proposal in report.md: current vs proposed
 * expression, fit/held-out residuals, notes, the raw -> value table when
 * present, and the provenance tag line MEASURED(<measuredDate>). The date is
 * a caller-supplied ISO string so this module stays pure.
 */
export function renderProposalMd(p: Proposal, measuredDate: string): string {
  const lines: string[] = []
  lines.push(`### ${p.domain} (${p.unit})`)
  lines.push('')
  lines.push(`- current: \`${p.current}\``)
  lines.push(`- proposed: \`${p.proposed}\``)
  lines.push(
    `- residual (log RMS): fit ${fmtPct(p.fitResidualPct)}, held-out ${fmtPct(p.heldOutResidualPct)}`,
  )
  lines.push(`- provenance: MEASURED(${measuredDate})`)
  for (const n of p.notes) lines.push(`- ${n}`)
  if (p.table) {
    lines.push('')
    lines.push(`| raw | ${p.unit} |`)
    lines.push('|---|---|')
    for (const [raw, v] of p.table) {
      lines.push(`| ${raw} | ${Number.isFinite(v) ? Number(v.toPrecision(5)).toString() : String(v)} |`)
    }
  }
  return lines.join('\n')
}
