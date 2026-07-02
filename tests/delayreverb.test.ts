import { describe, expect, it } from 'vitest'
import { DELAY_SUBTYPES, DelayFx } from '../src/dsp/fx/delay'
import { REVERB_SUBTYPES, ReverbFx } from '../src/dsp/fx/reverb'

const SR = 48000
const BLOCK = 128

function hasNaN(buf: Float32Array): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (!Number.isFinite(buf[i])) return true
  }
  return false
}

/** Sum of squares over a time window [t0, t1) seconds. */
function energy(buf: Float32Array, t0: number, t1: number): number {
  const a = Math.max(0, Math.floor(t0 * SR))
  const b = Math.min(buf.length, Math.floor(t1 * SR))
  let acc = 0
  for (let i = a; i < b; i++) acc += buf[i] * buf[i]
  return acc
}

function argmaxAbs(buf: Float32Array, from: number): number {
  let best = from
  let bestV = -1
  for (let i = from; i < buf.length; i++) {
    const v = Math.abs(buf[i])
    if (v > bestV) {
      bestV = v
      best = i
    }
  }
  return best
}

function makeNoise(seed = 0x12345678): () => number {
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

function runBlocks(
  fx: { process(l: Float32Array, r: Float32Array, n: number): void },
  l: Float32Array,
  r: Float32Array,
): void {
  for (let off = 0; off < l.length; off += BLOCK) {
    const n = Math.min(BLOCK, l.length - off)
    fx.process(l.subarray(off, off + n), r.subarray(off, off + n), n)
  }
}

// ---------------------------------------------------------------------------
// Delay
// ---------------------------------------------------------------------------

const TIME_FREE = 0.5 // -> 0.001 * 1400^0.5 s
const TIME_BPM = 0.42 // -> division index floor(0.42*15) = 6 -> 1/8
const TIME_DBL = 0.5 // -> 30 + 0.5*60 = 60 ms
const BPM = 120

/** Expected first-tap time (seconds) on the LEFT channel per subtype. */
function expectedTapSec(sub: number): number {
  const name = DELAY_SUBTYPES[sub]
  if (name === 'DOUBLING') return 0.06 * (1 - 0.02) // 2% L spread
  const bpmSync = name.includes('BPM')
  const base = bpmSync
    ? (1 / 8) * (240 / BPM) // 1/8 division at 120 BPM = 0.25 s
    : 0.001 * Math.pow(1400, TIME_FREE)
  if (name === 'STEREO' || name === 'ST.BPM') return base * 0.97 // 3% L spread
  return base
}

function renderDelayImpulse(sub: number, depth: number, seconds: number) {
  const d = new DelayFx(SR)
  d.setSubType(sub)
  d.setBpm(BPM)
  const name = DELAY_SUBTYPES[sub]
  d.setTime(name === 'DOUBLING' ? TIME_DBL : name.includes('BPM') ? TIME_BPM : TIME_FREE)
  d.setDepth(depth)
  d.setDryWet(0.5)
  d.setOn(true)
  const len = Math.floor(seconds * SR)
  const l = new Float32Array(len)
  const r = new Float32Array(len)
  l[0] = 1
  r[0] = 1
  runBlocks(d, l, r)
  return { l, r }
}

const NO_FEEDBACK = new Set(['ONE TAP', 'DOUBLING'])

describe('DelayFx: every subtype', () => {
  for (let sub = 0; sub < DELAY_SUBTYPES.length; sub++) {
    const name = DELAY_SUBTYPES[sub]
    const tape = name.startsWith('TAPE')

    it(`${name}: impulse tap lands at the expected time, no NaN over 3 s`, () => {
      const { l, r } = renderDelayImpulse(sub, 0.6, 3)
      expect(hasNaN(l)).toBe(false)
      expect(hasNaN(r)).toBe(false)
      const expSamp = expectedTapSec(sub) * SR
      // skip the dry impulse at t=0, find the loudest wet event
      const peak = argmaxAbs(l, 64)
      const tol = tape ? 0.15 : 0.1
      expect(peak).toBeGreaterThanOrEqual(Math.floor(expSamp * (1 - tol)))
      expect(peak).toBeLessThanOrEqual(Math.ceil(expSamp * (1 + tol)))
      // there is real energy around the tap
      const t = expectedTapSec(sub)
      expect(energy(l, t * 0.85, t * 1.15)).toBeGreaterThan(1e-4)
    })

    if (!NO_FEEDBACK.has(name)) {
      it(`${name}: feedback decays (energy at 2.5 s < energy at 0.5 s, depth 0.6)`, () => {
        const { l, r } = renderDelayImpulse(sub, 0.6, 3)
        const e05 = energy(l, 0.4, 0.6) + energy(r, 0.4, 0.6)
        const e25 = energy(l, 2.4, 2.6) + energy(r, 2.4, 2.6)
        expect(e05).toBeGreaterThan(1e-12)
        expect(e25).toBeLessThan(e05)
      })
    } else {
      it(`${name}: no feedback — silent after the single tap`, () => {
        const { l, r } = renderDelayImpulse(sub, 0.6, 3)
        expect(energy(l, 2.4, 2.6)).toBeLessThan(1e-9)
        expect(energy(r, 2.4, 2.6)).toBeLessThan(1e-9)
      })
    }
  }

  it('STEREO: right tap sits ~3% late relative to left', () => {
    const { r } = renderDelayImpulse(0, 0.6, 1)
    const base = 0.001 * Math.pow(1400, TIME_FREE) * SR
    const peakR = argmaxAbs(r, 64)
    expect(peakR).toBeGreaterThanOrEqual(Math.floor(base * 1.03 * 0.95))
    expect(peakR).toBeLessThanOrEqual(Math.ceil(base * 1.03 * 1.05))
  })

  it('PING PONG: second echo shows up on the right at ~2x the tap time', () => {
    const { r } = renderDelayImpulse(2, 0.6, 1)
    const t = 0.001 * Math.pow(1400, TIME_FREE)
    expect(energy(r, 2 * t * 0.9, 2 * t * 1.1)).toBeGreaterThan(1e-6)
    // right channel has (almost) nothing at 1x tap time
    expect(energy(r, t * 0.95, t * 1.05)).toBeLessThan(energy(r, 2 * t * 0.9, 2 * t * 1.1))
  })

  it('depth=0 is identity, dryWet=0 is identity', () => {
    for (const [depth, dryWet] of [
      [0, 0.5],
      [1, 0],
    ] as const) {
      const d = new DelayFx(SR)
      d.setSubType(0)
      d.setTime(0.3)
      d.setDepth(depth)
      d.setDryWet(dryWet)
      d.setOn(true)
      const noise = makeNoise()
      const len = 2048
      const l = new Float32Array(len)
      const r = new Float32Array(len)
      for (let i = 0; i < len; i++) {
        l[i] = noise()
        r[i] = noise()
      }
      const refL = l.slice()
      const refR = r.slice()
      runBlocks(d, l, r)
      for (let i = 0; i < len; i++) {
        expect(Math.abs(l[i] - refL[i])).toBeLessThan(1e-6)
        expect(Math.abs(r[i] - refR[i])).toBeLessThan(1e-6)
      }
    }
  })

  it('bypass (setOn(false) from the start) is exact identity', () => {
    const d = new DelayFx(SR)
    d.setSubType(4)
    d.setDepth(1)
    d.setOn(false)
    const noise = makeNoise(0xabcdef)
    const l = new Float32Array(1024)
    const r = new Float32Array(1024)
    for (let i = 0; i < l.length; i++) {
      l[i] = noise()
      r[i] = noise()
    }
    const refL = l.slice()
    const refR = r.slice()
    runBlocks(d, l, r)
    expect(l).toEqual(refL)
    expect(r).toEqual(refR)
  })
})

// ---------------------------------------------------------------------------
// Reverb
// ---------------------------------------------------------------------------

function renderReverbImpulse(sub: number, time: number, seconds: number) {
  const rv = new ReverbFx(SR)
  rv.setSubType(sub)
  rv.setTime(time)
  rv.setDepth(1)
  rv.setDryWet(1) // wet only, so we measure the tail alone
  rv.setOn(true)
  const len = Math.floor(seconds * SR)
  const l = new Float32Array(len)
  const r = new Float32Array(len)
  l[0] = 1
  r[0] = 1
  runBlocks(rv, l, r)
  return { l, r }
}

describe('ReverbFx: every subtype', () => {
  for (let sub = 0; sub < REVERB_SUBTYPES.length; sub++) {
    const name = REVERB_SUBTYPES[sub]
    const isER = name === 'EARLY REF'

    it(`${name}: 3 s impulse response has no NaN`, () => {
      const { l, r } = renderReverbImpulse(sub, 0.9, 3)
      expect(hasNaN(l)).toBe(false)
      expect(hasNaN(r)).toBe(false)
    })

    if (!isER) {
      it(`${name}: tail exists (energy 0.5..1 s > tiny)`, () => {
        const { l, r } = renderReverbImpulse(sub, 0.9, 3)
        expect(energy(l, 0.5, 1) + energy(r, 0.5, 1)).toBeGreaterThan(1e-8)
      })

      it(`${name}: RT scales with the TIME knob (tail at 0.9 > tail at 0.1)`, () => {
        const long = renderReverbImpulse(sub, 0.9, 3)
        const short = renderReverbImpulse(sub, 0.1, 3)
        const eLong = energy(long.l, 1, 2) + energy(long.r, 1, 2)
        const eShort = energy(short.l, 1, 2) + energy(short.r, 1, 2)
        expect(eLong).toBeGreaterThan(eShort)
      })
    } else {
      it('EARLY REF: reflections exist early, no tail', () => {
        const { l, r } = renderReverbImpulse(sub, 0.5, 3)
        expect(energy(l, 0, 0.3) + energy(r, 0, 0.3)).toBeGreaterThan(1e-6)
        expect(energy(l, 1, 3) + energy(r, 1, 3)).toBeLessThan(1e-10)
      })
    }

    it(`${name}: depth=0 and dryWet=0 are identity`, () => {
      for (const [depth, dryWet] of [
        [0, 0.5],
        [1, 0],
      ] as const) {
        const rv = new ReverbFx(SR)
        rv.setSubType(sub)
        rv.setTime(0.7)
        rv.setDepth(depth)
        rv.setDryWet(dryWet)
        rv.setOn(true)
        const noise = makeNoise(0xdeadbeef + sub)
        const len = 2048
        const l = new Float32Array(len)
        const r = new Float32Array(len)
        for (let i = 0; i < len; i++) {
          l[i] = noise()
          r[i] = noise()
        }
        const refL = l.slice()
        const refR = r.slice()
        runBlocks(rv, l, r)
        for (let i = 0; i < len; i++) {
          expect(Math.abs(l[i] - refL[i])).toBeLessThan(1e-6)
          expect(Math.abs(r[i] - refR[i])).toBeLessThan(1e-6)
        }
      }
    })
  }

  it('silence in, silence out: no NaN/denormal buildup over 3 s', () => {
    const rv = new ReverbFx(SR)
    rv.setSubType(7) // RISER (shimmer feedback path)
    rv.setTime(0.9)
    rv.setDepth(1)
    const len = 3 * SR
    const l = new Float32Array(len)
    const r = new Float32Array(len)
    runBlocks(rv, l, r)
    expect(hasNaN(l)).toBe(false)
    expect(hasNaN(r)).toBe(false)
    expect(energy(l, 0, 3)).toBe(0)
  })
})
