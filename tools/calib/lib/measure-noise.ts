/*
 * Noise-capture measurement path for filter-domain calibration (protocol D4,
 * feature M3): broadband NOISE through the VCF. measureNoisePoint takes the
 * Welch PSD (8192-pt Hann, 50 % overlap) of the first note's sustain window
 * (measure.ts convention) and reduces it to a FIXED 256-bin log-spaced grid,
 * 20 Hz..20 kHz — identical for every capture — so transferDb (filtered
 * capture vs unfiltered reference) is a plain per-bin dB subtraction that
 * yields |H(f)|² with the noise source's own coloration and the capture
 * chain cancelled. corner3Db reads the −3 dB point off that transfer;
 * fitLpMag fits an n-pole lowpass magnitude for corners near or beyond the
 * band edge. Grid reduction takes the MEAN of the linear FFT-bin powers in
 * each grid bin (it keeps shrinking the Welch variance; a max would ride the
 * noise peaks); LF grid bins narrower than the FFT spacing are filled by
 * linear interpolation of the dB PSD at the bin center.
 *
 * Pure math over Float32Array — the same code measures hardware WAV captures
 * and offline replica renders. No node imports.
 */
import type { CalibJob } from './job'
import { welchPsd } from './features'
import { peakDbfs } from './onset'
import { median } from './fit'

export interface NoisePointFeatures {
  peakDbfs: number
  rmsDb: number
  /** fixed log grid, 256 bin-center frequencies from 20 Hz to 20 kHz */
  psdHz: number[]
  /** Welch PSD in dB per grid bin (welchPsd normalization; cancels in transferDb) */
  psdDb: number[]
  /**
   * Per-strike PSDs on the same grid, present when the job repeats the note
   * (round-robin: strike k lands on a different voice, so per-strike
   * transfers measure each analog VCF separately — keep `repeat` a multiple
   * of 4 so strike k pairs with the same voice at every sweep point).
   * psdDb above stays the FIRST strike's PSD for single-strike compatibility.
   */
  strikePsdDb?: number[][]
}

const TINY = 1e-30
const GRID_BINS = 256
const GRID_LO_HZ = 20
const GRID_HI_HZ = 20000
const GRID_LOG_RATIO = Math.log(GRID_HI_HZ / GRID_LO_HZ)
/** Bins below the audio interface's LF corner carry coupling-cap rolloff, not VCF. */
const IN_BAND_LO_HZ = 30
/** Grid bins whose median defines the transfer's low-frequency plateau. */
const PLATEAU_BINS = 20
/**
 * fitLpMag only fits bins within this many dB of the plateau: deeper stopband
 * bins ride the capture chain's noise floor (hardware) or the test filter's
 * Nyquist-region departure from the analog magnitude model (synthetic), and
 * would bias fc while carrying almost no corner information.
 */
const FIT_RANGE_DB = 20

/** The fixed grid's bin-center frequencies (geometric centers of log-spaced edges). */
function gridCenters(): number[] {
  const c = new Array<number>(GRID_BINS)
  for (let i = 0; i < GRID_BINS; i++) {
    c[i] = GRID_LO_HZ * Math.exp((GRID_LOG_RATIO * (i + 0.5)) / GRID_BINS)
  }
  return c
}

/** Reduce a welchPsd result onto the fixed log grid (see header). */
function reduceToGrid(hz: Float32Array, db: Float32Array): { psdHz: number[]; psdDb: number[] } {
  const psdHz = gridCenters()
  const psdDb = new Array<number>(GRID_BINS)
  const acc = new Float64Array(GRID_BINS)
  const cnt = new Int32Array(GRID_BINS)
  for (let j = 0; j < hz.length; j++) {
    const f = hz[j]
    if (f < GRID_LO_HZ || f >= GRID_HI_HZ) continue
    const b = Math.min(GRID_BINS - 1, Math.floor((GRID_BINS * Math.log(f / GRID_LO_HZ)) / GRID_LOG_RATIO))
    acc[b] += 10 ** (db[j] / 10)
    cnt[b]++
  }
  const binHz = hz.length > 1 ? hz[1] : 0
  for (let b = 0; b < GRID_BINS; b++) {
    if (cnt[b] > 0) {
      psdDb[b] = 10 * Math.log10(acc[b] / cnt[b] + TINY)
    } else if (binHz > 0) {
      // grid bin narrower than the FFT spacing: sample the PSD at the center
      const pos = Math.min(hz.length - 1.000001, Math.max(0, psdHz[b] / binHz))
      const j = Math.floor(pos)
      psdDb[b] = db[j] + (pos - j) * (db[j + 1] - db[j])
    } else {
      psdDb[b] = 10 * Math.log10(TINY) // degenerate capture (window too short)
    }
  }
  return { psdHz, psdDb }
}

/** One strike's grid PSD over its sustain window (measure.ts convention:
 *  strike onset + 150 ms past attack/settling, to onset + noteDur − 100 ms,
 *  at least 300 ms). */
function strikeGridPsd(
  x: Float32Array,
  sr: number,
  strikeOnset: number,
  noteDur: number,
): { psdHz: number[]; psdDb: number[]; from: number; to: number } {
  const from = Math.min(x.length - 1, strikeOnset + Math.round(0.15 * sr))
  const to = Math.min(
    x.length,
    Math.max(from + Math.round(0.3 * sr), strikeOnset + Math.round((noteDur - 0.1) * sr)),
  )
  const psd = welchPsd(x, sr, { from, to })
  return { ...reduceToGrid(psd.hz, psd.db), from, to }
}

/**
 * Noise-point features. psdDb / peak / rms cover the FIRST note's sustain
 * window; when the job repeats the note, strikePsdDb additionally carries one
 * grid PSD per strike (offsets from the detected onset by repeatEverySec, the
 * same convention measure.ts uses for tonal strikes).
 */
export function measureNoisePoint(
  x: Float32Array,
  sr: number,
  onsetSample: number,
  job: CalibJob,
): NoisePointFeatures {
  const noteDur = job.notes[0].offSec - job.notes[0].onSec
  const first = strikeGridPsd(x, sr, onsetSample, noteDur)
  const { from, to } = first
  let acc = 0
  for (let i = from; i < to; i++) acc += x[i] * x[i]
  const f: NoisePointFeatures = {
    peakDbfs: peakDbfs(x.subarray(from, to)),
    rmsDb: 10 * Math.log10(acc / Math.max(1, to - from) + TINY),
    psdHz: first.psdHz,
    psdDb: first.psdDb,
  }
  const reps = job.repeat ?? 1
  if (reps > 1 && job.repeatEverySec) {
    f.strikePsdDb = [first.psdDb]
    for (let k = 1; k < reps; k++) {
      const strikeOnset = onsetSample + Math.round(k * job.repeatEverySec * sr)
      if (strikeOnset >= x.length) break // truncated capture: keep what landed
      f.strikePsdDb.push(strikeGridPsd(x, sr, strikeOnset, noteDur).psdDb)
    }
  }
  return f
}

/**
 * PSD transfer in dB: filtered point over unfiltered reference, per grid bin
 * (10*log10|H(f)|²). Both captures share the fixed grid, so this is a plain
 * subtraction — the source spectrum, capture chain, and welchPsd
 * normalization all cancel.
 */
export function transferDb(point: NoisePointFeatures, ref: NoisePointFeatures): number[] {
  return point.psdDb.map((d, i) => d - ref.psdDb[i])
}

/**
 * −3 dB corner of a transfer: plateau = median of the lowest PLATEAU_BINS
 * in-band bins (>= 30 Hz — below that the interface LF corner intrudes),
 * then the first bin pair bracketing plateau − 3 dB, log-interpolated in
 * frequency. Null when the transfer never crosses in-band (corner at or
 * beyond the band edge — fall back to fitLpMag).
 */
export function corner3Db(hz: number[], transfer: number[]): number | null {
  let start = -1
  for (let i = 0; i < hz.length; i++) {
    if (hz[i] >= IN_BAND_LO_HZ) {
      start = i
      break
    }
  }
  if (start < 0) return null
  const plateauVals: number[] = []
  for (let i = start; i < Math.min(hz.length, start + PLATEAU_BINS); i++) {
    if (Number.isFinite(transfer[i])) plateauVals.push(transfer[i])
  }
  if (plateauVals.length === 0) return null
  const thr = median(plateauVals) - 3
  for (let i = start + 1; i < hz.length; i++) {
    const a = transfer[i - 1]
    const b = transfer[i]
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    if (a >= thr && b < thr) {
      const t = (thr - a) / (b - a)
      return Math.exp(Math.log(hz[i - 1]) + t * Math.log(hz[i] / hz[i - 1]))
    }
  }
  return null
}

/**
 * Least-squares fit of an n-pole lowpass magnitude gain/sqrt(1 + (f/fc)^(2n))
 * to a transfer, in the dB domain over the in-band grid (>= 30 Hz, matching
 * corner3Db) restricted to bins within FIT_RANGE_DB of the plateau (see the
 * constant's note). The dB gain is closed-form for a given fc (mean
 * residual), so the search is 1-D on log(fc): a 64-step coarse scan over
 * 10 Hz..80 kHz (beyond-band corners fit the visible rolloff, reported
 * lower-bounded per protocol D4) then golden-section refinement of the
 * bracketing interval. r2 is the coefficient of determination in dB over the
 * fitted bins. poles defaults to 2 (12 dB/oct, the xd VCF).
 */
export function fitLpMag(
  hz: number[],
  transfer: number[],
  poles = 2,
): { fcHz: number; r2: number } {
  const inBand: { f: number; y: number }[] = []
  for (let i = 0; i < hz.length; i++) {
    if (hz[i] >= IN_BAND_LO_HZ && Number.isFinite(transfer[i])) {
      inBand.push({ f: hz[i], y: transfer[i] })
    }
  }
  const plateau = median(inBand.slice(0, PLATEAU_BINS).map((p) => p.y))
  const fs: number[] = []
  const ys: number[] = []
  for (const p of inBand) {
    if (p.y >= plateau - FIT_RANGE_DB) {
      fs.push(p.f)
      ys.push(p.y)
    }
  }
  if (fs.length < 3) return { fcHz: NaN, r2: NaN }
  const p2 = 2 * Math.max(1, Math.round(poles))
  const model = new Float64Array(fs.length)
  const sse = (logFc: number): number => {
    const fc = Math.exp(logFc)
    let gainDb = 0
    for (let i = 0; i < fs.length; i++) {
      model[i] = -10 * Math.log10(1 + (fs[i] / fc) ** p2)
      gainDb += ys[i] - model[i]
    }
    gainDb /= fs.length
    let acc = 0
    for (let i = 0; i < fs.length; i++) {
      const e = ys[i] - gainDb - model[i]
      acc += e * e
    }
    return acc
  }
  const logLo = Math.log(10)
  const logHi = Math.log(80000)
  const steps = 64
  let bestK = 0
  let bestV = Infinity
  for (let k = 0; k <= steps; k++) {
    const v = sse(logLo + ((logHi - logLo) * k) / steps)
    if (v < bestV) {
      bestV = v
      bestK = k
    }
  }
  let a = logLo + ((logHi - logLo) * Math.max(0, bestK - 1)) / steps
  let b = logLo + ((logHi - logLo) * Math.min(steps, bestK + 1)) / steps
  const gr = (Math.sqrt(5) - 1) / 2
  let c = b - gr * (b - a)
  let d = a + gr * (b - a)
  let vc = sse(c)
  let vd = sse(d)
  while (b - a > 1e-4) {
    if (vc < vd) {
      b = d
      d = c
      vd = vc
      c = b - gr * (b - a)
      vc = sse(c)
    } else {
      a = c
      c = d
      vc = vd
      d = a + gr * (b - a)
      vd = sse(d)
    }
  }
  const logFc = (a + b) / 2
  const best = sse(logFc)
  let mean = 0
  for (const y of ys) mean += y
  mean /= ys.length
  let sst = 0
  for (const y of ys) sst += (y - mean) * (y - mean)
  // Degenerate SStot (constant transfer): perfect fit counts as 1, else 0.
  const r2 = sst > 0 ? 1 - best / sst : best === 0 ? 1 : 0
  return { fcHz: Math.exp(logFc), r2 }
}
