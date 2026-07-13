/*
 * Envelope measurement for EG-time calibration (protocol D5): the tone-locked
 * amplitude envelope (toneEnvelope at the job's nominal f0) reduced to the one
 * segment feature the EG-time fits consume — 10-90% attack rise, log-slope
 * decay/release displayed-times, or plateau sustain level. Decay/release use
 * slope extrapolation (fit a line to the dB envelope, tau = -8.686/slope) so
 * 12+ s tails never need full captures; "displayed time" = 3*tau, matching
 * src/dsp/eg.ts (exponential segments with time-constant = displayed/3).
 * NOTE the attack segment is NOT a plain exponential there (charge toward 1.3
 * clipped at 1.0), so the raw 10-90 rise reads ln(3)/ln(13/3) ~ 0.749 of the
 * replica's displayed attack time — this module reports the raw 10-90 rise;
 * the fit layer owns the shape-dependent mapping. Pure DSP over Float32Array,
 * no node imports: hardware WAV captures and replica renders run exactly this
 * code, so extractor bias cancels in the comparison.
 */
import type { CalibJob } from './job'
import type { Track } from './features'
import { toneEnvelope } from './features'
import { peakDbfs } from './onset'

/** Which EG segment a job/point is probing (features.env in D5 job specs). */
export type EnvSegment = 'attack' | 'decay' | 'release' | 'sustain'

export interface EnvPointFeatures {
  peakDbfs: number
  /** 10%->90% rise time toward the held-region peak, from note-on (s) */
  attackSec: number | null
  /** displayed decay time = 3*tau from the post-peak dB slope (s) */
  decayTimeSec: number | null
  /** displayed release time = 3*tau from the post-note-off dB slope (s) */
  releaseTimeSec: number | null
  /**
   * Time-to-zero T of the measured fall model level = (1 - t/T)^3 — a
   * constant-rate linear phase cubed (D5 finding, 2026-07-12; p = 3.00
   * across the knob range). Cube-root domain makes this a LINEAR fit; T is
   * the full-scale fall time (rate-based, entry-level independent). The
   * value behind egDecaySec/egReleaseSec when the profile declares
   * egFallPower; the 3*tau values above remain for the legacy exponential.
   */
  fallTimeSec: number | null
  /** plateau level (median of the last 30% of the hold) re the peak (dB) */
  sustainDb: number | null
}

const WIN_SEC = 0.005 // envelope-follower Hann window
const HOP_SEC = 0.001
const FIT_GAP_SEC = 0.02 // settle after the peak / note-off before slope fits
export const FIT_FLOOR_DB = -40 // stop slope fits here (re peak): floor / silence snap
const DB_PER_TAU = 20 / Math.LN10 // ~8.686 dB amplitude drop per time constant
export const DISPLAYED_TCS = 3 // displayed time = 3 time constants (src/dsp/eg.ts)
const MIN_FIT_FRAMES = 4

/** Index of the envelope maximum among frames centered at or before tMax. */
function peakIndex(env: Track, tMax: number): number {
  let best = -1
  for (let i = 0; i < env.t.length && env.t[i] <= tMax; i++) {
    if (best < 0 || env.v[i] > env.v[best]) best = i
  }
  return best
}

/** Linear-interpolated time where the track crosses `level` between i-1 and i. */
function crossTime(env: Track, i: number, level: number): number {
  if (i <= 0) return env.t[0]
  const v0 = env.v[i - 1]
  const v1 = env.v[i]
  if (v1 === v0) return env.t[i]
  const f = (level - v0) / (v1 - v0)
  return env.t[i - 1] + (env.t[i] - env.t[i - 1]) * Math.min(1, Math.max(0, f))
}

/** 10%->90% rise time toward the held-region peak; null when unresolvable. */
function riseTime(env: Track, tHoldEnd: number): number | null {
  const iPk = peakIndex(env, tHoldEnd)
  if (iPk < 0) return null
  const ref = env.v[iPk]
  if (!(ref > 0)) return null
  const hi = 0.9 * ref
  const lo = 0.1 * ref
  let i90 = -1
  for (let i = 0; i <= iPk; i++) {
    if (env.v[i] >= hi) {
      i90 = i
      break
    }
  }
  // i90 = 0 means the rise happened before the first frame — unmeasurable
  if (i90 <= 0) return null
  let i10 = -1
  for (let i = i90 - 1; i >= 0; i--) {
    if (env.v[i] <= lo) {
      i10 = i
      break
    }
  }
  if (i10 < 0) return null
  return Math.max(0, crossTime(env, i90, hi) - crossTime(env, i10 + 1, lo))
}

/**
 * Displayed decay/release time by log-slope extrapolation: least-squares line
 * through the dB envelope from the first frame at/after tStart until it falls
 * FIT_FLOOR_DB below ref (or the track ends); tau = -8.686/slope, displayed =
 * 3*tau. When the settle gap eats the region (fast envelopes — follower-
 * limited either way) it retries from the frame right after iAfter. Null when
 * the region is degenerate or not actually decaying.
 */
function displayedTime(env: Track, iAfter: number, tStart: number, ref: number): number | null {
  const floor = ref * 10 ** (FIT_FLOOR_DB / 20)
  const fit = (i0: number): { slope: number; frames: number } | null => {
    let m = 0
    let sx = 0
    let sy = 0
    let sxx = 0
    let sxy = 0
    for (let i = i0; i < env.t.length; i++) {
      const v = env.v[i]
      if (!(v > floor)) break
      const tx = env.t[i]
      const ty = 20 * Math.log10(v)
      m++
      sx += tx
      sy += ty
      sxx += tx * tx
      sxy += tx * ty
    }
    if (m < MIN_FIT_FRAMES) return null
    const den = m * sxx - sx * sx
    if (!(den > 0)) return null
    return { slope: (m * sxy - sx * sy) / den, frames: m }
  }
  let i0 = env.t.length
  for (let i = Math.max(0, iAfter + 1); i < env.t.length; i++) {
    if (env.t[i] >= tStart) {
      i0 = i
      break
    }
  }
  let r = fit(i0)
  if ((r === null || r.frames < 8) && iAfter + 1 < i0) r = fit(iAfter + 1) ?? r
  if (r === null || !(r.slope < 0)) return null
  return (DISPLAYED_TCS * DB_PER_TAU) / -r.slope
}

/**
 * Time-to-zero T of the cubic fall model by cube-root-domain linear fit:
 * y = (v/ref)^(1/3) falls at the CONSTANT rate 1/T, so a least-squares line
 * through y(t) over the same region the log-slope fit uses gives T = -1/slope
 * — full-scale fall time, independent of the entry level. Same fallback and
 * degeneracy rules as displayedTime.
 */
function fallTime(env: Track, iAfter: number, tStart: number, ref: number): number | null {
  const floor = ref * 10 ** (FIT_FLOOR_DB / 20)
  const fit = (i0: number): { slope: number; frames: number } | null => {
    let m = 0
    let sx = 0
    let sy = 0
    let sxx = 0
    let sxy = 0
    for (let i = i0; i < env.t.length; i++) {
      const v = env.v[i]
      if (!(v > floor)) break
      const tx = env.t[i]
      const ty = Math.cbrt(v / ref)
      m++
      sx += tx
      sy += ty
      sxx += tx * tx
      sxy += tx * ty
    }
    if (m < MIN_FIT_FRAMES) return null
    const den = m * sxx - sx * sx
    if (!(den > 0)) return null
    return { slope: (m * sxy - sx * sy) / den, frames: m }
  }
  let i0 = env.t.length
  for (let i = Math.max(0, iAfter + 1); i < env.t.length; i++) {
    if (env.t[i] >= tStart) {
      i0 = i
      break
    }
  }
  let r = fit(i0)
  if ((r === null || r.frames < 8) && iAfter + 1 < i0) r = fit(iAfter + 1) ?? r
  if (r === null || !(r.slope < 0)) return null
  return 1 / -r.slope
}

/** Median of env.v over frames with center time in [t0, t1]; null when empty. */
function medianOver(env: Track, t0: number, t1: number): number | null {
  const vals: number[] = []
  for (let i = 0; i < env.t.length; i++) {
    if (env.t[i] >= t0 && env.t[i] <= t1) vals.push(env.v[i])
  }
  if (vals.length === 0) return null
  vals.sort((a, b) => a - b)
  const n = vals.length
  return n % 2 ? vals[(n - 1) >> 1] : (vals[n / 2 - 1] + vals[n / 2]) / 2
}

/**
 * Measure one EG-time point (protocol D5). Envelope jobs use a fixed note:
 * f0 = job.features.nominalHz (fallback: equal-tempered pitch of the first
 * note), note-off = onsetSample + (offSec - onSec) of the FIRST note. Only
 * the requested segment's feature is computed; the rest stay null. Fast
 * segments (< ~5 ms) are follower-limited: the 5 ms window / 1 ms hop puts a
 * ~3 ms floor under attackSec and the fitted decay/release times.
 */
export function measureEnvPoint(
  x: Float32Array,
  sr: number,
  onsetSample: number,
  job: CalibJob,
  segment: EnvSegment,
): EnvPointFeatures {
  const note = job.notes[0]
  const noteDur = note.offSec - note.onSec
  const f0 = job.features.nominalHz ?? 440 * 2 ** ((note.midi - 69) / 12)
  const win = Math.round(WIN_SEC * sr)
  const offSample = onsetSample + Math.round(noteDur * sr)
  const from = Math.max(0, onsetSample - win)
  // decay/attack/sustain only need the held region; release needs the tail too
  const to = segment === 'release' ? x.length : Math.min(x.length, offSample)
  const out: EnvPointFeatures = {
    peakDbfs: peakDbfs(x.subarray(Math.min(onsetSample, x.length))),
    attackSec: null,
    decayTimeSec: null,
    releaseTimeSec: null,
    fallTimeSec: null,
    sustainDb: null,
  }
  if (to - from <= win) return out
  const env = toneEnvelope(x, sr, f0, { winSec: WIN_SEC, hopSec: HOP_SEC, from, to })
  if (env.t.length === 0) return out
  const tOff = offSample / sr
  if (segment === 'attack') {
    out.attackSec = riseTime(env, tOff)
  } else if (segment === 'decay') {
    const iPk = peakIndex(env, tOff)
    if (iPk >= 0 && env.v[iPk] > 0) {
      out.decayTimeSec = displayedTime(env, iPk, env.t[iPk] + FIT_GAP_SEC, env.v[iPk])
      out.fallTimeSec = fallTime(env, iPk, env.t[iPk] + FIT_GAP_SEC, env.v[iPk])
    }
  } else if (segment === 'release') {
    const iPk = peakIndex(env, tOff)
    if (iPk >= 0 && env.v[iPk] > 0) {
      // frames centered before tOff + win/2 still see pre-off plateau samples;
      // iAfter = the last such frame, so even the fallback fit is clean
      let iAfter = env.t.length - 1
      for (let i = 0; i < env.t.length; i++) {
        if (env.t[i] >= tOff + WIN_SEC / 2) {
          iAfter = i - 1
          break
        }
      }
      out.releaseTimeSec = displayedTime(env, iAfter, tOff + FIT_GAP_SEC, env.v[iPk])
      out.fallTimeSec = fallTime(env, iAfter, tOff + FIT_GAP_SEC, env.v[iPk])
    }
  } else {
    const iPk = peakIndex(env, tOff)
    const med = medianOver(env, tOff - 0.3 * noteDur, tOff)
    if (iPk >= 0 && env.v[iPk] > 0 && med !== null && med > 0) {
      out.sustainDb = 20 * Math.log10(med / env.v[iPk])
    }
  }
  return out
}

export const CURVE_WIN_SEC = 0.025 // review-curve RMS follower window
export const CURVE_HOP_SEC = 0.025

export interface EnvReviewCurve {
  /** frame centers, seconds from the segment zero (note-off for release, note-on otherwise) */
  t: number[]
  /** follower level re the segment reference, dB */
  db: number[]
  /** the linear RMS reference the curve is normalized to */
  refRms: number
}

/**
 * dB-vs-time review curve for one envelope capture — the raw follower view
 * the monitor charts next to the fitted times, deliberately simpler than the
 * measurement path: plain RMS (no tone lock), 25 ms window on a 25 ms hop.
 * Time is zeroed at note-off for release and note-on otherwise. The 0 dB
 * reference is the held level over the last 0.5 s before note-off (release)
 * or the true post-onset peak of the held region (attack/decay — a fixed
 * reference window under-reads fast decays and floats their floors). Null
 * when the capture holds no reference. Pure DSP, same code for hardware
 * WAVs and replica renders.
 */
export function envReviewCurve(
  x: Float32Array,
  sr: number,
  onsetSample: number,
  job: CalibJob,
  segment: EnvSegment,
): EnvReviewCurve | null {
  const note = job.notes[0]
  const half = Math.round((CURVE_WIN_SEC / 2) * sr)
  const rmsAt = (center: number, h: number): number => {
    const a = Math.max(0, center - h)
    const b = Math.min(x.length, center + h)
    let acc = 0
    for (let k = a; k < b; k++) acc += x[k] * x[k]
    return Math.sqrt(acc / Math.max(1, b - a))
  }
  const offSample = onsetSample + Math.round((note.offSec - note.onSec) * sr)
  const zero = segment === 'release' ? offSample : onsetSample
  let ref: number
  if (segment === 'release') {
    const h = Math.round(0.25 * sr)
    ref = rmsAt(offSample - h, h)
  } else {
    ref = 0
    const hop = Math.round(0.01 * sr)
    for (let c = onsetSample; c <= Math.min(offSample, x.length); c += hop) {
      ref = Math.max(ref, rmsAt(c, half))
    }
  }
  if (!(ref > 0)) return null
  const t: number[] = []
  const db: number[] = []
  const endSec = (x.length - zero) / sr
  for (let ts = 0; ts < endSec; ts += CURVE_HOP_SEC) {
    const v = rmsAt(zero + Math.round(ts * sr), half)
    t.push(Math.round(ts * 1000) / 1000)
    db.push(Math.round(20 * Math.log10(Math.max(v, 1e-9) / ref) * 100) / 100)
  }
  return t.length ? { t, db, refRms: ref } : null
}
