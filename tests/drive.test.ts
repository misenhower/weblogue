/*
 * Drive (dsp/drive.ts) — the monologue's continuous post-VCA overdrive
 * (docs/monologue-spec.md §7): identity-ish at amount 0, bounded odd-harmonic
 * saturation when cranked, level roughly flat (no excessive boost [SoS]),
 * click-free amount smoothing, junk-proof.
 */
import { describe, expect, it } from 'vitest'
import { Drive } from '../src/dsp/drive'
import { MONO_DRIVE_CFG } from '../src/synths/mono/curves'
import { goertzel, rms, SR } from './helpers/audio'

function renderSine(d: Drive, amp: number, freqHz: number, n: number): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = d.tick(amp * Math.sin((2 * Math.PI * freqHz * i) / SR))
  }
  return out
}

describe('Drive', () => {
  it('amount 0 is ~identity for small signals', () => {
    const d = new Drive(SR, MONO_DRIVE_CFG)
    d.setAmount(0)
    d.reset()
    let maxErr = 0
    for (let i = 0; i < 4800; i++) {
      const x = 0.1 * Math.sin((2 * Math.PI * 220 * i) / SR)
      maxErr = Math.max(maxErr, Math.abs(d.tick(x) - x))
    }
    expect(maxErr).toBeLessThan(5e-4) // fastTanh(x) ~ x for |x| <= 0.1
  })

  it('full amount saturates: bounded, odd harmonics, no even harmonics', () => {
    const d = new Drive(SR, MONO_DRIVE_CFG)
    d.setAmount(1)
    d.reset()
    // 750 Hz is an exact bin over 0.1 s at 48 kHz (75 cycles).
    const out = renderSine(d, 0.9, 750, 4800)
    let peak = 0
    for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]))
    expect(peak).toBeLessThanOrEqual(1) // makeup pins the saturated peak
    const p1 = goertzel(out, 750)
    const p2 = goertzel(out, 1500)
    const p3 = goertzel(out, 2250)
    expect(p3).toBeGreaterThan(0.01) // strong 3rd harmonic (near-square wave)
    expect(p2).toBeLessThan(p3 * 1e-3) // odd-symmetric shaper: no evens
    expect(p1).toBeGreaterThan(p3) // fundamental still dominates
  })

  it('never excessively boosts volume: driven level within ~3 dB of clean', () => {
    const clean = new Drive(SR, MONO_DRIVE_CFG)
    clean.setAmount(0)
    clean.reset()
    const driven = new Drive(SR, MONO_DRIVE_CFG)
    driven.setAmount(1)
    driven.reset()
    const a = rms(renderSine(clean, 0.9, 750, 4800))
    const b = rms(renderSine(driven, 0.9, 750, 4800))
    expect(b).toBeLessThan(a * 1.5) // < +3.5 dB
    expect(b).toBeGreaterThan(a * 0.7) // > -3 dB
  })

  it('produces no NaN on junk input or junk amount', () => {
    const d = new Drive(SR, MONO_DRIVE_CFG)
    d.setAmount(NaN) // ignored
    d.setAmount(5) // clamped to 1
    d.reset()
    expect(Number.isFinite(d.tick(NaN))).toBe(true)
    expect(Number.isFinite(d.tick(Infinity))).toBe(true)
    expect(Number.isFinite(d.tick(-Infinity))).toBe(true)
    for (let i = 0; i < 100; i++) {
      const y = d.tick(Math.sin(i * 0.3))
      expect(Number.isFinite(y)).toBe(true)
      expect(Math.abs(y)).toBeLessThanOrEqual(1)
    }
  })

  it('smooths amount changes (~5 ms one-pole): no step click', () => {
    const d = new Drive(SR, MONO_DRIVE_CFG)
    d.setAmount(0)
    d.reset()
    const n = Math.round(SR * 0.15)
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      if (i === 100) d.setAmount(1) // knob slam mid-render
      out[i] = d.tick(0.5) // DC probe makes any step visible
    }
    // Settled endpoints: fastTanh(0.5) before, makeup * fastTanh(0.5*gainMax) after.
    expect(out[99]).toBeCloseTo(0.4658, 3)
    expect(out[n - 1]).toBeGreaterThan(0.7)
    expect(out[n - 1]).toBeLessThan(0.85)
    // The ~0.3 jump must be spread out: an unsmoothed slam would step the
    // full 0.3 in one sample; the 5 ms one-pole keeps each step ~0.01.
    let maxDelta = 0
    for (let i = 100; i < n; i++) maxDelta = Math.max(maxDelta, Math.abs(out[i] - out[i - 1]))
    expect(maxDelta).toBeLessThan(0.02)
    expect(out[300]).toBeGreaterThan(out[99]) // actually moving toward the target
  })
})
