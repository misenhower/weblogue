import { describe, it, expect } from 'vitest'
import { ModFx, MODFX_TYPE, MODFX_SUBTYPES } from '../src/dsp/fx/modfx'

const SR = 48000
const BLOCK = 128
const secs = (s: number) => Math.round(s * SR)

/** Deterministic LCG noise in [0, 1). */
function makeLcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** Stereo test signal: 440 Hz tone + white noise (decorrelated per channel). */
function makeInput(n: number, seed: number): [Float32Array, Float32Array] {
  const rand = makeLcg(seed)
  const l = new Float32Array(n)
  const r = new Float32Array(n)
  const w = (2 * Math.PI * 440) / SR
  for (let i = 0; i < n; i++) {
    l[i] = 0.4 * Math.sin(w * i) + 0.2 * (rand() * 2 - 1)
    r[i] = 0.4 * Math.sin(w * i + 0.7) + 0.2 * (rand() * 2 - 1)
  }
  return [l, r]
}

/** Process [from, to) in-place in BLOCK-sized chunks (like the worklet does). */
function processRange(fx: ModFx, l: Float32Array, r: Float32Array, from: number, to: number): void {
  for (let i = from; i < to; i += BLOCK) {
    const n = Math.min(BLOCK, to - i)
    fx.process(l.subarray(i, i + n), r.subarray(i, i + n), n)
  }
}

function processAll(fx: ModFx, l: Float32Array, r: Float32Array): void {
  processRange(fx, l, r, 0, l.length)
}

const combos: Array<{ t: number; s: number; label: string }> = []
for (let t = 0; t < MODFX_SUBTYPES.length; t++) {
  for (let s = 0; s < MODFX_SUBTYPES[t].length; s++) {
    combos.push({ t, s, label: `type ${t} sub ${s} (${MODFX_SUBTYPES[t][s]})` })
  }
}

describe('ModFx — every [type][subtype] combination', () => {
  it('exposes the hardware type/subtype lists', () => {
    expect(MODFX_SUBTYPES.length).toBe(5)
    expect(MODFX_SUBTYPES[MODFX_TYPE.CHORUS].length).toBe(8)
    expect(MODFX_SUBTYPES[MODFX_TYPE.ENSEMBLE].length).toBe(3)
    expect(MODFX_SUBTYPES[MODFX_TYPE.PHASER].length).toBe(8)
    expect(MODFX_SUBTYPES[MODFX_TYPE.FLANGER].length).toBe(8)
    expect(MODFX_SUBTYPES[MODFX_TYPE.USER].length).toBe(2)
  })

  for (const { t, s, label } of combos) {
    it(`${label}: finite, bounded, audible at depth 0.8; reset -> silence`, () => {
      const n = secs(0.5)
      const [l, r] = makeInput(n, 0xc0ffee + t * 131 + s * 17)
      const inL = l.slice()
      const inR = r.slice()

      const fx = new ModFx(SR)
      fx.setType(t, s)
      fx.setTime(0.5)
      fx.setDepth(0.8)
      fx.setOn(true)
      fx.reset() // apply type immediately, snap smoothing
      processAll(fx, l, r)

      let finite = true
      let maxAbs = 0
      let sumSq = 0
      for (let i = 0; i < n; i++) {
        const a = l[i]
        const b = r[i]
        if (!Number.isFinite(a) || !Number.isFinite(b)) finite = false
        const aa = Math.abs(a)
        const ab = Math.abs(b)
        if (aa > maxAbs) maxAbs = aa
        if (ab > maxAbs) maxAbs = ab
        const dl = a - inL[i]
        const dr = b - inR[i]
        sumSq += dl * dl + dr * dr
      }
      expect(finite).toBe(true)
      expect(maxAbs).toBeLessThanOrEqual(2.5)
      // effect is audible: RMS of (output - input) over the whole run
      expect(Math.sqrt(sumSq / (2 * n))).toBeGreaterThan(1e-4)

      // reset() then silence in -> silence out within 100 ms
      fx.reset()
      const m = secs(0.1) + BLOCK
      const zl = new Float32Array(m)
      const zr = new Float32Array(m)
      processAll(fx, zl, zr)
      let tail = 0
      for (let i = m - BLOCK; i < m; i++) {
        tail = Math.max(tail, Math.abs(zl[i]), Math.abs(zr[i]))
      }
      expect(tail).toBeLessThanOrEqual(1e-6)
    })
  }
})

describe('ModFx — bypass', () => {
  // Representative set, including the full-wet subtypes (VIBRATO, ROTARY)
  // and the feedback-heavy ones (SM RESO, MONO SWEEP).
  const cases: Array<[number, number]> = [
    [MODFX_TYPE.CHORUS, 0], // STEREO
    [MODFX_TYPE.CHORUS, 7], // VIBRATO — 100% wet
    [MODFX_TYPE.ENSEMBLE, 0],
    [MODFX_TYPE.PHASER, 4], // SM RESO — high feedback
    [MODFX_TYPE.FLANGER, 6], // MONO SWEEP — hottest feedback
    [MODFX_TYPE.USER, 0], // ROTARY — full-wet speaker sim
    [MODFX_TYPE.USER, 1], // TREM
  ]
  for (const [t, s] of cases) {
    it(`setOn(false) converges to exact identity within 50 ms (type ${t} sub ${s})`, () => {
      const a = secs(0.2) // effect running
      const b = a + secs(0.05) // bypass fade window
      const total = b + secs(0.1) // verification region
      const [l, r] = makeInput(total, 4242 + t * 7 + s)
      const inL = l.slice()
      const inR = r.slice()

      const fx = new ModFx(SR)
      fx.setType(t, s)
      fx.setTime(0.6)
      fx.setDepth(0.8)
      fx.reset()
      processRange(fx, l, r, 0, a)
      fx.setOn(false)
      processRange(fx, l, r, a, b) // 50 ms to converge
      processRange(fx, l, r, b, total)

      // during the fade: still no NaN and no explosion
      let finite = true
      for (let i = a; i < b; i++) {
        if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) finite = false
      }
      expect(finite).toBe(true)

      // after 50 ms: bit-exact identity
      let maxDiff = 0
      for (let i = b; i < total; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(l[i] - inL[i]), Math.abs(r[i] - inR[i]))
      }
      expect(maxDiff).toBe(0)
    })
  }
})

describe('ModFx — type switching', () => {
  it('mid-stream type/subtype changes never jump more than 0.5 sample-to-sample', () => {
    const seq: Array<[number, number]> = [
      [MODFX_TYPE.ENSEMBLE, 0],
      [MODFX_TYPE.PHASER, 0],
      [MODFX_TYPE.PHASER, 6], // FORMANT
      [MODFX_TYPE.FLANGER, 5], // PAN SWEEP
      [MODFX_TYPE.USER, 0], // ROTARY
      [MODFX_TYPE.USER, 1], // TREM
      [MODFX_TYPE.CHORUS, 7], // VIBRATO
      [MODFX_TYPE.CHORUS, 0], // back to start
    ]
    const seg = secs(0.15)
    const total = seg * (seq.length + 1)
    // pure tone input: its own sample-to-sample delta is ~0.03, so any jump
    // near the 0.5 limit would come from the effect switch itself
    const l = new Float32Array(total)
    const r = new Float32Array(total)
    const w = (2 * Math.PI * 440) / SR
    for (let i = 0; i < total; i++) {
      l[i] = 0.6 * Math.sin(w * i)
      r[i] = 0.6 * Math.sin(w * i + 0.9)
    }

    const fx = new ModFx(SR)
    fx.setType(MODFX_TYPE.CHORUS, 0)
    fx.setTime(0.5)
    fx.setDepth(0.8)
    fx.reset()
    processRange(fx, l, r, 0, seg)
    for (let k = 0; k < seq.length; k++) {
      fx.setType(seq[k][0], seq[k][1]) // switch mid-stream, no reset
      processRange(fx, l, r, seg * (k + 1), seg * (k + 2))
    }

    let finite = true
    let maxJump = 0
    for (let i = 1; i < total; i++) {
      if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) finite = false
      maxJump = Math.max(maxJump, Math.abs(l[i] - l[i - 1]), Math.abs(r[i] - r[i - 1]))
    }
    expect(finite).toBe(true)
    expect(maxJump).toBeLessThanOrEqual(0.5)
  })

  it('rapid re-switching while a switch fade is in flight stays clean', () => {
    const total = secs(0.3)
    const [l, r] = makeInput(total, 987654)
    const fx = new ModFx(SR)
    fx.setTime(0.5)
    fx.setDepth(0.8)
    fx.reset()
    // fire a new setType every block (much faster than the ~6 ms fade)
    let k = 0
    for (let i = 0; i < total; i += BLOCK) {
      const c = combos[k % combos.length]
      fx.setType(c.t, c.s)
      k++
      const n = Math.min(BLOCK, total - i)
      fx.process(l.subarray(i, i + n), r.subarray(i, i + n), n)
    }
    let finite = true
    let maxAbs = 0
    for (let i = 0; i < total; i++) {
      if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) finite = false
      maxAbs = Math.max(maxAbs, Math.abs(l[i]), Math.abs(r[i]))
    }
    expect(finite).toBe(true)
    expect(maxAbs).toBeLessThanOrEqual(2.5)
  })
})

describe('ModFx — robustness', () => {
  it('flushes NaN/Inf inputs and recovers', () => {
    const fx = new ModFx(SR)
    fx.setType(MODFX_TYPE.FLANGER, 6) // hottest feedback path
    fx.setDepth(1)
    fx.setTime(1)
    fx.reset()
    const n = secs(0.1)
    const [l, r] = makeInput(n, 13)
    l[100] = Number.NaN
    r[200] = Number.POSITIVE_INFINITY
    l[300] = Number.NEGATIVE_INFINITY
    processAll(fx, l, r)
    let finite = true
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) finite = false
    }
    expect(finite).toBe(true)
  })

  it('clamps out-of-range type/subtype selections instead of crashing', () => {
    const fx = new ModFx(SR)
    fx.setType(99, 99)
    fx.setType(-3, -3)
    fx.setType(Number.NaN, Number.NaN)
    fx.reset()
    const n = secs(0.05)
    const [l, r] = makeInput(n, 7)
    processAll(fx, l, r)
    let finite = true
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) finite = false
    }
    expect(finite).toBe(true)
  })
})
