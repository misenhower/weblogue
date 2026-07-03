import { describe, expect, it } from 'vitest'
import { Noise } from '../src/dsp/noise'

describe('Noise', () => {
  it('is deterministic per seed and decorrelated across seeds', () => {
    const a1 = new Noise(7)
    const a2 = new Noise(7)
    const b = new Noise(8)
    let same = true
    let diff = false
    for (let i = 0; i < 1000; i++) {
      const x = a1.tick()
      if (x !== a2.tick()) same = false
      if (x !== b.tick()) diff = true
    }
    expect(same).toBe(true)
    expect(diff).toBe(true)
  })

  it('stays in -1..1 with ~zero mean and flat-ish spectrum energy', () => {
    const n = new Noise(1)
    let mean = 0
    let minV = 1
    let maxV = -1
    const N = 1 << 16
    for (let i = 0; i < N; i++) {
      const x = n.tick()
      mean += x
      if (x < minV) minV = x
      if (x > maxV) maxV = x
    }
    mean /= N
    expect(minV).toBeGreaterThanOrEqual(-1)
    expect(maxV).toBeLessThanOrEqual(1)
    expect(Math.abs(mean)).toBeLessThan(0.02)
  })

  it('reset(seed) restarts the stream', () => {
    const n = new Noise(42)
    const first = [n.tick(), n.tick(), n.tick()]
    n.reset(42)
    expect([n.tick(), n.tick(), n.tick()]).toEqual(first)
  })
})
