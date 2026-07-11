/*
 * Regression: RING of two hard-synced same-pitch saws is essentially saw² —
 * a waveform with a large positive mean. That DC is real (the hardware's
 * ring product has it too), but the real xd AC-couples the analog voice bus
 * into its FX ADC, so its digital FX never see it. Without that coupling the
 * replica fed ~+0.5 DC into the reverb, whose FDN loop (damping is a lowpass
 * — DC circulates freely, Hadamard has a +1 eigenvalue) amplified it ~5x,
 * and the output limiter flattened everything: scope pinned at +1, audio
 * gone ("Replicant xd" 4-note chord, present since day 1).
 */
import { describe, it, expect } from 'vitest'
import { Engine } from '../src/synths/xd/engine'
import { initProgram } from '../src/synths/xd/program'
import { P } from '../src/synths/xd/params'
import { renderEngine, rms, SR } from './helpers/audio'

function ringSyncReverbEngine(): Engine {
  const e = new Engine(SR)
  const prog = initProgram()
  const set = (id: number, v: number): void => {
    prog.params[id] = v
  }
  // the load-bearing pattern from the preset: both saws, SYNC + RING,
  // low cutoff (passes DC, attenuates the audible band), SMOOTH reverb long
  set(P.VCO1_WAVE, 2)
  set(P.VCO2_WAVE, 2)
  set(P.VCO1_LEVEL, 1023)
  set(P.VCO2_LEVEL, 1023)
  set(P.SYNC, 1)
  set(P.RING, 1)
  set(P.CUTOFF, 302)
  set(P.AMP_ATTACK, 0)
  set(P.AMP_SUSTAIN, 1023)
  set(P.REVERB_ON, 1)
  set(P.REVERB_SUB, 1) // SMOOTH
  set(P.REVERB_TIME, 1023)
  set(P.REVERB_DEPTH, 1023)
  set(P.REVERB_DRYWET, 511)
  e.loadProgram(prog)
  return e
}

describe('DC blocking at the FX bus (hardware AC-coupling)', () => {
  it('ring+sync saws through SMOOTH reverb must not rail to DC', () => {
    const e = ringSyncReverbEngine()
    for (const n of [60, 64, 67, 71]) e.noteOn(n, 100)
    const out = renderEngine(e, 4)
    // late window, long past the reverb build-up
    const from = Math.round(3 * SR)
    let mean = 0
    for (let i = from; i < out.length; i++) mean += out[i]
    mean /= out.length - from
    const total = rms(out, from)
    const ac = Math.sqrt(Math.max(0, total * total - mean * mean))
    // the bug: mean -> +1.0 and ac -> 0. Fixed: DC negligible, audio alive.
    expect(Math.abs(mean)).toBeLessThan(0.05)
    expect(ac).toBeGreaterThan(0.02)
  })

  it('sustained held chord stays DC-free even with reverb off (dry bus is coupled too)', () => {
    const e = ringSyncReverbEngine()
    e.setParam(P.REVERB_ON, 0)
    for (const n of [60, 64, 67, 71]) e.noteOn(n, 100)
    const out = renderEngine(e, 2)
    const from = Math.round(1 * SR)
    let mean = 0
    for (let i = from; i < out.length; i++) mean += out[i]
    mean /= out.length - from
    expect(Math.abs(mean)).toBeLessThan(0.05)
  })
})
