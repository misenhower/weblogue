/*
 * Audit record for the xd "Replicant" DC bug class (tests/xd-dcblock.test.ts):
 * the monologue HAS the DC source — RING of two same-pitch saws is saw², mean
 * ≈ +1/3 x RING_GAIN — but NO digital FX of any kind (spec §1): processFx is
 * empty and DRIVE lives inside the voice, where it is an ANALOG stage on the
 * hardware too. There is no voice-bus -> FX-ADC boundary to AC-couple, so the
 * engine deliberately has NO DcBlock: the ring DC legitimately reaches the
 * output, exactly as it rides the hardware's analog bus out to the jack.
 *
 * This test pins that audit: the DC is present (removing it would be
 * UNfaithful) but small enough — one voice into voiceMix — to stay inside
 * the output limiter's linear region (knee |0.7|), with the audio intact.
 * If an FX stage is ever added to the mono engine, this file is the flag
 * that the coupling question must be re-decided.
 */
import { describe, it, expect } from 'vitest'
import { Engine } from '../src/synths/mono/engine'
import { initProgram } from '../src/synths/mono/program'
import { P } from '../src/synths/mono/params'
import { renderEngine, rms, SR } from './helpers/audio'

function ringEngine(): Engine {
  const e = new Engine(SR)
  const prog = initProgram()
  const set = (id: number, v: number): void => {
    prog.params[id] = v
  }
  set(P.VCO1_WAVE, 2)
  set(P.VCO2_WAVE, 2) // SAW (WAVES2: NOISE/TRI/SAW)
  set(P.VCO1_LEVEL, 1023)
  set(P.VCO2_LEVEL, 1023)
  set(P.SYNC_RING, 0) // RING (exclusive 3-way switch)
  set(P.CUTOFF, 302) // passes DC, attenuates the audible band
  e.loadProgram(prog)
  return e
}

describe('no DC blocking on the monologue (no FX board to couple into)', () => {
  it('ring saws carry their genuine DC to the output, bounded and unflattened', () => {
    const e = ringEngine()
    // C2: the exclusive switch means no hard sync, so the ring phase lock
    // rests on the slow analog drift — ~0.15 Hz relative at 65 Hz keeps the
    // saw² product coherent across the window.
    e.noteOn(36, 100)
    const out = renderEngine(e, 1.5)
    const from = Math.round(0.5 * SR)
    let mean = 0
    for (let i = from; i < out.length; i++) mean += out[i]
    mean /= out.length - from
    const total = rms(out, from)
    const ac = Math.sqrt(Math.max(0, total * total - mean * mean))
    // DC present (faithful analog path — no AC coupling before the output)...
    expect(mean).toBeGreaterThan(0.05)
    // ...but bounded well inside the limiter's linear region, audio alive.
    expect(mean).toBeLessThan(0.5)
    expect(ac).toBeGreaterThan(0.01)
  })
})
