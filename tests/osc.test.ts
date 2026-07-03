import { describe, expect, it } from 'vitest'
import { VCO_WAVE, Vco } from '../src/dsp/osc'
import { goertzel } from './helpers/audio'

const SR = 48000

interface RunStats {
  finite: boolean
  min: number
  max: number
  mean: number
  wraps: number
}

function run(v: Vco, n: number, opts?: { fm?: number; shapeSweep?: boolean }): RunStats {
  const fm = opts?.fm ?? 0
  const sweep = opts?.shapeSweep ?? false
  let finite = true
  let min = Infinity
  let max = -Infinity
  let sum = 0
  let wraps = 0
  for (let i = 0; i < n; i++) {
    if (sweep) {
      const ph = i / n
      v.setShape(ph < 0.5 ? ph * 2 : 2 - ph * 2) // 0 -> 1 -> 0
    }
    const s = v.tick(fm)
    if (!Number.isFinite(s)) finite = false
    if (s < min) min = s
    if (s > max) max = s
    sum += s
    if (v.wrapped) wraps++
  }
  return { finite, min, max, mean: sum / n, wraps }
}

function makeVco(wave: number, freq: number, shape = 0): Vco {
  const v = new Vco(SR)
  v.setWave(wave)
  v.setFreq(freq)
  v.setShape(shape)
  v.reset()
  return v
}

describe('VCO_WAVE enum', () => {
  it('has the exact numeric values downstream code relies on', () => {
    expect(VCO_WAVE.SQR).toBe(0)
    expect(VCO_WAVE.TRI).toBe(1)
    expect(VCO_WAVE.SAW).toBe(2)
  })
})

describe('stability and bounds (2 s per wave/freq with full shape sweep)', () => {
  const waves = [
    ['SQR', VCO_WAVE.SQR],
    ['TRI', VCO_WAVE.TRI],
    ['SAW', VCO_WAVE.SAW],
  ] as const
  const freqs = [55, 440, 2000, 5000]

  for (const [name, wave] of waves) {
    for (const freq of freqs) {
      it(`${name} @ ${freq} Hz: no NaN/Inf, output within [-1.5, 1.5]`, () => {
        const v = makeVco(wave, freq)
        const st = run(v, 2 * SR, { shapeSweep: true })
        expect(st.finite).toBe(true)
        expect(st.min).toBeGreaterThanOrEqual(-1.5)
        expect(st.max).toBeLessThanOrEqual(1.5)
        // Sanity: the oscillator actually oscillates.
        expect(st.max - st.min).toBeGreaterThan(0.5)
      })
    }
  }
})

describe('wrapped flag', () => {
  it('fires ~freq times per second (100 Hz)', () => {
    const v = makeVco(VCO_WAVE.SAW, 100)
    const st = run(v, SR)
    expect(Math.abs(st.wraps - 100)).toBeLessThanOrEqual(1)
  })

  it('fires ~freq times per second (993 Hz, all waves)', () => {
    for (const wave of [VCO_WAVE.SQR, VCO_WAVE.TRI, VCO_WAVE.SAW]) {
      const v = makeVco(wave, 993)
      const st = run(v, SR)
      expect(Math.abs(st.wraps - 993)).toBeLessThanOrEqual(1)
    }
  })

  it('reports a sub-sample wrapFrac in [0, 1)', () => {
    const v = makeVco(VCO_WAVE.SAW, 773.3)
    let seen = 0
    for (let i = 0; i < SR; i++) {
      v.tick()
      if (v.wrapped) {
        seen++
        expect(v.wrapFrac).toBeGreaterThanOrEqual(0)
        expect(v.wrapFrac).toBeLessThan(1)
      }
    }
    expect(seen).toBeGreaterThan(700)
  })
})

describe('SAW shape morph (spec §4: attenuates EVEN harmonics)', () => {
  const F0 = 187.5 // 48000/256: exact integer periods for f0 and 2*f0
  const SETTLE = 4800
  const N = SR // 1 s analysis window = whole number of cycles

  function renderSaw(shape: number): Float32Array {
    const v = makeVco(VCO_WAVE.SAW, F0, shape)
    const buf = new Float32Array(SETTLE + N)
    for (let i = 0; i < buf.length; i++) buf[i] = v.tick()
    return buf
  }

  it('shape=1 is square-like: 2nd-harmonic energy collapses vs shape=0', () => {
    const evenRatio = (buf: Float32Array): number =>
      goertzel(buf, 2 * F0, SETTLE, SETTLE + N) / goertzel(buf, F0, SETTLE, SETTLE + N)
    // pure saw: a2/a1 = 1/2 -> 2f/f power ratio ~0.25
    expect(evenRatio(renderSaw(0))).toBeGreaterThan(0.1)
    // square: even harmonics cancel (tiny residue from the analog-softness LP)
    expect(evenRatio(renderSaw(1))).toBeLessThan(0.01)
  })

  it('keeps ~equal RMS and ~zero DC across the shape sweep', () => {
    for (const shape of [0, 0.25, 0.5, 0.75, 1]) {
      const buf = renderSaw(shape)
      let sum = 0
      let sq = 0
      for (let i = SETTLE; i < buf.length; i++) {
        sum += buf[i]
        sq += buf[i] * buf[i]
      }
      const mean = sum / N
      const rms = Math.sqrt(sq / N)
      expect(Math.abs(mean), `shape ${shape} DC`).toBeLessThan(0.02)
      expect(rms, `shape ${shape} RMS low`).toBeGreaterThan(0.45)
      expect(rms, `shape ${shape} RMS high`).toBeLessThan(0.75)
    }
  })
})

describe('pulse DC removal', () => {
  it('200 Hz pulse at shape = 1 (narrow ~5% pulse) keeps |DC| < 0.02', () => {
    const v = makeVco(VCO_WAVE.SQR, 200, 1)
    const st = run(v, 2 * SR)
    expect(st.finite).toBe(true)
    expect(Math.abs(st.mean)).toBeLessThan(0.02)
  })

  it('DC stays small across the whole shape range', () => {
    for (const shape of [0, 0.25, 0.5, 0.75, 1]) {
      const v = makeVco(VCO_WAVE.SQR, 200, shape)
      const st = run(v, SR)
      expect(Math.abs(st.mean)).toBeLessThan(0.02)
    }
  })
})

describe('hard sync', () => {
  function runSynced(slaveWave: number, seconds: number, slaveShape = 0.5): RunStats {
    const master = makeVco(VCO_WAVE.SAW, 100)
    const slave = makeVco(slaveWave, 370, slaveShape) // 3.7 : 1
    const n = Math.round(seconds * SR)
    let finite = true
    let min = Infinity
    let max = -Infinity
    let sum = 0
    let wraps = 0
    for (let i = 0; i < n; i++) {
      master.tick()
      if (master.wrapped) slave.hardSync(master.wrapFrac)
      const s = slave.tick()
      if (!Number.isFinite(s)) finite = false
      if (s < min) min = s
      if (s > max) max = s
      sum += s
      if (slave.wrapped) wraps++
    }
    return { finite, min, max, mean: sum / n, wraps }
  }

  it('produces bounded, finite output when synced 3.7:1 (all waves)', () => {
    for (const wave of [VCO_WAVE.SQR, VCO_WAVE.TRI, VCO_WAVE.SAW]) {
      const st = runSynced(wave, 1)
      expect(st.finite).toBe(true)
      expect(st.min).toBeGreaterThanOrEqual(-1.5)
      expect(st.max).toBeLessThanOrEqual(1.5)
      expect(st.max - st.min).toBeGreaterThan(0.5)
    }
  })

  it('slave wraps at the expected combined rate (own wraps + sync resets)', () => {
    // Per 10 ms master period the slave runs 3.7 cycles: 3 natural wraps plus
    // the forced sync reset => ~400 wraps/s.
    const st = runSynced(VCO_WAVE.SAW, 1, 0)
    expect(st.wraps).toBeGreaterThanOrEqual(390)
    expect(st.wraps).toBeLessThanOrEqual(410)
  })
})

describe('linear FM safety', () => {
  it('survives huge, NaN and Inf FM inputs', () => {
    const v = makeVco(VCO_WAVE.SAW, 440, 0.7)
    const abuse = [1e15, -1e15, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e9, -1e9]
    let finite = true
    for (let i = 0; i < 4000; i++) {
      const s = v.tick(abuse[i % abuse.length])
      if (!Number.isFinite(s) || s < -1.5 || s > 1.5) finite = false
    }
    expect(finite).toBe(true)
  })

  it('handles negative effective frequency (phase runs backwards, wraps fire)', () => {
    for (const wave of [VCO_WAVE.SQR, VCO_WAVE.TRI, VCO_WAVE.SAW]) {
      const v = makeVco(wave, 440, 0.5)
      const st = run(v, SR, { fm: -2440 }) // effective -2000 Hz
      expect(st.finite).toBe(true)
      expect(st.min).toBeGreaterThanOrEqual(-1.5)
      expect(st.max).toBeLessThanOrEqual(1.5)
      expect(Math.abs(st.wraps - 2000)).toBeLessThanOrEqual(2)
    }
  })

  it('stays bounded under audio-rate FM depth sweeps (cross-mod style)', () => {
    const mod = makeVco(VCO_WAVE.SAW, 1234)
    const car = makeVco(VCO_WAVE.TRI, 440, 1)
    let finite = true
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < SR; i++) {
      const m = mod.tick()
      const s = car.tick(m * 8000)
      if (!Number.isFinite(s)) finite = false
      if (s < min) min = s
      if (s > max) max = s
    }
    expect(finite).toBe(true)
    expect(min).toBeGreaterThanOrEqual(-1.5)
    expect(max).toBeLessThanOrEqual(1.5)
  })
})

describe('parameter changes and reset', () => {
  it('wave switching mid-run stays finite and bounded (crossfaded)', () => {
    const v = makeVco(VCO_WAVE.SAW, 440, 0.6)
    let finite = true
    let min = Infinity
    let max = -Infinity
    const sequence = [VCO_WAVE.SQR, VCO_WAVE.TRI, VCO_WAVE.SAW, VCO_WAVE.SQR]
    for (let i = 0; i < SR; i++) {
      if (i % 6000 === 0) v.setWave(sequence[(i / 6000) % sequence.length])
      const s = v.tick()
      if (!Number.isFinite(s)) finite = false
      if (s < min) min = s
      if (s > max) max = s
    }
    expect(finite).toBe(true)
    expect(min).toBeGreaterThanOrEqual(-1.5)
    expect(max).toBeLessThanOrEqual(1.5)
  })

  it('reset(phase) restarts deterministically', () => {
    const a = makeVco(VCO_WAVE.SAW, 440, 0.3)
    const b = makeVco(VCO_WAVE.SAW, 440, 0.3)
    a.reset(0.25)
    b.reset(0.25)
    for (let i = 0; i < 1000; i++) {
      expect(a.tick()).toBe(b.tick())
    }
  })

  it('clamps setFreq into [0.01, sr*0.45] without blowing up', () => {
    const v = makeVco(VCO_WAVE.SAW, 440)
    v.setFreq(1e9)
    v.reset()
    const hi = run(v, 4800)
    expect(hi.finite).toBe(true)
    v.setFreq(-50)
    v.reset()
    const lo = run(v, 4800)
    expect(lo.finite).toBe(true)
    expect(lo.wraps).toBe(0) // 0.01 Hz: no wrap within 0.1 s
  })
})
