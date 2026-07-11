/*
 * Point measurement shared by the hardware and replica paths: given samples,
 * an onset, and the job's note plan, extract the M2 feature set (peak level,
 * f0 via FFT coarse + phase-tracker fine, harmonic ladder). Both worlds run
 * exactly this code, so extractor bias cancels in the comparison.
 */
import type { CalibJob } from './job'
import { expandNotes } from './job'
import { fftPeakHz, phasePitchTrack, harmonicLadder, goertzelC } from './features'
import { peakDbfs } from './onset'

export interface StrikeFeatures {
  f0Hz: number
  cents: number
}

export interface PointFeatures {
  peakDbfs: number
  /** median across strikes */
  f0Hz: number
  /** cents vs job.features.nominalHz (0 when no nominal is given), median */
  cents: number
  /** max - min cents across strikes (per-voice tuning spread under round-robin) */
  centsSpread: number
  /** per-strike pitch (round-robin: strike k ~ voice k on a fresh rotor) */
  strikes: StrikeFeatures[]
  /** dB re k=1, index 0 = H1 (always 0); per-harmonic median across strikes */
  harmonicsDb: number[]
  /**
   * ~2.5 cycles of the first strike's sustain, zero-cross aligned, peak-
   * normalized, 200 points — the dashboard's per-point mini-scope.
   */
  waveSnap: number[]
}

/**
 * Waves can cross zero more than once per cycle (period-doubled SAW teeth,
 * folded TRI), so triggering on "first rising crossing" lands on a different
 * crossing class per capture and the thumbnails look mis-triggered (Matt's
 * catch, 2026-07-10). Canonical trigger instead: anchor at the cycle's
 * GLOBAL minimum (unique per cycle for every wave we render), then start at
 * the first rising zero crossing after it. Exported for tests.
 */
export function waveSnapshot(x: Float32Array, sr: number, from: number, f0: number, points = 200, cycles = 2.5): number[] {
  const period = Math.max(4, Math.round(sr / Math.max(1, f0)))
  const span = Math.max(8, Math.round(cycles * period))
  const base = Math.min(from, Math.max(0, x.length - span - 1))
  let minI = base
  const mTo = Math.min(x.length - 1, base + period)
  for (let i = base + 1; i < mTo; i++) if (x[i] < x[minI]) minI = i
  let s = minI
  const cTo = Math.min(x.length - 2, minI + period)
  for (let i = minI + 1; i <= cTo; i++) {
    if (x[i - 1] <= 0 && x[i] > 0) {
      s = i
      break
    }
  }
  s = Math.max(0, Math.min(s, x.length - span - 1))
  const out = new Array<number>(points)
  let peak = 1e-9
  for (let p = 0; p < points; p++) {
    const v = x[s + Math.round((p * span) / (points - 1))] ?? 0
    out[p] = v
    peak = Math.max(peak, Math.abs(v))
  }
  return out.map((v) => Math.round((v / peak) * 1000) / 1000)
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

/** One strike's sustain window: onset+150ms (past attack/settling) to onset+dur-100ms. */
function measureStrike(
  x: Float32Array,
  sr: number,
  strikeOnset: number,
  noteDur: number,
  job: CalibJob,
): { f0: number; ladder: number[] } {
  const from = Math.min(x.length - 1, strikeOnset + Math.round(0.15 * sr))
  const to = Math.min(
    x.length,
    Math.max(from + Math.round(0.3 * sr), strikeOnset + Math.round((noteDur - 0.1) * sr)),
  )
  let coarse = fftPeakHz(x, from, Math.min(16384, to - from), sr)
  // subharmonic descent: on narrow pulses and folded waves a harmonic can
  // out-peak H1 (e.g. SQR at d=0.15 has H2 > H1) — if f/2 or f/3 carries
  // real energy, the fundamental is below the FFT peak
  const gTo = Math.min(to, from + 16384)
  const powerAt = (f: number): number => goertzelC(x, from, gTo, f, sr).power
  const peakPower = powerAt(coarse)
  for (const div of [3, 2]) {
    const cand = coarse / div
    if (cand >= 25 && powerAt(cand) > 0.2 * peakPower) {
      coarse = cand
      break
    }
  }
  const seed = job.features.nominalHz ?? coarse
  // trust the coarse FFT unless it's wildly off the nominal (harmonic grab).
  // ±1300¢ accepts the full ±1200¢ PITCH-knob sweep range while still
  // rejecting a 3rd-harmonic grab (+1902¢); H2 can't dominate on saw/tri/sqr.
  const nominal = Math.abs(1200 * Math.log2(coarse / seed)) < 1300 ? coarse : seed
  const track = phasePitchTrack(x, sr, nominal, { from, to })
  const f0 = median(Array.from(track.v))
  const ladder = harmonicLadder(x, sr, from, f0, job.features.harmonics ?? 8)
  return { f0, ladder: ladder.map((h) => h.db) }
}

/**
 * Count waveform-continuity violations: large-slope events whose spacing is
 * far off the dominant periodic spacing (saw resets etc.). Duplicated or
 * dropped USB audio chunks show up here even when long-term pitch survives.
 * Only meaningful for strongly periodic tonal captures.
 */
export function countDiscontinuities(x: Float32Array): number {
  let peak = 0
  const jumps: number[] = []
  for (let i = 1; i < x.length; i++) {
    const a = Math.abs(x[i])
    if (a > peak) peak = a
    // 0.5×peak catches the (resampler-spread) saw reset every cycle so the
    // periodic baseline is dense; rare non-clustered spacings are the glitches
    if (Math.abs(x[i] - x[i - 1]) > peak * 0.5 && peak > 0.005) jumps.push(i)
  }
  if (jumps.length < 8) return 0
  const gaps = jumps.slice(1).map((j, k) => j - jumps[k])
  const med = [...gaps].sort((a, b) => a - b)[gaps.length >> 1]
  if (med <= 0) return 0
  // a waveform may have several legitimate slope events per cycle (e.g. the
  // SAW morph's second reset), so any gap spacing that recurs in >=10% of
  // cycles is a wave feature, not a glitch. Splices are rare by definition.
  const common: number[] = []
  for (const g of gaps) {
    if (common.some((c) => Math.abs(g - c) <= c * 0.25)) continue
    const share = gaps.filter((o) => Math.abs(o - g) <= g * 0.25).length / gaps.length
    if (share >= 0.1) common.push(g)
  }
  // gaps of thousands of samples are the silences between strikes, not glitches
  return gaps.filter(
    (g) => g > 4 && g < med * 20 && !common.some((c) => Math.abs(g - c) <= c * 0.25),
  ).length
}

/**
 * Measure every strike of the (repeat-expanded) note plan. The first strike's
 * onset is `onsetSample` (detected for hardware, exact for the replica);
 * later strikes are offset by the plan's known repeat spacing — the ±150 ms
 * window margin absorbs MIDI scheduling jitter. Aggregates are medians;
 * centsSpread is the max-min across strikes (per-voice tuning spread).
 */
export function measurePoint(
  x: Float32Array,
  sr: number,
  onsetSample: number,
  job: CalibJob,
): PointFeatures {
  const notes = expandNotes(job)
  const noteDur = notes[0].offSec - notes[0].onSec
  const nominal = job.features.nominalHz
  const strikes: StrikeFeatures[] = []
  const ladders: number[][] = []
  for (const n of notes) {
    const strikeOnset = onsetSample + Math.round((n.onSec - notes[0].onSec) * sr)
    if (strikeOnset >= x.length - Math.round(0.3 * sr)) break
    const m = measureStrike(x, sr, strikeOnset, noteDur, job)
    strikes.push({ f0Hz: m.f0, cents: nominal ? 1200 * Math.log2(m.f0 / nominal) : 0 })
    ladders.push(m.ladder)
  }
  const lastEnd = Math.min(x.length, onsetSample + Math.round((notes[notes.length - 1].offSec - notes[0].onSec) * sr))
  const peak = peakDbfs(x.subarray(onsetSample, lastEnd))
  const centsAll = strikes.map((s) => s.cents)
  const kMax = Math.min(...ladders.map((l) => l.length))
  const harmonicsDb = Array.from({ length: kMax }, (_, k) => median(ladders.map((l) => l[k])))
  const snapFrom = Math.min(x.length - 1, onsetSample + Math.round(0.15 * sr))
  const waveSnap = waveSnapshot(x, sr, snapFrom, strikes[0]?.f0Hz ?? nominal ?? 100)
  return {
    waveSnap,
    peakDbfs: peak,
    f0Hz: median(strikes.map((s) => s.f0Hz)),
    cents: median(centsAll),
    centsSpread: strikes.length > 1 ? Math.max(...centsAll) - Math.min(...centsAll) : 0,
    strikes,
    harmonicsDb,
  }
}
