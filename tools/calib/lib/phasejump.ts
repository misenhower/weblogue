/*
 * Capture-corruption detector (docs/hardware-calibration.md, 'Visibility and
 * fail-fast'): the phase-jump scan that replaces measure.ts's slope-threshold
 * countDiscontinuities. A duplicated or dropped USB chunk of N samples shifts
 * every partial's phase by 2*pi*f*N/sr within one hop, while analog drift,
 * vibrato and legato glides move phase orders of magnitude slower — so we
 * detect splices as step-like outliers in a harmonic's phase track instead of
 * scanning raw sample slopes (which proved phase-sensitive after resampling).
 *
 * Method: track the phase of TWO harmonics of f0 (targets ~900 and ~1700 Hz —
 * high enough that a 10-sample splice is a large fraction of a cycle, low
 * enough to carry energy on every calib stimulus) with a complex Goertzel per
 * ~15 ms Hann window, 5 ms hop. The window spans an integer number of f0
 * periods (min 2) so neighbouring harmonics land >= 2 bins away, on the Hann
 * kernel's nulls; Hann is chosen over rectangular because its sidelobes keep
 * drift-detuned harmonics quiet and its wide main lobe keeps a legato glide's
 * phase smooth instead of flipping at a Dirichlet null. Per hop we take the
 * phase advance, unwrap it into a continuous series (so glides that cross the
 * hop aliasing limit of 1/(2*hop) Hz stay smooth), subtract the local median
 * advance over a 15-frame neighborhood, and flag |residual| bursts lasting at
 * most one window's smear (1..4 hops) — a step, not a ramp.
 *
 * Probe selection is adaptive, because some stimuli miss whole harmonic
 * families (a 50% square has no even harmonics) and sweep jobs can sit far
 * from nominalHz — a probe tracking an absent partial sees leakage/noise
 * phases that look like a storm of jumps. A candidate probe's events only
 * count if it (1) proves COHERENCE (median |residual| under 0.025 cycles per
 * segment) and (2) is not dwarfed by the strongest analyzed probe (median
 * Goertzel magnitude >= 10% of the best — weak bins track their neighbours'
 * sidelobes, which occasionally phase-slip exactly like a splice). Ineligible
 * candidates are swapped for the next-nearest harmonic. The event threshold
 * also rides each segment's own noise (max(0.045, 7 * median |residual|)) so
 * marginal probes must clear a proportionally higher bar. The two probes are
 * kept coprime so a splice spanning whole cycles of one (phase step ~
 * integer, invisible there) cannot also span whole cycles of the other.
 * Events within 30 ms merge into one; frames below 5% of a probe's median
 * magnitude are treated as silence and never scanned.
 *
 * Pure DSP over Float32Array — no node imports (same rule as features.ts).
 */
import { goertzelC } from './features'

const HOP_SEC = 0.005
const WIN_SEC = 0.015 // target; realized as an integer number of f0 periods
const HALF = 7 // 15-frame neighborhood for the locally-expected advance
const THRESH_CYC = 0.045 // residual threshold, cycles per hop
const MAX_RUN_HOPS = 4 // longest burst still counted as a step (~1 window)
const MERGE_SEC = 0.03
const MAG_GATE = 0.05 // frames below 5% of median magnitude are silence
const COHERENCE_CYC = 0.025 // median |residual| above this = not a real partial
const NOISE_MULT = 7 // event threshold rides the segment's own residual noise
const MAG_FRACTION = 0.1 // probes dwarfed by the best one track sidelobes, not partials
const CAND_PER_SLOT = 3 // harmonics auditioned per probe slot
const PROBE_TARGET_HZ = [900, 1700]

interface JumpEvent {
  tSec: number
  strength: number
}

interface ProbeScan {
  events: JumpEvent[]
  /** phase advances inside segments that passed the coherence check */
  coherentAdv: number
  /** all phase advances inside non-silent segments */
  reliableAdv: number
  /** median Goertzel magnitude across frames — cross-probe strength gauge */
  medMag: number
}

/** Wrap an angle to (-pi, pi]. */
function wrapPi(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI))
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

/** Step-like phase-advance outliers of one probe over x[from..to). */
function scanProbe(
  x: Float32Array,
  sr: number,
  fp: number,
  win: number,
  from: number,
  to: number,
): ProbeScan {
  const scan: ProbeScan = { events: [], coherentAdv: 0, reliableAdv: 0, medMag: 0 }
  const hop = Math.max(1, Math.round(HOP_SEC * sr))
  const frames = Math.floor((to - from - win) / hop) + 1
  if (frames < 2 * HALF + 3) return scan

  // periodic Hann (denominator n): with an integer-period window this nulls
  // every other harmonic of f0 exactly (they sit on integer bins >= 2 away)
  const w = new Float32Array(win)
  for (let i = 0; i < win; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win)
  const buf = new Float32Array(win)
  const ph = new Float64Array(frames)
  const mg = new Float64Array(frames)
  for (let f = 0; f < frames; f++) {
    const start = from + f * hop
    for (let i = 0; i < win; i++) buf[i] = x[start + i] * w[i]
    const g = goertzelC(buf, 0, win, fp, sr)
    ph[f] = Math.atan2(g.im, g.re)
    mg[f] = Math.hypot(g.re, g.im)
  }
  scan.medMag = median(Array.from(mg))
  const gate = MAG_GATE * scan.medMag
  const hopPhase = wrapPi(((2 * Math.PI * fp) / sr) * hop)

  // scan each run of reliable (non-silent) frames independently, so garbage
  // phases in a gap can never leak a fake 2*pi offset into the unwrapping
  const scanSegment = (s: number, e: number): void => {
    const n = e - s - 1 // advances between consecutive frames
    if (n < 1) return
    scan.reliableAdv += n
    if (n < 2 * HALF + 2) return
    const au = new Float64Array(n)
    for (let j = 0; j < n; j++) {
      const raw = wrapPi(ph[s + j + 1] - ph[s + j] - hopPhase)
      // unwrap against the previous advance: slow drift/glides stay smooth
      // even past the aliasing limit; a splice is still a one-hop outlier
      au[j] = j === 0 ? raw : au[j - 1] + wrapPi(raw - au[j - 1])
    }
    const r = new Float64Array(n)
    const nb: number[] = []
    for (let j = 0; j < n; j++) {
      nb.length = 0
      for (let m = Math.max(0, j - HALF); m <= Math.min(n - 1, j + HALF); m++) nb.push(au[m])
      r[j] = (au[j] - median(nb)) / (2 * Math.PI)
    }
    // coherence: a real partial advances steadily (median |r| ~ 0.001-0.01
    // cycles even with drift); an absent harmonic yields noise phases an
    // order of magnitude above. Robust to the splices themselves (<= 4 of n)
    const spread = median(Array.from(r, Math.abs))
    if (spread > COHERENCE_CYC) return
    scan.coherentAdv += n
    // marginal probes (leakage mixtures, off-nominal sweeps) wobble at a few
    // hundredths of a cycle — demand proportionally more before crying splice
    const thresh = Math.max(THRESH_CYC, NOISE_MULT * spread)
    for (let j = 0; j < n; ) {
      if (Math.abs(r[j]) <= thresh) {
        j++
        continue
      }
      let k = j
      let peak = j
      while (k < n && Math.abs(r[k]) > thresh) {
        if (Math.abs(r[k]) > Math.abs(r[peak])) peak = k
        k++
      }
      if (k - j <= MAX_RUN_HOPS) {
        // advance `peak` sits between the windows centered on frames i-1, i
        const i = s + peak + 1
        scan.events.push({
          tSec: (from + (i - 0.5) * hop + win / 2) / sr,
          strength: Math.abs(r[peak]),
        })
      }
      j = k
    }
  }

  let s = 0
  while (s < frames) {
    if (mg[s] <= gate) {
      s++
      continue
    }
    let e = s
    while (e < frames && mg[e] > gate) e++
    scanSegment(s, e)
    s = e
  }
  return scan
}

/**
 * Count instantaneous phase jumps of a tonal capture over x[from..to)
 * (sample indices) — the signature of duplicated or dropped USB chunks.
 * f0Hz is the stimulus fundamental (the job's nominalHz); a few cents of
 * error is fine. Returns the merged event count and each event's time in
 * seconds from x[0] (window-center convention, accurate to ~win/2).
 * Best-effort on non-tonal captures: probes that track no coherent partial
 * are discarded, and with none left the capture reads as clean.
 */
export function phaseJumps(
  x: Float32Array,
  sr: number,
  f0Hz: number,
  from: number,
  to: number,
): { count: number; atSec: number[] } {
  const lo = Math.max(0, Math.floor(from))
  const hi = Math.min(x.length, Math.floor(to))
  if (!(sr > 0) || !(f0Hz > 0) || hi - lo < 8) return { count: 0, atSec: [] }
  const periods = Math.max(2, Math.round(WIN_SEC * f0Hz))
  const win = Math.max(4, Math.round((periods / f0Hz) * sr))
  if (hi - lo <= win) return { count: 0, atSec: [] }

  const cache = new Map<number, ProbeScan>()
  let maxMed = 0
  const analyze = (k: number): ProbeScan => {
    let a = cache.get(k)
    if (a === undefined) {
      a = scanProbe(x, sr, k * f0Hz, win, lo, hi)
      cache.set(k, a)
      maxMed = Math.max(maxMed, a.medMag)
    }
    return a
  }
  // eligible = mostly-coherent AND carrying real energy relative to the
  // strongest probe analyzed so far (weak bins track neighbours' sidelobes)
  const eligible = (k: number): boolean => {
    const a = analyze(k)
    return (
      a.reliableAdv > 0 &&
      a.coherentAdv >= 0.5 * a.reliableAdv &&
      a.medMag >= MAG_FRACTION * maxMed
    )
  }

  // probe slots: nearest eligible harmonic to each target, in-band, coprime
  const kLo = Math.max(1, Math.ceil(400 / f0Hz))
  const kHi = Math.max(kLo, Math.floor(Math.min(2000, 0.45 * sr) / f0Hz))
  const slotCands = (targetHz: number, ok: (k: number) => boolean): number[] => {
    const cands: number[] = []
    for (let k = kLo; k <= kHi; k++) if (ok(k)) cands.push(k)
    cands.sort((a, b) => Math.abs(a * f0Hz - targetHz) - Math.abs(b * f0Hz - targetHz))
    return cands.slice(0, CAND_PER_SLOT)
  }
  const candsA = slotCands(PROBE_TARGET_HZ[0], () => true)
  for (const k of candsA) analyze(k) // settle maxMed before judging any of them
  const kA = candsA.find(eligible) ?? 0
  const candsB = slotCands(
    PROBE_TARGET_HZ[1],
    (k) => k !== kA && (kA === 0 || gcd(kA, k) === 1),
  )
  for (const k of candsB) analyze(k)
  let kB = candsB.find(eligible) ?? 0
  if (kA > 0 && kB === 0) {
    // band held no second eligible harmonic (f0 near/above it, or the
    // coprime neighbours are missing from this stimulus) — reach upward
    for (let k = kA + 1; k <= kA + CAND_PER_SLOT; k++) {
      if (k !== kB && k * f0Hz < 0.45 * sr && gcd(kA, k) === 1 && eligible(k)) {
        kB = k
        break
      }
    }
  }

  const events: JumpEvent[] = []
  // re-check against the final maxMed: a slot picked early is dropped when a
  // later analysis reveals it was only a sidelobe of a much stronger partial
  for (const k of [kA, kB]) if (k > 0 && eligible(k)) events.push(...analyze(k).events)
  events.sort((a, b) => a.tSec - b.tSec)

  // one physical splice shows on both probes and can straddle a threshold
  // dip — chain-merge everything within 30 ms, keep the strongest's time
  const atSec: number[] = []
  let best: JumpEvent | null = null
  let lastT = -Infinity
  for (const ev of events) {
    if (best !== null && ev.tSec - lastT > MERGE_SEC) {
      atSec.push(best.tSec)
      best = null
    }
    if (best === null || ev.strength > best.strength) best = ev
    lastT = ev.tSec
  }
  if (best !== null) atSec.push(best.tSec)
  return { count: atSec.length, atSec }
}

/**
 * Per-point capture gate: null when the capture looks clean (<= 2 phase
 * jumps — isolated hits happen on hard note transients), otherwise a short
 * human-readable reason for the retry/pause machinery.
 */
export function captureVerdict(
  x: Float32Array,
  sr: number,
  f0Hz: number,
  from: number,
  to: number,
): string | null {
  const { count } = phaseJumps(x, sr, f0Hz, from, to)
  return count > 2 ? `${count} phase jumps (USB splice/drop suspected)` : null
}
