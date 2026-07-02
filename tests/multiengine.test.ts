import { describe, expect, it } from 'vitest'
import {
  MULTI_TYPE,
  MultiEngine,
  NOISE_TYPE,
  USER_OSC_NAMES,
  VPM_TYPE,
  type VpmTrims,
} from '../src/dsp/multiengine'

const SR = 48000

function makeEngine(
  type: number,
  sub: number,
  freq: number,
  shape = 0.5,
  shift = 0.5,
): MultiEngine {
  const e = new MultiEngine(SR)
  e.setType(type)
  e.setSubType(sub)
  e.setShape(shape)
  e.setShiftShape(shift)
  e.setFreq(freq)
  e.noteOn()
  return e
}

function render(e: MultiEngine, seconds = 0.5): Float32Array {
  const n = Math.floor(SR * seconds)
  const buf = new Float32Array(n)
  for (let i = 0; i < n; i++) buf[i] = e.tick()
  return buf
}

interface Stats {
  finite: boolean
  maxAbs: number
  rms: number
}

function stats(buf: Float32Array): Stats {
  let finite = true
  let maxAbs = 0
  let sum = 0
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i]
    if (!Number.isFinite(v)) finite = false
    const a = Math.abs(v)
    if (a > maxAbs) maxAbs = a
    sum += v * v
  }
  return { finite, maxAbs, rms: Math.sqrt(sum / buf.length) }
}

/** Zero crossings after a settle period — proxy for dominant frequency. */
function zeroCrossings(buf: Float32Array, skip = 4800): number {
  let count = 0
  let prev = 0
  for (let i = skip; i < buf.length; i++) {
    const v = buf[i]
    if (Math.abs(v) < 1e-4) continue
    const s = v > 0 ? 1 : -1
    if (prev !== 0 && s !== prev) count++
    prev = s
  }
  return count
}

/** Mean |first difference| — proxy for high-frequency energy / brightness. */
function meanAbsDiff(buf: Float32Array, from: number, to: number): number {
  let sum = 0
  for (let i = from + 1; i < to; i++) sum += Math.abs(buf[i] - buf[i - 1])
  return sum / (to - from - 1)
}

/** Normalized brightness: mean |diff| over RMS (spectral tilt proxy). */
function brightness(buf: Float32Array, skip = 4800): number {
  const st = stats(buf.subarray(skip))
  return meanAbsDiff(buf, skip, buf.length) / Math.max(1e-9, st.rms)
}

/** RMS of the sub-fcHz band (two cascaded one-pole lowpasses, offline). */
function lowBandRms(buf: Float32Array, fcHz: number, skip = 4800): number {
  const a = 1 - Math.exp((-2 * Math.PI * fcHz) / SR)
  let lp1 = 0
  let lp2 = 0
  let sum = 0
  let n = 0
  for (let i = 0; i < buf.length; i++) {
    lp1 += a * (buf[i] - lp1)
    lp2 += a * (lp1 - lp2)
    if (i >= skip) {
      sum += lp2 * lp2
      n++
    }
  }
  return Math.sqrt(sum / Math.max(1, n))
}

/** Normalized autocorrelation at an integer lag — tonality proxy. */
function autocorrAt(buf: Float32Array, lag: number, skip = 4800): number {
  let num = 0
  let den = 0
  for (let i = skip; i < buf.length - lag; i++) {
    num += buf[i] * buf[i + lag]
    den += buf[i] * buf[i]
  }
  return num / Math.max(1e-12, den)
}

/** S&H hold-rate proxy: count of sample-to-sample value changes. */
function holdChanges(buf: Float32Array, skip = 100): number {
  let n = 0
  for (let i = skip + 1; i < buf.length; i++) {
    if (buf[i] !== buf[i - 1]) n++
  }
  return n
}

/** Goertzel mean-square power of the component at freqHz (exact-bin use). */
function goertzelMs(buf: Float32Array, freqHz: number, from = 0): number {
  const n = buf.length - from
  const w = (2 * Math.PI * freqHz) / SR
  const coeff = 2 * Math.cos(w)
  let s1 = 0
  let s2 = 0
  for (let i = from; i < buf.length; i++) {
    const s0 = buf[i] + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return (2 * (s1 * s1 + s2 * s2 - coeff * s1 * s2)) / (n * n)
}

function expectHealthy(buf: Float32Array, label: string): void {
  const st = stats(buf)
  expect(st.finite, `${label}: all samples finite`).toBe(true)
  expect(st.maxAbs, `${label}: bounded [-2,2]`).toBeLessThanOrEqual(2)
  expect(st.rms, `${label}: audible (RMS > 0.005)`).toBeGreaterThan(0.005)
}

const FREQS = [110, 1760]

describe('exports', () => {
  it('has the exact enum values', () => {
    expect(MULTI_TYPE).toEqual({ NOISE: 0, VPM: 1, USER: 2 })
    expect(NOISE_TYPE).toEqual({ HIGH: 0, LOW: 1, PEAK: 2, DECIM: 3 })
    expect(VPM_TYPE).toEqual({
      SIN1: 0, SIN2: 1, SIN3: 2, SIN4: 3,
      SAW1: 4, SAW2: 5, SQU1: 6, SQU2: 7,
      FAT1: 8, FAT2: 9, AIR1: 10, AIR2: 11,
      DECAY1: 12, DECAY2: 13, CREEP: 14, THROAT: 15,
    })
    expect(USER_OSC_NAMES).toEqual(['MORPH', 'SPRSAW', 'PWMCLS', 'ORGAN'])
  })
})

describe('NOISE oscillator', () => {
  for (const [name, sub] of Object.entries(NOISE_TYPE)) {
    for (const f of FREQS) {
      it(`${name} @ ${f} Hz renders healthy audio`, () => {
        const e = makeEngine(MULTI_TYPE.NOISE, sub, f)
        expectHealthy(render(e), `NOISE/${name}@${f}`)
      })
    }
  }

  it('HIGH: raising SHAPE (HPF 10 Hz..21 kHz) shrinks the low band', () => {
    // shape 0.1 -> HPF ~21 Hz (nearly full-band white); 0.9 -> HPF ~9.7 kHz
    const open = render(makeEngine(MULTI_TYPE.NOISE, NOISE_TYPE.HIGH, 220, 0.1))
    const high = render(makeEngine(MULTI_TYPE.NOISE, NOISE_TYPE.HIGH, 220, 0.9))
    const lowFrac = (buf: Float32Array): number => lowBandRms(buf, 300) / stats(buf).rms
    expect(lowFrac(open)).toBeGreaterThan(lowFrac(high) * 5)
    expect(brightness(high)).toBeGreaterThan(brightness(open) * 1.1)
  })

  it('LOW: lowering SHAPE (LPF 10 Hz..21 kHz) shrinks the high band', () => {
    // shape 0.3 -> LPF ~99 Hz (dark rumble); 0.95 -> LPF ~14 kHz (near-white)
    const dark = render(makeEngine(MULTI_TYPE.NOISE, NOISE_TYPE.LOW, 220, 0.3))
    const wide = render(makeEngine(MULTI_TYPE.NOISE, NOISE_TYPE.LOW, 220, 0.95))
    expect(brightness(wide)).toBeGreaterThan(brightness(dark) * 2)
  })

  it('PEAK center tracks the note frequency', () => {
    // center = note * 4 (fixed keytrack ratio), independent of SHAPE
    const lo = render(makeEngine(MULTI_TYPE.NOISE, NOISE_TYPE.PEAK, 110, 0))
    const hi = render(makeEngine(MULTI_TYPE.NOISE, NOISE_TYPE.PEAK, 1760, 0))
    const zLo = zeroCrossings(lo)
    const zHi = zeroCrossings(hi)
    expect(zLo).toBeGreaterThan(20)
    expect(zHi).toBeGreaterThan(zLo * 4) // 16x pitch => far denser crossings
  })

  it('PEAK SHAPE widens the bandwidth (110..880 Hz): narrow = tonal + quieter', () => {
    // note 375 Hz -> center 1500 Hz -> one period = exactly 32 samples
    const narrow = render(makeEngine(MULTI_TYPE.NOISE, NOISE_TYPE.PEAK, 375, 0))
    const wide = render(makeEngine(MULTI_TYPE.NOISE, NOISE_TYPE.PEAK, 375, 1))
    // narrowband noise stays correlated over a cycle; wideband decorrelates
    const rNarrow = autocorrAt(narrow, 32)
    const rWide = autocorrAt(wide, 32)
    expect(rNarrow).toBeGreaterThan(0.5)
    expect(rNarrow).toBeGreaterThan(rWide + 0.2)
    // a narrower band passes less noise power
    expect(stats(narrow).rms).toBeLessThan(stats(wide).rms * 0.75)
  })

  it('DECIM SHIFT+SHAPE=0: absolute rate, notes an octave apart hold equally', () => {
    const a = holdChanges(render(makeEngine(MULTI_TYPE.NOISE, NOISE_TYPE.DECIM, 110, 0.4, 0)))
    const b = holdChanges(render(makeEngine(MULTI_TYPE.NOISE, NOISE_TYPE.DECIM, 220, 0.4, 0)))
    expect(Math.abs(a - b)).toBeLessThan(Math.max(a, b) * 0.1)
  })

  it('DECIM SHIFT+SHAPE=1: full keytrack, an octave apart => ~2x hold rate', () => {
    const a = holdChanges(render(makeEngine(MULTI_TYPE.NOISE, NOISE_TYPE.DECIM, 110, 0.4, 1)))
    const b = holdChanges(render(makeEngine(MULTI_TYPE.NOISE, NOISE_TYPE.DECIM, 220, 0.4, 1)))
    expect(b / a).toBeGreaterThan(1.7)
    expect(b / a).toBeLessThan(2.3)
  })

  it('DECIM SHIFT+SHAPE audibly changes the rate away from C4', () => {
    // at 110 Hz, full keytrack scales the rate by (110/C4) ~ 0.42
    const fixed = render(makeEngine(MULTI_TYPE.NOISE, NOISE_TYPE.DECIM, 110, 0.4, 0))
    const tracked = render(makeEngine(MULTI_TYPE.NOISE, NOISE_TYPE.DECIM, 110, 0.4, 1))
    expect(holdChanges(fixed)).toBeGreaterThan(holdChanges(tracked) * 1.5)
  })
})

describe('VPM oscillator', () => {
  for (const [name, sub] of Object.entries(VPM_TYPE)) {
    for (const f of FREQS) {
      // DECAY types are rendered right after noteOn (env freshly retriggered)
      it(`${name} @ ${f} Hz renders healthy audio`, () => {
        const e = makeEngine(MULTI_TYPE.VPM, sub, f)
        expectHealthy(render(e), `VPM/${name}@${f}`)
      })
    }
  }

  it('DECAY1 internal envelope darkens the tone over time', () => {
    const e = makeEngine(MULTI_TYPE.VPM, VPM_TYPE.DECAY1, 220, 0.9, 0.5)
    const buf = render(e, 0.5)
    const early = meanAbsDiff(buf, 480, 5280) // right after the pluck
    const late = meanAbsDiff(buf, 19200, 24000) // env ~gone (tau 0.15 s)
    expect(early).toBeGreaterThan(late * 1.5)
  })

  it('SHAPE=0 leaves a clean carrier (near-sine)', () => {
    const e = makeEngine(MULTI_TYPE.VPM, VPM_TYPE.SIN1, 220, 0, 0)
    const buf = render(e, 0.25)
    const st = stats(buf)
    expect(st.finite).toBe(true)
    // sine RMS is ~0.707 * amplitude; trimmed carrier should be close
    expect(st.rms).toBeGreaterThan(0.4)
    expect(st.maxAbs).toBeLessThan(1.0)
  })

  it('SIN1 at the center detent (stored 512) is a pure sine at shape=0', () => {
    // SHIFT+SHAPE is a RATIO OFFSET, neutral at the detent: Sin1 must be a
    // clean 2-op sine with no feedback/offset bleed. THD proxy: nearly all
    // energy sits on the fundamental (exact bin: 220 cycles in 1 s).
    const e = makeEngine(MULTI_TYPE.VPM, VPM_TYPE.SIN1, 220, 0, 512 / 1023)
    const buf = render(e, 1.0)
    let tot = 0
    for (let i = 0; i < buf.length; i++) tot += buf[i] * buf[i]
    tot /= buf.length
    const fund = goertzelMs(buf, 220)
    expect(tot).toBeGreaterThan(0.1) // it actually sounds
    expect(fund / tot).toBeGreaterThan(0.999) // off-fundamental < 0.1%
  })

  it('SHIFT+SHAPE ratio offset: flat across the center zone, stepped outside', () => {
    const at = (ss: number): Float32Array =>
      render(makeEngine(MULTI_TYPE.VPM, VPM_TYPE.SIN1, 220, 0.6, ss), 0.3)
    // both values sit inside the neutral x1 zone -> bit-identical output
    const a = at(0.45)
    const b = at(0.55)
    let maxDiff = 0
    for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]))
    expect(maxDiff).toBe(0)
    // the x4 zone retunes the modulator: audibly different spectrum
    const hi = at(0.9)
    let sum = 0
    for (let i = 0; i < a.length; i++) {
      const d = a[i] - hi[i]
      sum += d * d
    }
    expect(Math.sqrt(sum / a.length)).toBeGreaterThan(0.05)
    expectHealthy(hi, 'SIN1 ss x4')
  })
})

describe('USER oscillators', () => {
  for (let slot = 0; slot < USER_OSC_NAMES.length; slot++) {
    for (const f of FREQS) {
      it(`${USER_OSC_NAMES[slot]} @ ${f} Hz renders healthy audio`, () => {
        const e = makeEngine(MULTI_TYPE.USER, slot, f)
        expectHealthy(render(e), `USER/${USER_OSC_NAMES[slot]}@${f}`)
      })
    }
  }

  it('SPRSAW detune spread widens with SHAPE', () => {
    // with zero spread all 7 saws stay phase-locked -> steady waveform;
    // with full spread the voices beat against each other -> amplitude varies
    const locked = render(makeEngine(MULTI_TYPE.USER, 1, 220, 0, 1), 0.4)
    const spread = render(makeEngine(MULTI_TYPE.USER, 1, 220, 1, 1), 0.4)
    const peakVar = (buf: Float32Array): number => {
      // peak level per 1000-sample window, then variance of those peaks
      let n = 0
      let mean = 0
      let m2 = 0
      for (let w = 4800; w + 1000 <= buf.length; w += 1000) {
        let p = 0
        for (let i = w; i < w + 1000; i++) p = Math.max(p, Math.abs(buf[i]))
        n++
        const d = p - mean
        mean += d / n
        m2 += d * (p - mean)
      }
      return m2 / n
    }
    expect(peakVar(spread)).toBeGreaterThan(peakVar(locked) * 2)
  })

  it('MORPH survives a full SHAPE sweep with heavy wavefold', () => {
    const e = makeEngine(MULTI_TYPE.USER, 0, 440, 0, 1)
    const n = 24000
    let maxAbs = 0
    let ok = true
    for (let i = 0; i < n; i++) {
      e.setShape(i / n)
      const y = e.tick()
      if (!Number.isFinite(y)) ok = false
      maxAbs = Math.max(maxAbs, Math.abs(y))
    }
    expect(ok).toBe(true)
    expect(maxAbs).toBeLessThanOrEqual(2)
  })

  it('ORGAN percussion adds an attack transient scaled by SHIFT+SHAPE', () => {
    const noPerc = render(makeEngine(MULTI_TYPE.USER, 3, 220, 0.2, 0), 0.05)
    const perc = render(makeEngine(MULTI_TYPE.USER, 3, 220, 0.2, 1), 0.05)
    // percussion is an extra decaying upper harmonic -> brighter early window
    const b0 = meanAbsDiff(noPerc, 0, noPerc.length)
    const b1 = meanAbsDiff(perc, 0, perc.length)
    expect(b1).toBeGreaterThan(b0 * 1.1)
  })
})

describe('VPM menu trims', () => {
  const NEUTRAL: VpmTrims = {
    feedback: 0, noiseDepth: 0, shapeModInt: 0, modAttack: 0, modDecay: 0, keyTrack: 0,
  }

  /** VPM engine with trims applied before noteOn (shift at the neutral detent). */
  function makeTrimmed(
    sub: number,
    freq: number,
    over: Partial<VpmTrims>,
    shape = 0.5,
    shift = 0.5,
  ): MultiEngine {
    const e = new MultiEngine(SR)
    e.setType(MULTI_TYPE.VPM)
    e.setSubType(sub)
    e.setShape(shape)
    e.setShiftShape(shift)
    e.setFreq(freq)
    e.setVpmTrims({ ...NEUTRAL, ...over })
    e.noteOn()
    return e
  }

  function diffRms(a: Float32Array, b: Float32Array, from = 0): number {
    let sum = 0
    const n = Math.min(a.length, b.length)
    for (let i = from; i < n; i++) {
      const d = a[i] - b[i]
      sum += d * d
    }
    return Math.sqrt(sum / Math.max(1, n - from))
  }

  it('neutral trims leave VPM output bit-identical to the untrimmed engine', () => {
    const plain = render(makeEngine(MULTI_TYPE.VPM, VPM_TYPE.FAT1, 220, 0.5, 0.5), 0.3)
    const trimmed = render(makeTrimmed(VPM_TYPE.FAT1, 220, {}), 0.3)
    expect(diffRms(plain, trimmed)).toBeLessThan(1e-12)
  })

  it('FEEDBACK +100% vs -100% differs strongly and is brighter (Squ1)', () => {
    // Squ1: baked fb 0.8 and a 2x modulator, so the slope-based brightness
    // proxy tracks feedback directly (sub-modulator types like Fat1 push
    // sidebands *below* the carrier, which this proxy cannot rank).
    const hi = render(makeTrimmed(VPM_TYPE.SQU1, 220, { feedback: 1 }), 0.3)
    const lo = render(makeTrimmed(VPM_TYPE.SQU1, 220, { feedback: -1 }), 0.3)
    expectHealthy(hi, 'SQU1 fb +100%')
    expectHealthy(lo, 'SQU1 fb -100%')
    expect(diffRms(hi, lo, 2400)).toBeGreaterThan(0.02)
    // more modulator self-feedback = more harmonics = brighter
    const bHi = meanAbsDiff(hi, 4800, hi.length)
    const bLo = meanAbsDiff(lo, 4800, lo.length)
    expect(bHi).toBeGreaterThan(bLo * 1.5)
  })

  it('FEEDBACK trim also alters sub-modulator types with baked feedback (Fat1)', () => {
    const hi = render(makeTrimmed(VPM_TYPE.FAT1, 220, { feedback: 1 }), 0.3)
    const lo = render(makeTrimmed(VPM_TYPE.FAT1, 220, { feedback: -1 }), 0.3)
    expectHealthy(hi, 'FAT1 fb +100%')
    expectHealthy(lo, 'FAT1 fb -100%')
    expect(diffRms(hi, lo, 2400)).toBeGreaterThan(0.02)
  })

  it('NOISE DEPTH +100% injects noise; <=0% stays clean (baked amount is 0)', () => {
    const neutral = render(makeTrimmed(VPM_TYPE.SIN1, 220, {}), 0.3)
    const noisy = render(makeTrimmed(VPM_TYPE.SIN1, 220, { noiseDepth: 1 }), 0.3)
    const down = render(makeTrimmed(VPM_TYPE.SIN1, 220, { noiseDepth: -1 }), 0.3)
    expectHealthy(noisy, 'SIN1 noise +100%')
    expect(diffRms(noisy, neutral, 2400)).toBeGreaterThan(0.01)
    expect(diffRms(down, neutral)).toBeLessThan(1e-12)
  })

  it('SHAPE MOD INT -100% fully disables the DECAY1 internal EG', () => {
    // brightness right after noteOn vs after the env is ~gone (tau 0.15 s)
    const ratio = (buf: Float32Array): number =>
      meanAbsDiff(buf, 480, 5280) / meanAbsDiff(buf, 19200, 24000)
    const def = render(makeTrimmed(VPM_TYPE.DECAY1, 220, {}, 0.9), 0.5)
    const off = render(makeTrimmed(VPM_TYPE.DECAY1, 220, { shapeModInt: -1 }, 0.9), 0.5)
    expect(ratio(def)).toBeGreaterThan(1.5) // stock: pluck decays audibly
    expect(ratio(off)).toBeLessThan(1.2) // EG gone: start ~= later
    expect(ratio(def)).toBeGreaterThan(ratio(off) * 1.3)
  })

  it('MOD DECAY +100% lengthens the DECAY1 mod-index decay', () => {
    const def = render(makeTrimmed(VPM_TYPE.DECAY1, 220, {}, 0.9), 0.5)
    const slow = render(makeTrimmed(VPM_TYPE.DECAY1, 220, { modDecay: 1 }, 0.9), 0.5)
    // late window: the slower env (tau x4) still holds harmonics up
    const late = (buf: Float32Array): number => meanAbsDiff(buf, 19200, 24000)
    expect(late(slow)).toBeGreaterThan(late(def) * 1.3)
  })

  it('MOD ATTACK +100% ramps the DECAY1 mod index in softly', () => {
    const def = render(makeTrimmed(VPM_TYPE.DECAY1, 220, {}, 0.9), 0.1)
    const soft = render(makeTrimmed(VPM_TYPE.DECAY1, 220, { modAttack: 1 }, 0.9), 0.1)
    // ~180 ms attack: the first 50 ms carry far less modulation = darker
    expect(meanAbsDiff(def, 0, 2400)).toBeGreaterThan(meanAbsDiff(soft, 0, 2400) * 1.2)
  })

  it('KEY TRACK +100% darkens high notes (mod index tilt around C4)', () => {
    const def = render(makeTrimmed(VPM_TYPE.SQU1, 1760, {}), 0.3)
    const kt = render(makeTrimmed(VPM_TYPE.SQU1, 1760, { keyTrack: 1 }), 0.3)
    const b = (buf: Float32Array): number => meanAbsDiff(buf, 4800, buf.length)
    expect(b(def)).toBeGreaterThan(b(kt) * 1.3)
  })

  it('trims leave NOISE and USER modes bit-identical', () => {
    const extremes: VpmTrims = {
      feedback: 1, noiseDepth: 1, shapeModInt: 1, modAttack: 1, modDecay: 1, keyTrack: 1,
    }
    const cases: Array<[number, number]> = [
      [MULTI_TYPE.NOISE, NOISE_TYPE.HIGH],
      [MULTI_TYPE.USER, 3], // ORGAN
    ]
    for (const [type, sub] of cases) {
      const plain = render(makeEngine(type, sub, 220), 0.2)
      const e = new MultiEngine(SR)
      e.setType(type)
      e.setSubType(sub)
      e.setShape(0.5)
      e.setShiftShape(0.5)
      e.setFreq(220)
      e.setVpmTrims(extremes)
      e.noteOn()
      const trimmed = render(e, 0.2)
      let maxDiff = 0
      for (let i = 0; i < plain.length; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(plain[i] - trimmed[i]))
      }
      expect(maxDiff, `type ${type} unaffected by trims`).toBe(0)
    }
  })

  it('trims survive a subtype switch mid-note', () => {
    // Switch SIN1 -> FAT1 with feedback trim engaged: the post-switch audio
    // must match a FAT1 engine that had the trim from the start.
    const e = makeTrimmed(VPM_TYPE.SIN1, 220, { feedback: 1 })
    render(e, 0.1)
    e.setSubType(VPM_TYPE.FAT1)
    render(e, 0.1) // fade-out/commit/fade-in fully elapses
    e.noteOn() // realign phases/envelopes for comparison
    const switched = render(e, 0.2)
    const direct = render(makeTrimmed(VPM_TYPE.FAT1, 220, { feedback: 1 }), 0.2)
    let maxDiff = 0
    for (let i = 0; i < switched.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(switched[i] - direct[i]))
    }
    expect(maxDiff).toBeLessThan(1e-12)
  })

  it('tolerates garbage trim values', () => {
    const e = makeTrimmed(VPM_TYPE.SAW2, 220, {})
    e.setVpmTrims({
      feedback: Number.NaN,
      noiseDepth: Number.POSITIVE_INFINITY,
      shapeModInt: -5,
      modAttack: 7,
      modDecay: Number.NEGATIVE_INFINITY,
      keyTrack: Number.NaN,
    })
    const st = stats(render(e, 0.1))
    expect(st.finite).toBe(true)
    expect(st.maxAbs).toBeLessThanOrEqual(2)
  })
})

describe('engine behavior', () => {
  it('is deterministic across reset() + noteOn()', () => {
    const e = makeEngine(MULTI_TYPE.NOISE, NOISE_TYPE.HIGH, 220)
    const a = render(e, 0.2)
    e.reset()
    e.noteOn()
    const b = render(e, 0.2)
    let maxDiff = 0
    for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]))
    expect(maxDiff).toBeLessThan(1e-7)
  })

  it('sweeping SHAPE produces no discontinuities', () => {
    const e = makeEngine(MULTI_TYPE.VPM, VPM_TYPE.SIN1, 220, 0, 0)
    const n = 24000
    let prev = 0
    let maxJump = 0
    for (let i = 0; i < n; i++) {
      e.setShape(i / n)
      const y = e.tick()
      expect(Number.isFinite(y)).toBe(true)
      if (i > 0) maxJump = Math.max(maxJump, Math.abs(y - prev))
      prev = y
    }
    expect(maxJump).toBeLessThan(0.5)
  })

  it('type switching mid-note crossfades without clicks', () => {
    const e = makeEngine(MULTI_TYPE.VPM, VPM_TYPE.SIN1, 220, 0.5, 0.2)
    const n = 24000
    const buf = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      if (i === 12000) {
        e.setType(MULTI_TYPE.USER)
        e.setSubType(3) // ORGAN
      }
      buf[i] = e.tick()
    }
    const st = stats(buf)
    expect(st.finite).toBe(true)
    expect(st.maxAbs).toBeLessThanOrEqual(2)
    let maxJump = 0
    for (let i = 11000; i < 14000; i++) {
      maxJump = Math.max(maxJump, Math.abs(buf[i] - buf[i - 1]))
    }
    expect(maxJump).toBeLessThan(0.5)
  })

  it('tolerates garbage parameter values without blowing up', () => {
    const e = makeEngine(MULTI_TYPE.VPM, VPM_TYPE.SAW2, 220)
    e.setShape(Number.NaN)
    e.setShiftShape(Number.POSITIVE_INFINITY)
    e.setFreq(Number.NaN)
    e.setFreq(1e9) // clamped to the usable band
    const st = stats(render(e, 0.1))
    expect(st.finite).toBe(true)
    expect(st.maxAbs).toBeLessThanOrEqual(2)
  })

  it('reset() returns a usable engine', () => {
    const e = makeEngine(MULTI_TYPE.USER, 2, 440)
    render(e, 0.05)
    e.reset()
    const st = stats(render(e, 0.1))
    expect(st.finite).toBe(true)
    expect(st.rms).toBeGreaterThan(0.005)
  })
})
