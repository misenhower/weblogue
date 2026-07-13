/*
 * Measured EG fall model (D5, 2026-07-12): the xd's decay/release run a
 * CONSTANT-RATE LINEAR phase raised to p = 3, reaching true zero at the
 * table time T. setFallPower(3) must reproduce (1 - t/T)^3 exactly and hit
 * REAL zero at T; setFallPower(null) must remain the legacy one-pole
 * exponential (og/mono/prologue and xd v0-v4 depend on it bit-identically).
 */
import { describe, it, expect } from 'vitest'
import { AdsrEg, AdEg } from '../src/dsp/eg'

const SR = 48000

function riseToFull(eg: AdsrEg | AdEg): void {
  eg.gateOn()
  for (let i = 0; i < SR; i++) {
    if (eg.tick() >= 1) return
  }
  throw new Error('attack never completed')
}

describe('legacy exponential path (setFallPower null)', () => {
  it('release stays the exact one-pole recurrence and snaps at -80 dB', () => {
    const eg = new AdsrEg(SR)
    eg.setAttack(0.0005)
    eg.setSustain(1)
    eg.setRelease(0.5)
    riseToFull(eg)
    eg.gateOff()
    const coef = 1 - Math.exp(-1 / ((0.5 / 3) * SR))
    let expected = 1
    for (let i = 0; i < SR; i++) {
      const v = eg.tick()
      expected -= coef * expected
      if (expected < 1e-4) {
        expect(v).toBe(0)
        return
      }
      expect(v).toBe(expected)
    }
  })

  it('switching to the measured model and back leaves the level continuous', () => {
    const eg = new AdsrEg(SR)
    eg.setAttack(0.0005)
    eg.setSustain(1)
    eg.setRelease(1.0)
    riseToFull(eg)
    eg.gateOff()
    for (let i = 0; i < 4800; i++) eg.tick()
    const before = eg.level
    eg.setFallPower(3)
    const after = eg.tick()
    expect(Math.abs(after - before)).toBeLessThan(1e-3)
  })
})

describe('measured cubic fall (setFallPower 3)', () => {
  it('release follows (1 - t/T)^3 and reaches TRUE zero at T', () => {
    const T = 0.5
    const eg = new AdsrEg(SR)
    eg.setFallPower(3)
    eg.setAttack(0.0005)
    eg.setSustain(1)
    eg.setRelease(T)
    riseToFull(eg)
    eg.gateOff()
    const n = Math.round(T * SR)
    for (let i = 1; i <= n + 10; i++) {
      const v = eg.tick()
      const ph = 1 - i / (T * SR)
      if (ph <= 0) {
        expect(v).toBe(0)
      } else {
        expect(Math.abs(v - ph * ph * ph)).toBeLessThan(1e-9)
      }
    }
    expect(eg.active).toBe(false) // finite-time silence, unlike the exponential
  })

  it('decay settles at EXACTLY the sustain level via the phase ramp', () => {
    const eg = new AdsrEg(SR)
    eg.setFallPower(3)
    eg.setAttack(0.0005)
    eg.setSustain(0.125) // phase target 0.5
    eg.setDecay(0.1)
    riseToFull(eg)
    // full-scale fall time 0.1 s at constant rate: phase 1 -> 0.5 in 0.05 s
    for (let i = 0; i < Math.round(0.05 * SR) + 5; i++) eg.tick()
    expect(eg.level).toBeCloseTo(0.125, 9)
    for (let i = 0; i < 100; i++) eg.tick()
    expect(eg.level).toBeCloseTo(0.125, 9) // holds the rail
  })

  it('mod EG decay reaches zero at T and goes idle', () => {
    const T = 0.2
    const eg = new AdEg(SR)
    eg.setFallPower(3)
    eg.setAttack(0.0005)
    eg.setDecay(T)
    riseToFull(eg)
    const mid = Math.round(0.5 * T * SR)
    for (let i = 0; i < mid; i++) eg.tick()
    expect(eg.tick()).toBeCloseTo(0.125, 2) // (1 - 0.5)^3
    for (let i = 0; i < Math.round(0.6 * T * SR); i++) eg.tick()
    expect(eg.active).toBe(false)
  })

  it('retrigger during the cubic release restarts the attack from the current level', () => {
    const eg = new AdsrEg(SR)
    eg.setFallPower(3)
    eg.setAttack(0.5)
    eg.setSustain(1)
    eg.setRelease(1.0)
    riseToFull(eg)
    eg.gateOff()
    for (let i = 0; i < Math.round(0.5 * SR); i++) eg.tick()
    const atRetrigger = eg.level
    expect(atRetrigger).toBeGreaterThan(0.05)
    eg.gateOn()
    const v = eg.tick()
    expect(v).toBeGreaterThanOrEqual(atRetrigger) // rising, no reset to zero
    expect(Math.abs(v - atRetrigger)).toBeLessThan(1e-3) // and no click
  })
})
