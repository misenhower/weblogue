import { describe, expect, it } from 'vitest'
import { fftMag } from '../src/ui/fft'

describe('fftMag', () => {
  it('peaks at the sine frequency bin with near-unity magnitude', () => {
    const n = 1024
    const data = new Float32Array(n)
    const bin = 64 // exact bin -> no leakage ambiguity
    for (let i = 0; i < n; i++) data[i] = Math.sin((2 * Math.PI * bin * i) / n)
    const mag = fftMag(data)
    let peak = 0
    for (let i = 1; i < mag.length; i++) if (mag[i] > mag[peak]) peak = i
    expect(peak).toBe(bin)
    expect(mag[peak]).toBeGreaterThan(0.7)
    expect(mag[peak]).toBeLessThan(1.3)
    // Far-away bins are dark (Hann sidelobes are way down).
    expect(mag[bin * 3]).toBeLessThan(0.01)
  })

  it('uses the largest power of two that fits (1280 -> 1024)', () => {
    const mag = fftMag(new Float32Array(1280))
    expect(mag.length).toBe(512)
    expect(mag.every((v) => v === 0)).toBe(true)
  })

  it('DC input lands in bin 0, not the AC bins', () => {
    const data = new Float32Array(256).fill(0.5)
    const mag = fftMag(data)
    expect(mag[0]).toBeGreaterThan(0.2)
    expect(mag[8]).toBeLessThan(0.02)
  })
})
