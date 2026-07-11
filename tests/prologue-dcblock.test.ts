/*
 * Regression (the xd "Replicant" bug class, tests/xd-dcblock.test.ts): RING
 * of two same-pitch saws is essentially saw² — a large positive mean. The
 * prologue's SYNC/RING switch is exclusive (no hard sync under RING), so the
 * phase lock rests on both VCOs starting in phase and drifting apart only by
 * the analog-drift cents; at C2 that is ~0.15 Hz of relative drift, keeping
 * the ring product coherent (and its DC large) through the whole render.
 *
 * The prologue composes per-timbre MAIN/SUB stereo buses inside processFx —
 * on the hardware each bus is an analog voice sum AC-coupled into the FX
 * ADC, so the coupling belongs to each bus channel where it enters the FX.
 * Without it a LAYER patch fed ~+0.5 DC into the reverb, whose FDN loop
 * (damping is a lowpass — DC circulates freely) amplified it several-fold
 * and the output limiter flattened the mix, exactly like the xd bug.
 */
import { describe, it, expect } from 'vitest'
import { Engine } from '../src/synths/prologue/engine'
import { initProgram } from '../src/synths/prologue/program'
import { P, TIMBRE_BLOCKS } from '../src/synths/prologue/params'
import { renderEngine, rms, SR } from './helpers/audio'

function ringReverbEngine(): Engine {
  const e = new Engine(SR, 16)
  const prog = initProgram()
  const set = (id: number, v: number): void => {
    prog.params[id] = v
  }
  // LAYER both timbres so BOTH buses carry the ring DC into the shared FX.
  set(P.SUB_ON, 1)
  set(P.TIMBRE_TYPE, 0) // LAYER
  for (const T of TIMBRE_BLOCKS) {
    set(T.vco1Wave, 2)
    set(T.vco2Wave, 2)
    set(T.vco1Level, 1023)
    set(T.vco2Level, 1023)
    set(T.syncRing, 0) // RING (exclusive 3-way switch)
    set(T.cutoff, 302) // passes DC, attenuates the audible band
    set(T.ampAttack, 0)
    set(T.ampSustain, 1023)
  }
  set(P.DLRV_SELECT, 2) // REVERB
  set(P.DLRV_ON, 1)
  set(P.REVERB_SUB, 1) // SMOOTH
  set(P.DLRV_TIME, 1023)
  set(P.DLRV_DEPTH, 1023)
  set(P.DLRV_DRYWET, 511)
  set(P.DLRV_ROUTING, 0) // Main+Sub
  e.loadProgram(prog)
  return e
}

describe('DC blocking at the FX buses (hardware AC-coupling, prologue)', () => {
  it('layered ring saws through SMOOTH reverb must not rail to DC', () => {
    const e = ringReverbEngine()
    for (const n of [36, 40, 43, 47]) e.noteOn(n, 100) // C2 chord, 8 voices layered
    const out = renderEngine(e, 4)
    // late window, long past the reverb build-up
    const from = Math.round(3 * SR)
    let mean = 0
    for (let i = from; i < out.length; i++) mean += out[i]
    mean /= out.length - from
    const total = rms(out, from)
    const ac = Math.sqrt(Math.max(0, total * total - mean * mean))
    // the bug: the FDN pumps the bus DC into the limiter and the mix
    // flattens. Fixed: DC negligible, audio alive.
    expect(Math.abs(mean)).toBeLessThan(0.05)
    expect(ac).toBeGreaterThan(0.02)
  })

  it('held layer stays DC-free with the FX off (both timbre buses are coupled)', () => {
    const e = ringReverbEngine()
    e.setParam(P.DLRV_ON, 0)
    for (const n of [36, 40, 43, 47]) e.noteOn(n, 100)
    const out = renderEngine(e, 2)
    const from = Math.round(1 * SR)
    let mean = 0
    for (let i = from; i < out.length; i++) mean += out[i]
    mean /= out.length - from
    expect(Math.abs(mean)).toBeLessThan(0.05)
  })
})
