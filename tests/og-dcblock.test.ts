/*
 * Regression (the xd "Replicant" bug class, tests/xd-dcblock.test.ts): RING
 * of two hard-synced same-pitch saws is essentially saw² — a waveform with a
 * large positive mean. The OG has the same SYNC+RING switches as the xd, and
 * the real OG AC-couples its analog voice bus into the delay board's ADC, so
 * the digital FX never see that DC. Without the coupling the replica parked
 * ~+0.34 of DC on the output: the delay loop's own HPF (>= 10 Hz) keeps the
 * LOOP from running away, but the dry bus carries the pedestal straight
 * toward the output limiter's knee (|0.7|), biasing the waveform and eating
 * half the headroom.
 */
import { describe, it, expect } from 'vitest'
import { Engine } from '../src/synths/og/engine'
import { initProgram } from '../src/synths/og/program'
import { P } from '../src/synths/og/params'
import { renderEngine, rms, SR } from './helpers/audio'

function ringSyncDelayEngine(): Engine {
  const e = new Engine(SR)
  const prog = initProgram()
  const set = (id: number, v: number): void => {
    prog.params[id] = v
  }
  // the load-bearing pattern: both saws, SYNC + RING, low cutoff (passes DC,
  // attenuates the audible band), delay engaged with a hot feedback loop
  set(P.VCO1_WAVE, 2)
  set(P.VCO2_WAVE, 2)
  set(P.VCO1_LEVEL, 1023)
  set(P.VCO2_LEVEL, 1023)
  set(P.SYNC, 1)
  set(P.RING, 1)
  set(P.CUTOFF, 302)
  set(P.AMP_ATTACK, 0)
  set(P.AMP_SUSTAIN, 1023)
  set(P.DELAY_ROUTING, 1) // PRE FILTER: delay on, HPF on the wet only
  set(P.DELAY_TIME, 700)
  set(P.DELAY_FEEDBACK, 900)
  set(P.DELAY_HIPASS, 0)
  e.loadProgram(prog)
  return e
}

describe('DC blocking at the FX bus (hardware AC-coupling, OG)', () => {
  it('ring+sync saws with the delay engaged must not sit on a DC pedestal', () => {
    const e = ringSyncDelayEngine()
    for (const n of [60, 64, 67, 71]) e.noteOn(n, 100)
    const out = renderEngine(e, 3)
    // late window, long past the delay build-up
    const from = Math.round(2 * SR)
    let mean = 0
    for (let i = from; i < out.length; i++) mean += out[i]
    mean /= out.length - from
    const total = rms(out, from)
    const ac = Math.sqrt(Math.max(0, total * total - mean * mean))
    // the bug: mean ~ +0.34, a hard pedestal biasing the limiter. Fixed: DC
    // negligible. The ac bound is a liveness check only (the OG's failure
    // mode is the pedestal, not a flattened mix — its delay cannot pump DC
    // the way the xd's reverb does).
    expect(Math.abs(mean)).toBeLessThan(0.05)
    expect(ac).toBeGreaterThan(0.008)
  })

  it('sustained held chord stays DC-free with the delay bypassed (dry bus is coupled too)', () => {
    const e = ringSyncDelayEngine()
    e.setParam(P.DELAY_ROUTING, 0) // BYPASS: the FX block is an exact identity
    for (const n of [60, 64, 67, 71]) e.noteOn(n, 100)
    const out = renderEngine(e, 2)
    const from = Math.round(1 * SR)
    let mean = 0
    for (let i = from; i < out.length; i++) mean += out[i]
    mean /= out.length - from
    expect(Math.abs(mean)).toBeLessThan(0.05)
  })
})
