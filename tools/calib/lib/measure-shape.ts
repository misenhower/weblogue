/*
 * D2 SHAPE-morph measurement: mean-cycle extraction at the doubled note
 * period and model-parameter fits for the three measured morphs
 * (findings log 2026-07-11 + the evidence artifact):
 *
 *   SQR  constant-swing pulse       -> duty d
 *   TRI  single soft fold           -> drive g' (+ global knee radius)
 *   SAW  reversal mirror            -> window half-width w
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

/** Grid points per extracted mean cycle (spans ~2 note periods). 800 keeps
 *  step-edge features resolvable — at 400 the SAW mirror fits hit a
 *  resolution floor near w = 0.5 (read 0.48 where the structural truth is
 *  exactly 0.5; 2026-07-11 rerun comparison). */
export const CYCLE_GRID = 800

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
  lockF0 = false,
): ShapeCycle | null {
  if (!(f0Measured > 0) || to - from < sr * 0.2) return null
  const k = Math.max(1, Math.round((2 / nominalHz) * f0Measured))
  let f0 = f0Measured
  if (!lockF0) {
    const track = phasePitchTrack(x, sr, f0Measured, { from, to })
    const v = Array.from(track.v).sort((a, b) => a - b)
    f0 = v[v.length >> 1]
  }
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
  positiveScale = false,
): { a: number; res: number; shift: number } {
  const n = model.length
  let best = { a: 0, res: Infinity, shift: 0 }
  const rotated = new Array<number>(n)
  const evalAt = (sh: number): void => {
    for (let i = 0; i < n; i++) rotated[i] = model[(i + sh) % n]
    const f = fitScale(hw, rotated)
    // display alignment must reject the negated branch: on half-wave
    // antisymmetric waves (SAW mirror at w = 0.5) a rotation by one period
    // fits exactly as well with a < 0 — and the display doesn't negate
    if (positiveScale && f.a <= 0) return
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

/** Reversal-mirror saw over 2 periods (osc.ts sawMirrorSample math, naive):
 *  saw(PHI) except saw(2-PHI) inside the (1-w, 1+w) window. */
export function sawMirrorCycle(w: number): number[] {
  const out = new Array<number>(CYCLE_GRID)
  for (let i = 0; i < CYCLE_GRID; i++) {
    const ph = (2 * i) / CYCLE_GRID // 0..2 periods
    const inWin = w > 1e-9 && ph > 1 - w && ph < 1 + w
    out[i] = inWin ? 2 * frac(2 - ph) - 1 : 2 * frac(ph) - 1
  }
  return out
}

/**
 * Capture-integrity check for SHAPE morphs, replacing the phase-jump gate:
 * morph waveforms legitimately contain intra-cycle steps (the SAW mirror's
 * window edges false-trigger a tone-model phase probe — 11/33 false FAILs on
 * the 2026-07-11 dense sweep), but they are strictly periodic — so the mean
 * cycle extracted from the FIRST and SECOND halves of the sustain must
 * agree. Real splices/drops decorrelate the halves; the one genuinely weak
 * capture in that sweep (raw 544, 11.6%) is exactly what this catches.
 * Returns the relative residual between the half-extractions (null when the
 * window is too short to split).
 */
export function shapeCycleConsistency(
  x: Float32Array,
  sr: number,
  from: number,
  to: number,
  f0Measured: number,
  nominalHz: number,
): number | null {
  const mid = Math.floor((from + to) / 2)
  // ONE period estimate for both halves (lockF0): independent re-tracking
  // can differ by ~0.2% between halves, which alone smears the mean-cycle
  // edges into a false ~20% disagreement on clean captures
  const a = extractMeanCycle(x, sr, from, mid, f0Measured, nominalHz, 15, true)
  const b = extractMeanCycle(x, sr, mid, to, f0Measured, nominalHz, 15, true)
  if (!a || !b) return null
  return fitShifted(a.cycle, b.cycle).res
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

export function fitSawMirror(cy: ShapeCycle, fcHz: number): ShapeFit {
  let best: ShapeFit = { param: 0, param2: 0, res: Infinity, level: 0 }
  const scan = (lo: number, hi: number, step: number, shift: number): void => {
    for (let w = lo; w <= hi; w += step) {
      const f = fitShifted(cy.cycle, hpfPeriodic(sawMirrorCycle(w), fcHz, cy.f0), shift)
      if (f.res < best.res) best = { param: w, param2: 0, res: f.res, level: Math.abs(f.a) }
    }
  }
  scan(0, 0.5001, 0.02, 6)
  scan(Math.max(0, best.param - 0.025), Math.min(0.5, best.param + 0.025), 0.0025, 3)
  return best
}

/**
 * Align the replica snapshot to the hardware one for display. Relative phase
 * between a free-running analog capture and an offline render is arbitrary
 * (every fit in the pipeline is rotation-free for this reason), so the raw
 * thumbnails land at random horizontal offsets — eyeball-hostile. Crop both
 * to their best-overlap window (equal lengths, so the page's x-stretch stays
 * matched). Display-only: stored features are untouched.
 */
export function alignSnaps(
  hw?: number[],
  rep?: number[],
): { hw?: number[]; rep?: number[] } {
  if (!hw || !rep || hw.length !== rep.length || hw.length < 40) return { hw, rep }
  const n = hw.length
  const max = Math.floor(n * 0.4)
  let bestK = 0
  let bestScore = -Infinity
  for (let k = -max; k <= max; k++) {
    let c = 0
    const iFrom = Math.max(0, -k)
    const iTo = n - Math.max(0, k)
    for (let i = iFrom; i < iTo; i++) c += hw[i] * rep[i + k]
    const ov = iTo - iFrom
    const score = c / ov + ov * 1e-6 // prefer larger overlap on near-ties
    if (score > bestScore) {
      bestScore = score
      bestK = k
    }
  }
  if (bestK === 0) return { hw, rep }
  const hwFrom = Math.max(0, -bestK)
  const hwTo = hw.length - Math.max(0, bestK)
  return { hw: hw.slice(hwFrom, hwTo), rep: rep.slice(hwFrom + bestK, hwTo + bestK) }
}

/**
 * Display pair for a vco.shape point: both worlds' mean cycles — exactly two
 * nominal periods each, so the time bases match BY CONSTRUCTION (raw
 * waveSnaps span 2.5 cycles of each world's own f0 estimate, which diverges
 * mid-morph when the trackers lock different subharmonics — the panels then
 * aren't even the same span, and no shift can align them). The replica is
 * circularly rotated onto the hardware (exact on a periodic buffer: relative
 * phase between a free-running capture and an offline render carries no
 * information), both peak-normalized and decimated for the page.
 */
export function alignedCycleSnaps(
  hw: ShapeCycle | undefined,
  rep: ShapeCycle | undefined,
  points = 200,
): { hw: number[]; rep: number[] } | null {
  if (!hw || !rep || hw.cycle.length < points || rep.cycle.length < points) return null
  // common grid regardless of each cycle's stored resolution (sessions from
  // before the 800-grid bump carry 400)
  const n = points * 2
  const resample = (c: readonly number[]): number[] => {
    const out = new Array<number>(n)
    for (let i = 0; i < n; i++) {
      const t = (i * c.length) / n
      const i0 = Math.floor(t)
      const fr = t - i0
      out[i] = c[i0 % c.length] * (1 - fr) + c[(i0 + 1) % c.length] * fr
    }
    return out
  }
  const h = resample(hw.cycle)
  const r = resample(rep.cycle)
  // rotate against the capture-coupled version of the replica: the hardware
  // trace carries the chain's HPF (real phase lead, ~36 deg at 55 Hz), so
  // correlating clean-vs-bowed finds a genuinely shifted optimum. The
  // DISPLAYED replica stays clean.
  const { shift } = fitShifted(h, hpfPeriodic(r, CAPTURE_HPF_FC, hw.f0), 2, true)
  const norm = (c: readonly number[], rot: number): number[] => {
    let pk = 1e-9
    for (const v of c) pk = Math.max(pk, Math.abs(v))
    const out = new Array<number>(points)
    for (let i = 0; i < points; i++) {
      out[i] = Math.round((c[(i * 2 + rot) % n] / pk) * 1000) / 1000
    }
    return out
  }
  return { hw: norm(h, 0), rep: norm(r, shift) }
}
