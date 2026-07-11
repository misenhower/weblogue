/*
 * D2 SHAPE-morph measurement: mean-cycle extraction at the doubled note
 * period and model-parameter fits for the three measured morphs
 * (findings log 2026-07-11 + the evidence artifact):
 *
 *   SQR  constant-swing pulse       -> duty d
 *   TRI  single soft fold           -> drive g' (+ global knee radius)
 *   SAW  half-rate chopper          -> depth m, flip phase phi
 *
 * Fits run the model through the measurement chain's AC-coupling (a 1-pole
 * HPF at CAPTURE_HPF_FC for hardware captures — fitted from the known
 * plain-triangle bow; 0 = identity for replica renders, which have no
 * coupling), then compare against the mean cycle with a free amplitude
 * scale and free rotation. Fitted parameters are therefore physical, per
 * world — the "shared extractor" principle applies to the comparison, not
 * to transplanting raw measured values (see the bias-inversion finding).
 */
import { phasePitchTrack } from './features'

/** Grid points per extracted mean cycle (spans ~2 note periods). */
export const CYCLE_GRID = 400

/**
 * 1-pole equivalent corner of the xd-output -> ProFX capture coupling,
 * fitted 2026-07-11 from the known plain-triangle bow (rig findings; likely
 * two-plus real poles masquerading as one — fine for cycle-scale fits).
 */
export const CAPTURE_HPF_FC = 40

export interface ShapeCycle {
  /** true cycle fundamental of the extracted span (Hz) */
  f0: number
  /** mean cycle over CYCLE_GRID points, spanning ~2 nominal periods */
  cycle: number[]
}

/**
 * Extract the mean cycle spanning ~two NOMINAL periods, locked to the
 * strongest measured periodicity: k = round(2*T_nominal / T_measured)
 * measured periods (k=2 plain waves, k=1 period-doubled saw, k=6 the TRI
 * x3 triple). Canonical trigger (cycle-min anchor, then rising crossing).
 */
export function extractMeanCycle(
  x: Float32Array,
  sr: number,
  from: number,
  to: number,
  f0Measured: number,
  nominalHz: number,
  cycles = 30,
): ShapeCycle | null {
  if (!(f0Measured > 0) || to - from < sr * 0.2) return null
  const k = Math.max(1, Math.round((2 / nominalHz) * f0Measured))
  const track = phasePitchTrack(x, sr, f0Measured, { from, to })
  const v = Array.from(track.v).sort((a, b) => a - b)
  const f0 = v[v.length >> 1]
  if (!(f0 > 0)) return null
  const period = (k * sr) / f0
  let minI = from
  const mTo = Math.min(x.length - 1, from + Math.round(period))
  for (let i = from + 1; i < mTo; i++) if (x[i] < x[minI]) minI = i
  let s = minI
  for (let i = minI + 1; i <= Math.min(x.length - 2, minI + Math.round(period)); i++) {
    if (x[i - 1] <= 0 && x[i] > 0) {
      s = i
      break
    }
  }
  const acc = new Float64Array(CYCLE_GRID)
  let used = 0
  for (let c = 0; c < cycles; c++) {
    const base = s + c * period
    if (base + period + 1 >= x.length) break
    for (let g = 0; g < CYCLE_GRID; g++) {
      const t = base + (g * period) / CYCLE_GRID
      const i0 = Math.floor(t)
      const fr = t - i0
      acc[g] += x[i0] * (1 - fr) + x[i0 + 1] * fr
    }
    used++
  }
  if (used < 4) return null
  return { f0: f0 / (k / 2), cycle: Array.from(acc, (a) => a / used) }
}

/** Steady-state periodic response of the 1-pole DC blocker over one cycle. */
export function hpfPeriodic(cycle: readonly number[], fcHz: number, cycleHz: number): number[] {
  if (!(fcHz > 0)) return cycle.slice()
  const srEff = cycle.length * cycleHz
  const R = 1 - (2 * Math.PI * fcHz) / srEff
  let x1 = cycle[cycle.length - 1]
  let y1 = 0
  let out: number[] = []
  for (let rep = 0; rep < 8; rep++) {
    out = []
    for (const x of cycle) {
      const y = x - x1 + R * y1
      x1 = x
      y1 = y
      out.push(y)
    }
  }
  return out
}

/** Best amplitude scale + relative residual of hw vs a*model (mean-free). */
function fitScale(hw: readonly number[], model: readonly number[]): { a: number; res: number } {
  const mean = (v: readonly number[]): number => v.reduce((s, x) => s + x, 0) / v.length
  const mh = mean(hw)
  const mm = mean(model)
  let num = 0
  let den = 0
  let ph = 0
  for (let i = 0; i < hw.length; i++) {
    const h = hw[i] - mh
    const m = model[i] - mm
    num += h * m
    den += m * m
    ph += h * h
  }
  const a = den > 0 ? num / den : 0
  let e = 0
  for (let i = 0; i < hw.length; i++) {
    const d = hw[i] - mh - a * (model[i] - mm)
    e += d * d
  }
  return { a, res: Math.sqrt(e / Math.max(1e-12, ph)) }
}

/** fitScale over all circular rotations of the model (coarse + refine). */
export function fitShifted(
  hw: readonly number[],
  model: readonly number[],
  step = 3,
): { a: number; res: number; shift: number } {
  const n = model.length
  let best = { a: 0, res: Infinity, shift: 0 }
  const rotated = new Array<number>(n)
  const evalAt = (sh: number): void => {
    for (let i = 0; i < n; i++) rotated[i] = model[(i + sh) % n]
    const f = fitScale(hw, rotated)
    if (f.res < best.res) best = { a: f.a, res: f.res, shift: sh }
  }
  for (let sh = 0; sh < n; sh += step) evalAt(sh)
  const c = best.shift
  for (let sh = c - step + 1; sh <= c + step - 1; sh++) evalAt(((sh % n) + n) % n)
  return best
}

const frac = (x: number): number => x - Math.floor(x)

/** Constant-swing pulse over 2 periods (the cycle grid spans 2T). */
export function pulseCycle(duty: number): number[] {
  return Array.from({ length: CYCLE_GRID }, (_, i) => (frac((2 * i) / CYCLE_GRID) < duty ? 1 : -1))
}

/** Single soft fold of a triangle over 2 periods (osc.ts softFold1 math). */
export function triFoldCycle(drive: number, knee: number): number[] {
  const out = new Array<number>(CYCLE_GRID)
  for (let i = 0; i < CYCLE_GRID; i++) {
    const ph = frac((2 * i) / CYCLE_GRID)
    const tri = ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph
    let v = drive * tri
    const s = v < 0 ? -1 : 1
    const a = s * v
    if (knee > 1e-6) {
      const lo = 1 - knee
      if (a > lo) {
        const e = a - lo
        v = e < 2 * knee ? s * (lo + e - (e * e) / (2 * knee)) : s * (2 - a)
      }
    } else if (a > 1) v = s * (2 - a)
    out[i] = v
  }
  return out
}

/** Half-rate chopped saw over 2 periods (osc.ts sawChopSample math, naive). */
export function sawChopCycle(m: number, phi: number): number[] {
  const out = new Array<number>(CYCLE_GRID)
  for (let i = 0; i < CYCLE_GRID; i++) {
    const ph = (2 * i) / CYCLE_GRID // 0..2 periods
    const saw = 2 * frac(ph) - 1
    const par = ph < 1 ? 1 : -1
    const g = frac(ph) < phi ? 1 - m - m * par : 1 - m + m * par
    out[i] = saw * g
  }
  return out
}

export interface ShapeFit {
  /** primary model parameter (duty / drive / m) */
  param: number
  /** secondary parameter (SAW phi; unused otherwise) */
  param2: number
  /** relative waveform residual (0..1+) */
  res: number
  /** fitted amplitude scale (capture or engine units) */
  level: number
}

export function fitSqrDuty(cy: ShapeCycle, fcHz: number): ShapeFit {
  let best: ShapeFit = { param: 0.5, param2: 0, res: Infinity, level: 0 }
  const scan = (lo: number, hi: number, step: number): void => {
    for (let d = lo; d <= hi; d += step) {
      const f = fitShifted(cy.cycle, hpfPeriodic(pulseCycle(d), fcHz, cy.f0))
      if (f.res < best.res) best = { param: d, param2: 0, res: f.res, level: Math.abs(f.a) }
    }
  }
  scan(0.02, 0.55, 0.02)
  scan(Math.max(0.01, best.param - 0.025), best.param + 0.025, 0.0025)
  return best
}

export function fitTriFold(cy: ShapeCycle, fcHz: number, knee: number): ShapeFit {
  let best: ShapeFit = { param: 1, param2: 0, res: Infinity, level: 0 }
  const scan = (lo: number, hi: number, step: number): void => {
    for (let g = lo; g <= hi; g += step) {
      const f = fitShifted(cy.cycle, hpfPeriodic(triFoldCycle(g, knee), fcHz, cy.f0))
      if (f.res < best.res) best = { param: g, param2: 0, res: f.res, level: Math.abs(f.a) }
    }
  }
  scan(1, 3.05, 0.05)
  scan(Math.max(1, best.param - 0.06), Math.min(3.1, best.param + 0.06), 0.01)
  return best
}

export function fitSawChop(cy: ShapeCycle, fcHz: number): ShapeFit {
  let best: ShapeFit = { param: 0, param2: 0.5, res: Infinity, level: 0 }
  for (let m = 0; m <= 1.001; m += 0.05) {
    for (let phi = 0; phi <= 0.51; phi += 0.025) {
      const f = fitShifted(cy.cycle, hpfPeriodic(sawChopCycle(m, phi), fcHz, cy.f0), 6)
      if (f.res < best.res) best = { param: m, param2: phi, res: f.res, level: Math.abs(f.a) }
      if (m === 0) break // phi meaningless at m = 0
    }
  }
  for (let m = Math.max(0, best.param - 0.06); m <= Math.min(1, best.param + 0.06); m += 0.01) {
    for (let phi = Math.max(0, best.param2 - 0.03); phi <= Math.min(0.55, best.param2 + 0.03); phi += 0.005) {
      const f = fitShifted(cy.cycle, hpfPeriodic(sawChopCycle(m, phi), fcHz, cy.f0))
      if (f.res < best.res) best = { param: m, param2: phi, res: f.res, level: Math.abs(f.a) }
    }
  }
  return best
}
