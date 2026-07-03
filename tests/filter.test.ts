import { describe, expect, it } from 'vitest'
import { SvfFilter } from '../src/dsp/filter'
import { XD_FILTER_CFG } from '../src/synths/xd/curves'

const FS = 48000

/** Deterministic white noise in [-1, 1] (xorshift32). */
function makeNoise(seed = 0x9e3779b9): () => number {
  let s = seed >>> 0
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >> 17
    s ^= s << 5
    s >>>= 0
    return (s / 0xffffffff) * 2 - 1
  }
}

function rms(buf: Float32Array, from = 0, to = buf.length): number {
  let acc = 0
  for (let i = from; i < to; i++) acc += buf[i] * buf[i]
  return Math.sqrt(acc / (to - from))
}

function countSignChanges(buf: Float32Array, from: number, to: number): number {
  let n = 0
  let prev = buf[from]
  for (let i = from + 1; i < to; i++) {
    const cur = buf[i]
    if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) n++
    if (cur !== 0) prev = cur
  }
  return n
}

describe('XdFilter stability: noise + full cutoff sweep at all res/drive combos', () => {
  for (const res of [0, 0.5, 1.0]) {
    for (const drive of [0, 1, 2]) {
      it(`res=${res} drive=${drive}: no NaN, bounded [-3, 3]`, () => {
        const f = new SvfFilter(FS, XD_FILTER_CFG)
        f.setResonance(res)
        f.setDrive(drive)
        f.setCutoff(20)
        f.reset()
        const noise = makeNoise(123456789 + drive * 7 + res * 100)
        const n = FS // 1 second
        const logRatio = Math.log(20000 / 20)
        for (let i = 0; i < n; i++) {
          // Exponential sweep 20 Hz .. 20 kHz, setCutoff every sample.
          f.setCutoff(20 * Math.exp((logRatio * i) / n))
          const y = f.tick(noise())
          expect(Number.isFinite(y)).toBe(true)
          expect(Math.abs(y)).toBeLessThanOrEqual(3)
        }
      })
    }
  }
})

describe('XdFilter resonance', () => {
  it('impulse response at cutoff=1kHz res=0.9 rings near 1kHz', () => {
    const f = new SvfFilter(FS, XD_FILTER_CFG)
    f.setCutoff(1000)
    f.setResonance(0.9)
    f.setDrive(0)
    f.reset()
    const n = Math.floor(FS * 0.02) // 20 ms
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = f.tick(i === 0 ? 1 : 0)

    // Count sign changes over 1..11 ms: a 1 kHz ring has ~20 in 10 ms.
    const from = Math.floor(FS * 0.001)
    const to = Math.floor(FS * 0.011)
    const changes = countSignChanges(out, from, to)
    expect(changes).toBeGreaterThanOrEqual(13) // >= ~650 Hz
    expect(changes).toBeLessThanOrEqual(30) // <= ~1.5 kHz

    // Ring must actually persist: energy in 5..15 ms window is non-trivial.
    const tailRms = rms(out, Math.floor(FS * 0.005), Math.floor(FS * 0.015))
    expect(tailRms).toBeGreaterThan(1e-5)
  })

  it('res=0 impulse response does not ring', () => {
    const f = new SvfFilter(FS, XD_FILTER_CFG)
    f.setCutoff(1000)
    f.setResonance(0)
    f.setDrive(0)
    f.reset()
    const n = Math.floor(FS * 0.02)
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = f.tick(i === 0 ? 1 : 0)
    const changes = countSignChanges(out, Math.floor(FS * 0.001), Math.floor(FS * 0.011))
    expect(changes).toBeLessThanOrEqual(4)
  })
})

describe('XdFilter lowpass attenuation', () => {
  it('8kHz sine through 200Hz cutoff at res=0 is >20dB below passthrough', () => {
    const f = new SvfFilter(FS, XD_FILTER_CFG)
    f.setCutoff(200)
    f.setResonance(0)
    f.setDrive(0)
    f.reset()
    const n = FS / 10 // 100 ms
    const input = new Float32Array(n)
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      input[i] = 0.5 * Math.sin((2 * Math.PI * 8000 * i) / FS)
      out[i] = f.tick(input[i])
    }
    // Skip the first half (settling), compare steady-state RMS.
    const inRms = rms(input, n / 2)
    const outRms = rms(out, n / 2)
    const attenDb = 20 * Math.log10(outRms / inRms)
    expect(attenDb).toBeLessThan(-20)
  })

  it('passband sine passes with near-unity gain at res=0, drive=0', () => {
    const f = new SvfFilter(FS, XD_FILTER_CFG)
    f.setCutoff(2000)
    f.setResonance(0)
    f.setDrive(0)
    f.reset()
    const n = FS / 10
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = f.tick(0.25 * Math.sin((2 * Math.PI * 100 * i) / FS))
    const outRms = rms(out, n / 2)
    const inRms = 0.25 / Math.SQRT2
    const gainDb = 20 * Math.log10(outRms / inRms)
    expect(Math.abs(gainDb)).toBeLessThan(2) // within +-2 dB (tanh at 1x is subtle)
  })
})

describe('XdFilter zipper noise', () => {
  it('cutoff jump 200Hz -> 8kHz mid-render produces no discontinuity spikes', () => {
    const render = (jump: boolean): Float32Array => {
      const f = new SvfFilter(FS, XD_FILTER_CFG)
      f.setCutoff(jump ? 200 : 8000)
      f.setResonance(0.6)
      f.setDrive(0)
      f.reset()
      const n = FS / 5 // 200 ms
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        if (jump && i === n / 2) f.setCutoff(8000)
        out[i] = f.tick(0.5 * Math.sin((2 * Math.PI * 1000 * i) / FS))
      }
      return out
    }

    const jumped = render(true)
    const n = jumped.length

    // Steady-state per-sample delta of the post-jump (open-filter) signal.
    let steadyDelta = 0
    for (let i = n - 2000; i < n; i++) {
      steadyDelta = Math.max(steadyDelta, Math.abs(jumped[i] - jumped[i - 1]))
    }
    // Max delta across the whole render, including the jump region.
    let maxDelta = 0
    for (let i = 1; i < n; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(jumped[i] - jumped[i - 1]))
    }

    // A smoothed transition never moves much faster than the steady signal.
    expect(maxDelta).toBeLessThan(steadyDelta * 3 + 0.01)
    expect(maxDelta).toBeLessThan(0.2)
  })
})

describe('XdFilter robustness', () => {
  it('survives NaN/Inf input and recovers', () => {
    const f = new SvfFilter(FS, XD_FILTER_CFG)
    f.setCutoff(1000)
    f.setResonance(0.8)
    f.setDrive(2)
    f.reset()
    expect(Number.isFinite(f.tick(NaN))).toBe(true)
    expect(Number.isFinite(f.tick(Infinity))).toBe(true)
    expect(Number.isFinite(f.tick(-Infinity))).toBe(true)
    for (let i = 0; i < 1000; i++) {
      const y = f.tick(Math.sin((2 * Math.PI * 220 * i) / FS))
      expect(Number.isFinite(y)).toBe(true)
      expect(Math.abs(y)).toBeLessThanOrEqual(3)
    }
  })

  it('ignores non-finite parameter values', () => {
    const f = new SvfFilter(FS, XD_FILTER_CFG)
    f.setCutoff(NaN)
    f.setResonance(Infinity)
    f.setDrive(NaN)
    f.reset()
    for (let i = 0; i < 500; i++) {
      const y = f.tick(0.5 * Math.sin((2 * Math.PI * 440 * i) / FS))
      expect(Number.isFinite(y)).toBe(true)
    }
  })

  it('reset() clears state (silence in, silence out)', () => {
    const f = new SvfFilter(FS, XD_FILTER_CFG)
    f.setCutoff(500)
    f.setResonance(1)
    const noise = makeNoise()
    for (let i = 0; i < 2000; i++) f.tick(noise())
    f.reset()
    // First post-reset output only sees x=0 input and zeroed state.
    expect(Math.abs(f.tick(0))).toBeLessThan(1e-12)
  })

  it('decays to hard zero on silence (denormal flush)', () => {
    const f = new SvfFilter(FS, XD_FILTER_CFG)
    f.setCutoff(300)
    f.setResonance(0.9)
    f.reset()
    f.tick(1)
    let y = 1
    for (let i = 0; i < FS; i++) y = f.tick(0)
    expect(y).toBe(0)
  })
})

describe('SvfFilter 4-pole mode', () => {
  const SR = 48000

  /** RMS of a sine at freq through the filter (steady state). */
  function sineRms(f: ReturnType<typeof mk>, freq: number): number {
    let acc = 0
    const n = 4800
    for (let i = 0; i < 9600; i++) {
      const x = Math.sin((2 * Math.PI * freq * i) / SR)
      const y = f.tick(x)
      if (i >= n) acc += y * y
    }
    return Math.sqrt(acc / n)
  }

  function mk(poles: 2 | 4) {
    const f = new SvfFilter(SR, { ...XD_FILTER_CFG, poles })
    f.setCutoff(500)
    f.setResonance(0)
    f.reset()
    return f
  }

  it('rolls off ~twice as steeply as 2-pole above cutoff', () => {
    // Two octaves above cutoff: 2-pole ~ -24 dB, 4-pole ~ -48 dB.
    const r2 = sineRms(mk(2), 2000)
    const r4 = sineRms(mk(4), 2000)
    const db2 = 20 * Math.log10(r2)
    const db4 = 20 * Math.log10(r4)
    expect(db2).toBeLessThan(-18)
    expect(db2).toBeGreaterThan(-30)
    expect(db4).toBeLessThan(db2 - 15) // clearly steeper
  })

  it('passes the passband nearly identically in both modes', () => {
    const r2 = sineRms(mk(2), 50)
    const r4 = sineRms(mk(4), 50)
    expect(Math.abs(20 * Math.log10(r4 / r2))).toBeLessThan(2)
  })

  it('setPoles switches at runtime without NaN or blowup', () => {
    const f = mk(2)
    let bad = false
    for (let i = 0; i < 3 * SR; i++) {
      if (i === SR) f.setPoles(4)
      if (i === 2 * SR) f.setPoles(2)
      const y = f.tick(Math.sin((2 * Math.PI * 220 * i) / SR))
      if (!Number.isFinite(y) || Math.abs(y) > 3) bad = true
    }
    expect(bad).toBe(false)
  })

  it('resLoss ducks output level with resonance', () => {
    const lossy = new SvfFilter(SR, { ...XD_FILTER_CFG, bassComp: 0, resLoss: 0.5 })
    lossy.setCutoff(500)
    lossy.setResonance(1)
    lossy.reset()
    const clean = new SvfFilter(SR, { ...XD_FILTER_CFG, bassComp: 0, resLoss: 0 })
    clean.setCutoff(500)
    clean.setResonance(1)
    clean.reset()
    let accL = 0
    let accC = 0
    for (let i = 0; i < 9600; i++) {
      const x = Math.sin((2 * Math.PI * 100 * i) / SR)
      const yl = lossy.tick(x)
      const yc = clean.tick(x)
      if (i >= 4800) {
        accL += yl * yl
        accC += yc * yc
      }
    }
    expect(Math.sqrt(accL) / Math.sqrt(accC)).toBeLessThan(0.62) // ~ -6 dB at full res
  })
})
