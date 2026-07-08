import { describe, expect, it } from 'vitest'
import {
  fftPeakHz,
  goertzelC,
  harmonicLadder,
  phasePitchTrack,
  rmsTrack,
  schroederRt60,
  stftRidge,
  toneEnvelope,
  welchPsd,
} from '../tools/calib/lib/features'
import { goertzel } from './helpers/audio'

const SR = 48000

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

function sine(freq: number, seconds: number, amp = 1, phase = 0): Float32Array {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  const w = (2 * Math.PI * freq) / SR
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(w * i + phase)
  return out
}

function median(a: ArrayLike<number>, from = 0): number {
  const s: number[] = []
  for (let i = from; i < a.length; i++) s.push(a[i])
  s.sort((p, q) => p - q)
  return s[Math.floor(s.length / 2)]
}

const cents = (a: number, b: number) => 1200 * Math.log2(a / b)

// -----------------------------------------------------------------------------

describe('goertzelC', () => {
  it('matches the real goertzel power and reports a sane phase', () => {
    const n = 4800 // 100 cycles of 1 kHz — exact-bin
    const x = new Float32Array(n)
    const w = (2 * Math.PI * 1000) / SR
    for (let i = 0; i < n; i++) x[i] = 0.5 * Math.cos(w * i)
    const g = goertzelC(x, 0, n, 1000, SR)
    expect(g.power).toBeCloseTo(goertzel(x, 1000, 0, n, SR), 12)
    expect(g.power).toBeCloseTo(0.125, 6) // A^2/2
    // The re/im convention evaluates X(k)*e^(jw(N-1)) = -w mod 2pi for this
    // exact-bin cosine; the constant offset cancels in the frame-to-frame
    // phase differences the tracker uses.
    expect(Math.abs(Math.atan2(g.im, g.re) + w)).toBeLessThan(1e-3)
  })
})

describe('fftPeakHz', () => {
  it('resolves an off-bin sine within 1 Hz (n=8192)', () => {
    const x = sine(1234.5, 0.2)
    expect(Math.abs(fftPeakHz(x, 0, 8192, SR) - 1234.5)).toBeLessThan(1)
  })
})

describe('phasePitchTrack', () => {
  it('tracks a 440.37 Hz sine within 0.05 cents seeded at nominal 440', () => {
    const x = sine(440.37, 1)
    const tr = phasePitchTrack(x, SR, 440)
    expect(tr.t[0]).toBeCloseTo(0.046 / 2, 3) // window-center times
    const f = median(tr.v, 3)
    expect(Math.abs(cents(f, 440.37))).toBeLessThan(0.05)
  })

  it('tracks the 4th harmonic (1761.48 Hz) directly for extra resolution', () => {
    const n = SR
    const x = new Float32Array(n)
    const w1 = (2 * Math.PI * 440.37) / SR
    for (let i = 0; i < n; i++) x[i] = Math.sin(w1 * i) + 0.5 * Math.sin(4 * w1 * i + 0.3)
    const tr = phasePitchTrack(x, SR, 1760)
    const f = median(tr.v, 3)
    expect(Math.abs(cents(f, 4 * 440.37))).toBeLessThan(0.05)
  })
})

describe('harmonicLadder', () => {
  it('recovers h1/h2/h3 at 0/-12/-30 dB within 0.3 dB (f0 220)', () => {
    const n = Math.round(0.6 * SR)
    const x = new Float32Array(n)
    const w = (2 * Math.PI * 220) / SR
    const a2 = 10 ** (-12 / 20)
    const a3 = 10 ** (-30 / 20)
    for (let i = 0; i < n; i++) {
      x[i] = Math.sin(w * i) + a2 * Math.sin(2 * w * i + 1.1) + a3 * Math.sin(3 * w * i + 2.2)
    }
    const lad = harmonicLadder(x, SR, 0, 220, 8)
    expect(lad.length).toBe(8)
    expect(lad[0].k).toBe(1)
    expect(Math.abs(lad[0].db)).toBeLessThan(0.01)
    expect(Math.abs(lad[1].db - -12)).toBeLessThan(0.3)
    expect(Math.abs(lad[2].db - -30)).toBeLessThan(0.3)
    expect(lad[7].db).toBeLessThan(-60) // absent harmonics are dark
  })

  it('clamps k to floor(20 kHz / f0)', () => {
    const x = sine(900, 0.6)
    expect(harmonicLadder(x, SR, 0, 900).length).toBe(Math.floor(20000 / 900))
  })
})

describe('stftRidge', () => {
  it('tracks a 200->400 Hz linear chirp within 2% at mid-sweep', () => {
    const T = 2
    const n = T * SR
    const x = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const t = i / SR
      x[i] = Math.sin(2 * Math.PI * (200 * t + ((400 - 200) * t * t) / (2 * T)))
    }
    const tr = stftRidge(x, SR, { fMin: 100, fMax: 600 })
    let mid = 0
    for (let i = 1; i < tr.t.length; i++) {
      if (Math.abs(tr.t[i] - 1) < Math.abs(tr.t[mid] - 1)) mid = i
    }
    expect(Math.abs(tr.v[mid] - 300)).toBeLessThan(300 * 0.02)
  })
})

describe('welchPsd', () => {
  it('is flat within a few dB across 1-20 kHz for white noise', () => {
    const rng = makeRng(0xc0ffee)
    const x = new Float32Array(4 * SR)
    for (let i = 0; i < x.length; i++) x[i] = rng() * 2 - 1
    const { hz, db } = welchPsd(x, SR)
    const bandDb = (lo: number, hi: number) => {
      let acc = 0
      let m = 0
      for (let i = 0; i < hz.length; i++) {
        if (hz[i] >= lo && hz[i] < hi) {
          acc += 10 ** (db[i] / 10)
          m++
        }
      }
      return 10 * Math.log10(acc / m)
    }
    const b1 = bandDb(1000, 5000)
    const b2 = bandDb(5000, 10000)
    const b3 = bandDb(10000, 20000)
    expect(Math.abs(b1 - b2)).toBeLessThan(3)
    expect(Math.abs(b2 - b3)).toBeLessThan(3)
    expect(Math.abs(b1 - b3)).toBeLessThan(3)
  })

  it('peaks at the right bin for a sine', () => {
    const bin = 200
    const f = (bin * SR) / 8192
    const { hz, db } = welchPsd(sine(f, 1), SR)
    let peak = 1
    for (let i = 2; i < db.length; i++) if (db[i] > db[peak]) peak = i
    expect(peak).toBe(bin)
    expect(hz[peak]).toBeCloseTo(f, 6)
  })
})

describe('toneEnvelope', () => {
  it('reflects a 0.2 -> 0.8 amplitude step within 10 ms', () => {
    const n = SR
    const x = new Float32Array(n)
    const w = (2 * Math.PI * 1000) / SR
    const stepAt = Math.round(0.5 * SR)
    for (let i = 0; i < n; i++) x[i] = (i < stepAt ? 0.2 : 0.8) * Math.sin(w * i)
    const env = toneEnvelope(x, SR, 1000)
    let tCross = NaN
    for (let i = 0; i < env.v.length; i++) {
      if (env.v[i] >= 0.5) {
        tCross = env.t[i]
        break
      }
    }
    expect(Math.abs(tCross - 0.5)).toBeLessThan(0.01)
    // Plateaus read the tone's peak amplitude.
    const plateau = (lo: number, hi: number) => {
      let acc = 0
      let m = 0
      for (let i = 0; i < env.t.length; i++) {
        if (env.t[i] >= lo && env.t[i] < hi) {
          acc += env.v[i]
          m++
        }
      }
      return acc / m
    }
    expect(plateau(0.3, 0.45)).toBeCloseTo(0.2, 2)
    expect(plateau(0.55, 0.7)).toBeCloseTo(0.8, 2)
  })
})

describe('rmsTrack', () => {
  it('reads amp/sqrt(2) within 2% on a constant-amplitude sine', () => {
    const tr = rmsTrack(sine(1000, 0.5, 0.6), SR)
    const want = 0.6 / Math.SQRT2
    expect(Math.abs(median(tr.v) - want) / want).toBeLessThan(0.02)
  })
})

describe('schroederRt60', () => {
  it('recovers RT60 = 1.2 s within 8% with r2 > 0.99', () => {
    const rt60 = 1.2
    const tau = ((20 / Math.log(10)) * rt60) / 60 // amp e^(-t/tau) -> 60 dB energy drop at rt60
    const n = Math.round(2.5 * SR)
    const x = new Float32Array(n)
    const w = (2 * Math.PI * 500) / SR
    for (let i = 0; i < n; i++) {
      const t = i / SR
      x[i] = Math.exp(-t / tau) * Math.sin(w * i)
    }
    const r = schroederRt60(x, SR)
    expect(r).not.toBeNull()
    expect(Math.abs(r!.rt60 - rt60) / rt60).toBeLessThan(0.08)
    expect(r!.r2).toBeGreaterThan(0.99)
  })

  it('handles an all-constant signal gracefully', () => {
    const x = new Float32Array(SR).fill(0.5)
    let r: { rt60: number; r2: number } | null = null
    expect(() => {
      r = schroederRt60(x, SR)
    }).not.toThrow()
    if (r !== null) {
      expect(Number.isFinite((r as { rt60: number }).rt60)).toBe(true)
    }
    expect(schroederRt60(new Float32Array(64), SR)).toBeNull() // silence -> null
  })
})
