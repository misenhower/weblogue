/*
 * Shared calibration feature extractors (docs/calibration-protocol.md,
 * 'Shared primitives'). The SAME code measures hardware WAV captures and
 * offline replica renders, so everything here is pure DSP over Float32Array —
 * no node imports, no fs, no process, no web APIs beyond Math.
 *
 * Conventions: `from`/`to` are SAMPLE indices; `*Sec` options are seconds;
 * Track.t holds window-CENTER times in seconds. Scratch buffers are hoisted
 * out of frame loops (repo DSP style); precision beats speed.
 */
import { fftMag } from '../../../src/dsp/fft'

export interface Track {
  t: Float32Array
  v: Float32Array
}

const TINY = 1e-30

/** Hann window (matches fftMag's n-1 convention). */
function hann(n: number): Float32Array {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
  return w
}

/** Wrap an angle to (-pi, pi]. */
function wrapPi(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI))
}

/** Largest power of two <= n (fftMag truncates to this internally). */
function pow2Below(n: number): number {
  let p = 1
  while (p * 2 <= n) p *= 2
  return p
}

/**
 * Parabolic interpolation on the LOG magnitudes of the 3 bins around peak k.
 * Returns the interpolated frequency in Hz; edge bins fall back to the raw bin.
 */
function interpBinHz(mag: Float32Array, k: number, sr: number, nfft: number): number {
  if (k < 1 || k >= mag.length - 1) return (k * sr) / nfft
  const a = Math.log(mag[k - 1] + TINY)
  const b = Math.log(mag[k] + TINY)
  const c = Math.log(mag[k + 1] + TINY)
  const den = a - 2 * b + c
  let d = den === 0 ? 0 : (0.5 * (a - c)) / den
  if (d > 0.5) d = 0.5
  else if (d < -0.5) d = -0.5
  return ((k + d) * sr) / nfft
}

/**
 * Complex Goertzel of x[from..to) at freqHz: re = s1 - s2*cos(w),
 * im = s2*sin(w); power is the same mean-square normalization as
 * tests/helpers/audio.ts goertzel() (2*|X|^2 / n^2).
 */
export function goertzelC(
  x: Float32Array,
  from: number,
  to: number,
  freqHz: number,
  sr: number,
): { re: number; im: number; power: number } {
  const n = to - from
  if (n <= 0) return { re: 0, im: 0, power: 0 }
  const w = (2 * Math.PI * freqHz) / sr
  const cw = Math.cos(w)
  const coeff = 2 * cw
  let s1 = 0
  let s2 = 0
  for (let i = from; i < to; i++) {
    const s0 = x[i] + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  const re = s1 - s2 * cw
  const im = s2 * Math.sin(w)
  return { re, im, power: (2 * (re * re + im * im)) / (n * n) }
}

/**
 * Coarse frequency estimate: Hann + fftMag over x[from..from+n), max bin,
 * parabolic interpolation on the log magnitudes of the 3 bins around it.
 * Uses the largest power of two <= n (fftMag's own truncation rule).
 */
export function fftPeakHz(x: Float32Array, from: number, n: number, sr: number): number {
  const nfft = pow2Below(Math.min(n, x.length - from))
  const mag = fftMag(x.subarray(from, from + nfft))
  let k = 1 // skip DC
  for (let i = 2; i < mag.length; i++) if (mag[i] > mag[k]) k = i
  return interpBinHz(mag, k, sr, nfft)
}

/**
 * Phase tracker (shared primitive 1): Hann-windowed complex Goertzel at
 * nominalHz per frame; instantaneous frequency from the unwrapped phase
 * difference between consecutive frames, f = nominal + dphi/(2*pi*hop).
 * Valid while |f - nominal| < 1/(2*hop); coarse-lock with fftPeakHz first
 * when the true frequency may sit further out. v[0] repeats the first
 * differenced estimate (nominalHz when only one frame fits).
 */
export function phasePitchTrack(
  x: Float32Array,
  sr: number,
  nominalHz: number,
  opts?: { winSec?: number; hopSec?: number; from?: number; to?: number },
): Track {
  const winSec = opts?.winSec ?? 0.046
  const hopSec = opts?.hopSec ?? 0.005
  const from = opts?.from ?? 0
  const to = opts?.to ?? x.length
  const win = Math.max(2, Math.round(winSec * sr))
  const hop = Math.max(1, Math.round(hopSec * sr))
  const frames = Math.floor((to - from - win) / hop) + 1
  if (frames < 1) return { t: new Float32Array(0), v: new Float32Array(0) }
  const t = new Float32Array(frames)
  const v = new Float32Array(frames)
  const w = hann(win)
  const buf = new Float32Array(win)
  const hopSecActual = hop / sr
  const hopPhase = wrapPi(((2 * Math.PI * nominalHz) / sr) * hop)
  let prev = 0
  for (let f = 0; f < frames; f++) {
    const start = from + f * hop
    for (let i = 0; i < win; i++) buf[i] = x[start + i] * w[i]
    const g = goertzelC(buf, 0, win, nominalHz, sr)
    const ph = Math.atan2(g.im, g.re)
    t[f] = (start + win / 2) / sr
    if (f > 0) v[f] = nominalHz + wrapPi(ph - prev - hopPhase) / (2 * Math.PI * hopSecActual)
    prev = ph
  }
  v[0] = frames > 1 ? v[1] : nominalHz
  return { t, v }
}

/**
 * Harmonic ladder (shared primitive 3): Hann-windowed Goertzel power at k*f0,
 * k = 1..min(kMax ?? 32, floor(20 kHz / f0)), averaged over five consecutive
 * 100 ms windows starting at `from`; dB relative to k=1. Re-estimate f0 with
 * phasePitchTrack per capture before calling — 3 cents of drift at k=32 is a
 * whole bin.
 */
export function harmonicLadder(
  x: Float32Array,
  sr: number,
  from: number,
  f0: number,
  kMax?: number,
): { k: number; db: number }[] {
  const kTop = Math.max(1, Math.min(kMax ?? 32, Math.floor(20000 / f0)))
  const win = Math.round(0.1 * sr)
  const w = hann(win)
  const buf = new Float32Array(win)
  const pw = new Float64Array(kTop)
  let count = 0
  for (let j = 0; j < 5; j++) {
    const start = from + j * win
    if (start + win > x.length) break
    for (let i = 0; i < win; i++) buf[i] = x[start + i] * w[i]
    for (let k = 1; k <= kTop; k++) pw[k - 1] += goertzelC(buf, 0, win, k * f0, sr).power
    count++
  }
  const p1 = count > 0 ? pw[0] / count : 0
  const out: { k: number; db: number }[] = []
  for (let k = 1; k <= kTop; k++) {
    const p = count > 0 ? pw[k - 1] / count : 0
    out.push({ k, db: 10 * Math.log10((p + TINY) / (p1 + TINY)) })
  }
  return out
}

/**
 * Sweep tracker (shared primitive 2): STFT ridge — per frame Hann + fftMag,
 * strongest bin restricted to [fMin, fMax], parabolic interpolation -> Hz.
 * Follows glides and large pitch modulations the single-bin tracker can't.
 */
export function stftRidge(
  x: Float32Array,
  sr: number,
  opts: { fMin: number; fMax: number; from?: number; to?: number; nfft?: number; hop?: number },
): Track {
  const nfft = pow2Below(opts.nfft ?? 2048)
  const hop = Math.max(1, opts.hop ?? 256)
  const from = opts.from ?? 0
  const to = opts.to ?? x.length
  const frames = Math.floor((to - from - nfft) / hop) + 1
  if (frames < 1) return { t: new Float32Array(0), v: new Float32Array(0) }
  const kLo = Math.max(1, Math.ceil((opts.fMin * nfft) / sr))
  const kHi = Math.max(kLo, Math.min(nfft / 2 - 2, Math.floor((opts.fMax * nfft) / sr)))
  const t = new Float32Array(frames)
  const v = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    const start = from + f * hop
    const mag = fftMag(x.subarray(start, start + nfft))
    let k = kLo
    for (let i = kLo + 1; i <= kHi; i++) if (mag[i] > mag[k]) k = i
    t[f] = (start + nfft / 2) / sr
    v[f] = interpBinHz(mag, k, sr, nfft)
  }
  return { t, v }
}

/**
 * Welch PSD (shared primitive 4): Hann segments, 50% overlap, mean of |X|^2
 * -> dB (10*log10). Divide a filtered capture's PSD by a reference capture's
 * to get |H(f)|^2. Magnitudes carry fftMag's normalization; the reference
 * division cancels it.
 */
export function welchPsd(
  x: Float32Array,
  sr: number,
  opts?: { nfft?: number; from?: number; to?: number },
): { hz: Float32Array; db: Float32Array } {
  const from = opts?.from ?? 0
  const to = opts?.to ?? x.length
  const avail = to - from
  if (avail < 2) return { hz: new Float32Array(0), db: new Float32Array(0) }
  const nfft = pow2Below(Math.min(opts?.nfft ?? 8192, avail))
  const hop = Math.max(1, nfft / 2)
  const acc = new Float64Array(nfft / 2)
  let segs = 0
  for (let start = from; start + nfft <= to; start += hop) {
    const mag = fftMag(x.subarray(start, start + nfft))
    for (let i = 0; i < acc.length; i++) acc[i] += mag[i] * mag[i]
    segs++
  }
  const hz = new Float32Array(nfft / 2)
  const db = new Float32Array(nfft / 2)
  for (let i = 0; i < hz.length; i++) {
    hz[i] = (i * sr) / nfft
    db[i] = 10 * Math.log10(acc[i] / Math.max(1, segs) + TINY)
  }
  return { hz, db }
}

/**
 * Tone envelope (shared primitive 5): complex-Goertzel magnitude at f0 per
 * Hann frame — a tone-locked amplitude envelope immune to broadband noise.
 * sqrt(power) scaled by the window's coherent gain so v is the tone's PEAK
 * amplitude (a sine of amplitude A reads ~A).
 */
export function toneEnvelope(
  x: Float32Array,
  sr: number,
  f0: number,
  opts?: { winSec?: number; hopSec?: number; from?: number; to?: number },
): Track {
  const winSec = opts?.winSec ?? 0.005
  const hopSec = opts?.hopSec ?? 0.001
  const from = opts?.from ?? 0
  const to = opts?.to ?? x.length
  const win = Math.max(2, Math.round(winSec * sr))
  const hop = Math.max(1, Math.round(hopSec * sr))
  const frames = Math.floor((to - from - win) / hop) + 1
  if (frames < 1) return { t: new Float32Array(0), v: new Float32Array(0) }
  const w = hann(win)
  let wsum = 0
  for (let i = 0; i < win; i++) wsum += w[i]
  const buf = new Float32Array(win)
  const t = new Float32Array(frames)
  const v = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    const start = from + f * hop
    for (let i = 0; i < win; i++) buf[i] = x[start + i] * w[i]
    const g = goertzelC(buf, 0, win, f0, sr)
    t[f] = (start + win / 2) / sr
    v[f] = (2 * Math.sqrt(g.re * g.re + g.im * g.im)) / wsum
  }
  return { t, v }
}

/** Plain rectangular RMS frames (shared primitive 5, broadband stimuli). */
export function rmsTrack(
  x: Float32Array,
  sr: number,
  opts?: { winSec?: number; hopSec?: number; from?: number; to?: number },
): Track {
  const winSec = opts?.winSec ?? 0.002
  const hopSec = opts?.hopSec ?? 0.001
  const from = opts?.from ?? 0
  const to = opts?.to ?? x.length
  const win = Math.max(1, Math.round(winSec * sr))
  const hop = Math.max(1, Math.round(hopSec * sr))
  const frames = Math.floor((to - from - win) / hop) + 1
  if (frames < 1) return { t: new Float32Array(0), v: new Float32Array(0) }
  const t = new Float32Array(frames)
  const v = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    const start = from + f * hop
    let acc = 0
    for (let i = start; i < start + win; i++) acc += x[i] * x[i]
    t[f] = (start + win / 2) / sr
    v[f] = Math.sqrt(acc / win)
  }
  return { t, v }
}

/**
 * Energy decay curve (shared primitive 6): Schroeder backward integration of
 * x^2 -> dB, least-squares line over the -5..-35 dB span -> T30, rt60 = 2*T30,
 * r2 of the fit (Pearson). Returns null when the span doesn't exist or the
 * fit is degenerate (no decay).
 */
export function schroederRt60(
  x: Float32Array,
  sr: number,
  from = 0,
): { rt60: number; r2: number } | null {
  const n = x.length - from
  if (n < 2) return null
  const edc = new Float64Array(n)
  let acc = 0
  for (let i = n - 1; i >= 0; i--) {
    const s = x[from + i]
    acc += s * s
    edc[i] = acc
  }
  const e0 = edc[0]
  if (!(e0 > 0)) return null
  const th5 = e0 * 10 ** -0.5
  const th35 = e0 * 10 ** -3.5
  let i5 = -1
  let i35 = -1
  for (let i = 0; i < n; i++) {
    if (i5 < 0 && edc[i] <= th5) i5 = i
    if (edc[i] <= th35) {
      i35 = i
      break
    }
  }
  while (i35 > i5 && edc[i35] <= 0) i35-- // exact-zero tail would break the log
  if (i5 < 0 || i35 < 0 || i35 - i5 < 2) return null
  const m = i35 - i5 + 1
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (let i = i5; i <= i35; i++) {
    const tx = i / sr
    const ty = 10 * Math.log10(edc[i] / e0)
    sx += tx
    sy += ty
    sxx += tx * tx
    sxy += tx * ty
    syy += ty * ty
  }
  const dx = m * sxx - sx * sx
  const dy = m * syy - sy * sy
  if (dx <= 0 || dy <= 0) return null
  const slope = (m * sxy - sx * sy) / dx
  if (!(slope < 0)) return null
  const r = (m * sxy - sx * sy) / Math.sqrt(dx * dy)
  return { rt60: 2 * (-30 / slope), r2: r * r }
}
