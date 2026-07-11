/*
 * UI scope trigger (src/ui/scopetrigger.ts): must pick the SAME crossing
 * class every frame on waves with several rising zero crossings per cycle
 * (sync ramps, ring products, period-doubled SHAPE teeth) — the old
 * first-crossing rule made the service-mode VCO2 trace jump between
 * alignments and look mangled.
 */
import { describe, it, expect } from 'vitest'
import { scopeTrigger, ScopeLock } from '../src/ui/scopetrigger'

const SR = 48000

/** Alternating tall/short saw teeth at 110 Hz (true period 2T = 55 Hz). */
function altSaw(n: number, phase0 = 0): Float32Array {
  const tooth = SR / 110
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = (i + phase0) / tooth
    const k = Math.floor(t)
    const a = k % 2 === 0 ? 1.0 : 0.35
    out[i] = a * (2 * (t - k) - 1)
  }
  return out
}

describe('scopeTrigger', () => {
  it('locks the same crossing class as the frame phase scrolls (full-span search, tap-sized buffer)', () => {
    const tooth = SR / 110
    const N = 1280 // DBG_TAP_SIZE — a doubled 110 Hz period (873) fits once
    const values: number[] = []
    for (const off of [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5]) {
      const x = altSaw(N, off * tooth)
      const trig = scopeTrigger(x, 1, N - 1, N >> 1)
      // the sample a quarter tooth later identifies which tooth was locked
      values.push(x[Math.min(N - 1, trig + Math.round(tooth / 4))])
    }
    for (const v of values.slice(1)) {
      expect(Math.abs(v - values[0])).toBeLessThan(0.08)
    }
  })

  it('falls back when the window has no rising crossing', () => {
    const dc = new Float32Array(1024).fill(0.4)
    expect(scopeTrigger(dc, 128, 896, -1)).toBe(-1)
    const silent = new Float32Array(1024)
    expect(scopeTrigger(silent, 128, 896, 512)).toBe(512)
  })

  it('still triggers a plain sine at its rising crossing', () => {
    const x = new Float32Array(2048)
    for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * 220 * i) / SR)
    const trig = scopeTrigger(x, 256, 1793, -1)
    expect(trig).toBeGreaterThan(0)
    expect(Math.abs(x[trig])).toBeLessThan(0.05)
    expect(x[trig + 3]).toBeGreaterThan(x[trig])
  })
})

describe('ScopeLock (frame-coherent trigger)', () => {
  it('holds one crossing class across scrolling frames, freezing when the class is undisplayable', () => {
    const lock = new ScopeLock()
    const n = 1280
    const win = 512
    const half = 256
    const tooth = SR / 110
    const views: number[] = []
    let frozen = 0
    for (let f = 0; f < 40; f++) {
      const x = altSaw(n, f * 0.37 * tooth)
      const pick = lock.pick(x, half, n - win + half + 1, half, win, (n - win) >> 1)
      if (pick.frozen) {
        frozen++
        continue
      }
      // identify the locked class by the value a quarter tooth after start+half
      views.push(x[pick.start + half + Math.round(tooth / 4)])
    }
    expect(views.length).toBeGreaterThan(25)
    for (const v of views.slice(1)) expect(Math.abs(v - views[0])).toBeLessThan(0.1)
    expect(frozen).toBeLessThan(15)
  })
})
