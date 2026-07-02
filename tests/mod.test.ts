import { describe, it, expect } from 'vitest'
import { AdsrEg, AdEg } from '../src/dsp/eg'
import { Lfo, LFO_WAVE, LFO_MODE } from '../src/dsp/lfo'
import { Drift } from '../src/dsp/drift'

const SR = 48000
const secs = (s: number) => Math.round(s * SR)

function run(env: { tick(): number }, n: number): number {
  let v = 0
  for (let i = 0; i < n; i++) v = env.tick()
  return v
}

describe('AdsrEg', () => {
  it('reaches >= 0.99 within attack time +20%', () => {
    const eg = new AdsrEg(SR)
    eg.setAttack(0.1)
    eg.setDecay(1)
    eg.setSustain(1)
    eg.setRelease(0.1)
    eg.gateOn()
    let max = 0
    for (let i = 0; i < secs(0.12); i++) max = Math.max(max, eg.tick())
    expect(max).toBeGreaterThanOrEqual(0.99)
  })

  it('decays to sustain +/- 0.02', () => {
    const eg = new AdsrEg(SR)
    eg.setAttack(0.002)
    eg.setDecay(0.05)
    eg.setSustain(0.6)
    eg.setRelease(0.1)
    eg.gateOn()
    const v = run(eg, secs(0.002 + 0.05 * 2.5))
    expect(Math.abs(v - 0.6)).toBeLessThanOrEqual(0.02)
  })

  it('releases to inactive at 0', () => {
    const eg = new AdsrEg(SR)
    eg.setAttack(0.002)
    eg.setDecay(0.02)
    eg.setSustain(0.6)
    eg.setRelease(0.05)
    eg.gateOn()
    run(eg, secs(0.1))
    eg.gateOff()
    run(eg, secs(0.05 * 3.5))
    expect(eg.active).toBe(false)
    expect(eg.level).toBe(0)
  })

  it('legato gateOn(false) does not reset or restart the envelope', () => {
    const eg = new AdsrEg(SR)
    eg.setAttack(0.1)
    eg.setDecay(0.05)
    eg.setSustain(0.5)
    eg.setRelease(0.1)
    eg.gateOn()
    run(eg, secs(0.4)) // settled at sustain
    expect(Math.abs(eg.level - 0.5)).toBeLessThan(0.01)
    eg.gateOn(false) // legato: stay in sustain
    const v = run(eg, secs(0.05))
    expect(Math.abs(v - 0.5)).toBeLessThan(0.01)
    // contrast: retrigger=true re-enters attack and rises above sustain
    eg.gateOn(true)
    const v2 = run(eg, secs(0.02))
    expect(v2).toBeGreaterThan(0.55)
  })

  it('gateOn during release restarts attack from the current level (no click)', () => {
    const eg = new AdsrEg(SR)
    eg.setAttack(0.05)
    eg.setDecay(0.05)
    eg.setSustain(0.8)
    eg.setRelease(0.2)
    eg.gateOn()
    run(eg, secs(0.3))
    eg.gateOff()
    const during = run(eg, secs(0.05)) // partway down the release
    expect(during).toBeGreaterThan(0.1)
    expect(during).toBeLessThan(0.8)
    eg.gateOn()
    const next = eg.tick()
    expect(Math.abs(next - during)).toBeLessThan(0.01) // continuous
    const later = run(eg, secs(0.05))
    expect(later).toBeGreaterThan(during) // rising again
  })

  it('kill() reaches 0 in under 3 ms', () => {
    const eg = new AdsrEg(SR)
    eg.setAttack(0.001)
    eg.setSustain(1)
    eg.gateOn()
    run(eg, secs(0.01)) // fully up at 1.0
    expect(eg.level).toBeGreaterThan(0.99)
    eg.kill()
    run(eg, Math.ceil(0.003 * SR))
    expect(eg.level).toBe(0)
    expect(eg.active).toBe(false)
  })

  it('mid-segment time changes are click-free', () => {
    const eg = new AdsrEg(SR)
    eg.setAttack(0.5)
    eg.setSustain(1)
    eg.gateOn()
    const before = run(eg, secs(0.1))
    eg.setAttack(0.01) // much faster now
    const after = eg.tick()
    expect(Math.abs(after - before)).toBeLessThan(0.05) // no jump
    run(eg, secs(0.02))
    expect(eg.level).toBeGreaterThan(0.99) // and it finishes fast
  })
})

describe('AdEg', () => {
  it('completes a full attack-decay cycle without gateOff', () => {
    const eg = new AdEg(SR)
    eg.setAttack(0.01)
    eg.setDecay(0.05)
    eg.gateOn()
    let max = 0
    let v = 0
    for (let i = 0; i < secs(0.01 + 0.05 * 3.5); i++) {
      v = eg.tick()
      max = Math.max(max, v)
    }
    expect(max).toBeGreaterThanOrEqual(0.99)
    expect(v).toBe(0)
    expect(eg.active).toBe(false)
  })

  it('gateOff is a no-op (envelope keeps running)', () => {
    const eg = new AdEg(SR)
    eg.setAttack(0.05)
    eg.setDecay(0.1)
    eg.gateOn()
    run(eg, secs(0.01))
    eg.gateOff()
    const v = run(eg, secs(0.01))
    expect(eg.active).toBe(true)
    expect(v).toBeGreaterThan(0.1) // still rising through attack
  })
})

describe('Lfo', () => {
  it('one-shot stops after a HALF cycle and holds the phase-0.5 value', () => {
    // TRI: 0 -> +1 (phase 0.25) -> 0 (phase 0.5), then frozen at 0.
    // A full cycle would swing to -1; a half cycle never goes negative.
    const tri = new Lfo(SR)
    tri.setWave(LFO_WAVE.TRI)
    tri.setFreq(2) // half-cycle = 0.25 s
    tri.setMode(LFO_MODE.ONE_SHOT)
    expect(tri.tick()).toBe(0) // armed but silent before trigger
    tri.trigger()
    let max = -Infinity
    let min = Infinity
    for (let i = 0; i < secs(0.5); i++) {
      const v = tri.tick()
      if (v > max) max = v
      if (v < min) min = v
    }
    expect(max).toBeGreaterThan(0.9) // the rise to +1 actually happened
    expect(min).toBeGreaterThanOrEqual(-1e-6) // never entered the second half
    expect(tri.phase).toBe(0.5) // phase frozen at the half-cycle point
    for (let i = 0; i < 1000; i++) expect(Math.abs(tri.tick())).toBeLessThanOrEqual(1e-6)

    // SQR: high for the half cycle, then transitions low and holds -1 (not 0).
    const sqr = new Lfo(SR)
    sqr.setWave(LFO_WAVE.SQR)
    sqr.setFreq(2)
    sqr.setMode(LFO_MODE.ONE_SHOT)
    sqr.trigger()
    const mid = run(sqr, secs(0.1)) // inside the half cycle, slew settled
    expect(mid).toBe(1)
    run(sqr, secs(0.2)) // well past 0.25 s (+ slew settle)
    expect(sqr.phase).toBe(0.5)
    for (let i = 0; i < 1000; i++) expect(Math.abs(sqr.tick() + 1)).toBeLessThanOrEqual(1e-6)

    // SAW: falls +1 -> 0 over the half cycle, then holds its mid-fall value 0.
    const saw = new Lfo(SR)
    saw.setWave(LFO_WAVE.SAW)
    saw.setFreq(2)
    saw.setMode(LFO_MODE.ONE_SHOT)
    saw.trigger()
    let sMin = Infinity
    for (let i = 0; i < secs(0.5); i++) sMin = Math.min(sMin, saw.tick())
    expect(sMin).toBeGreaterThanOrEqual(-1e-6) // full cycle would have hit -1
    for (let i = 0; i < 1000; i++) expect(Math.abs(saw.tick())).toBeLessThanOrEqual(1e-6)
  })

  it('frequency is accurate to +/-2% (zero crossings over 10 s at 2 Hz)', () => {
    const lfo = new Lfo(SR)
    lfo.setWave(LFO_WAVE.TRI)
    lfo.setFreq(2)
    lfo.setMode(LFO_MODE.NORMAL)
    lfo.trigger()
    let prev = lfo.tick()
    let count = 0
    let firstIdx = -1
    let lastIdx = -1
    const n = secs(10)
    for (let i = 1; i < n; i++) {
      const v = lfo.tick()
      if (prev < 0 && v >= 0) {
        if (firstIdx < 0) firstIdx = i
        lastIdx = i
        count++
      }
      prev = v
    }
    expect(count).toBeGreaterThan(2)
    const freq = (count - 1) / ((lastIdx - firstIdx) / SR)
    expect(Math.abs(freq - 2) / 2).toBeLessThanOrEqual(0.02)
  })

  it('SQR starts high, SAW is a falling ramp, TRI starts at 0 rising', () => {
    const sqr = new Lfo(SR)
    sqr.setWave(LFO_WAVE.SQR)
    sqr.setFreq(2)
    sqr.trigger()
    const sq = run(sqr, secs(0.002)) // after slew settles
    expect(sq).toBe(1)

    const saw = new Lfo(SR)
    saw.setWave(LFO_WAVE.SAW)
    saw.setFreq(2)
    saw.trigger()
    run(saw, secs(0.002))
    expect(saw.tick()).toBeGreaterThan(0.9) // starts near +1
    const sv = run(saw, secs(0.1)) // t ~= 0.1s, phase ~0.2 -> 1 - 0.4
    expect(Math.abs(sv - 0.6)).toBeLessThan(0.02) // falling

    const tri = new Lfo(SR)
    tri.setWave(LFO_WAVE.TRI)
    tri.setFreq(2)
    tri.trigger()
    expect(Math.abs(tri.tick())).toBeLessThan(0.01) // starts at 0
    const tv = run(tri, secs(0.05)) // phase 0.1 -> 0.4, rising
    expect(Math.abs(tv - 0.4)).toBeLessThan(0.02)
  })

  it('square edges are slewed (no single-sample jumps)', () => {
    const lfo = new Lfo(SR)
    lfo.setWave(LFO_WAVE.SQR)
    lfo.setFreq(5)
    lfo.trigger()
    let prev = lfo.tick()
    let maxJump = 0
    for (let i = 0; i < secs(1); i++) {
      const v = lfo.tick()
      maxJump = Math.max(maxJump, Math.abs(v - prev))
      prev = v
    }
    expect(maxJump).toBeLessThanOrEqual(2 / (0.001 * SR) + 1e-12)
  })
})

describe('Drift', () => {
  it('stays within +/-6 cents over 30 s', () => {
    const d = new Drift(SR, 12345)
    d.noteOn()
    let maxAbs = 0
    for (let i = 0; i < secs(30); i++) maxAbs = Math.max(maxAbs, Math.abs(d.tick()))
    expect(maxAbs).toBeLessThanOrEqual(6)
    expect(maxAbs).toBeGreaterThan(0.05) // it actually drifts
  })

  it('is deterministic for equal seeds', () => {
    const a = new Drift(SR, 999)
    const b = new Drift(SR, 999)
    a.noteOn()
    b.noteOn()
    for (let i = 0; i < secs(2); i++) expect(a.tick()).toBe(b.tick())
  })

  it('differs for different seeds and per noteOn', () => {
    const a = new Drift(SR, 1)
    const b = new Drift(SR, 2)
    a.noteOn()
    b.noteOn()
    let diff = 0
    for (let i = 0; i < secs(1); i++) diff += Math.abs(a.tick() - b.tick())
    expect(diff).toBeGreaterThan(0)

    const c = new Drift(SR, 7)
    c.noteOn()
    const v1 = c.tick()
    c.noteOn() // new note -> new persistent offset
    const v2 = c.tick()
    expect(v1).not.toBe(v2)
  })
})
