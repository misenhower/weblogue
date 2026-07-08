/*
 * Point measurement shared by the hardware and replica paths: given samples,
 * an onset, and the job's note plan, extract the M2 feature set (peak level,
 * f0 via FFT coarse + phase-tracker fine, harmonic ladder). Both worlds run
 * exactly this code, so extractor bias cancels in the comparison.
 */
import type { CalibJob } from './job'
import { expandNotes } from './job'
import { fftPeakHz, phasePitchTrack, harmonicLadder } from './features'
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
  const coarse = fftPeakHz(x, from, Math.min(16384, to - from), sr)
  const seed = job.features.nominalHz ?? coarse
  // trust the coarse FFT unless it's wildly off the nominal (harmonic grab)
  const nominal = Math.abs(1200 * Math.log2(coarse / seed)) < 300 ? coarse : seed
  const track = phasePitchTrack(x, sr, nominal, { from, to })
  const f0 = median(Array.from(track.v))
  const ladder = harmonicLadder(x, sr, from, f0, job.features.harmonics ?? 8)
  return { f0, ladder: ladder.map((h) => h.db) }
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
  return {
    peakDbfs: peak,
    f0Hz: median(strikes.map((s) => s.f0Hz)),
    cents: median(centsAll),
    centsSpread: strikes.length > 1 ? Math.max(...centsAll) - Math.min(...centsAll) : 0,
    strikes,
    harmonicsDb,
  }
}
