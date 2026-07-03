/*
 * Engine wiring tests for the aftertouch (channel pressure) offset layer:
 * Engine.setPressure(v) applies a non-destructive, unipolar offset (+100% of
 * the param span at full pressure) to the P.MIDI_AT_ASSIGN destination, using
 * the same block-rate machinery as the joystick Y offset.
 */
import { describe, it, expect } from 'vitest'
import { Engine } from '../src/synths/xd/engine'
import { initProgram } from '../src/synths/xd/program'
import { P, PARAMS, JOY_ASSIGN_DESTS } from '../src/synths/xd/params'

const SR = 48000
const BLOCK = 128

/** Run one audio block so block-rate (joy/pressure) offsets are applied. */
function runBlock(e: Engine): void {
  const l = new Float32Array(BLOCK)
  const r = new Float32Array(BLOCK)
  e.process(l, r, BLOCK)
}

const DEST_CUTOFF = JOY_ASSIGN_DESTS.indexOf('CUTOFF')
const DEST_RESONANCE = JOY_ASSIGN_DESTS.indexOf('RESONANCE')
const DEST_MULTI_SHAPE = JOY_ASSIGN_DESTS.indexOf('MULTI SHAPE')
const DEST_GATE_TIME = JOY_ASSIGN_DESTS.indexOf('GATE TIME')

describe('Engine.setPressure', () => {
  it('offsets the assigned destination without touching the raw value', () => {
    const e = new Engine(SR)
    e.setParam(P.MIDI_AT_ASSIGN, DEST_CUTOFF)
    e.setParam(P.CUTOFF, 200)

    e.setPressure(0.5) // +50% of the 0..1023 span
    runBlock(e)
    expect(e.effectiveParam(P.CUTOFF)).toBeCloseTo(200 + 0.5 * 1023, 6)
    expect(e.getParam(P.CUTOFF)).toBe(200) // non-destructive

    e.setPressure(0)
    runBlock(e)
    expect(e.effectiveParam(P.CUTOFF)).toBe(200)
  })

  it('full pressure spans +100% and clamps at the param max', () => {
    const e = new Engine(SR)
    e.setParam(P.MIDI_AT_ASSIGN, DEST_CUTOFF)
    e.setParam(P.CUTOFF, 0)
    e.setPressure(1)
    runBlock(e)
    expect(e.effectiveParam(P.CUTOFF)).toBe(1023)

    e.setParam(P.CUTOFF, 800) // 800 + 1023 clamps to max
    runBlock(e)
    expect(e.effectiveParam(P.CUTOFF)).toBe(1023)
  })

  it('is unipolar and ignores non-finite values', () => {
    const e = new Engine(SR)
    e.setParam(P.MIDI_AT_ASSIGN, DEST_CUTOFF)
    e.setParam(P.CUTOFF, 100)
    e.setPressure(-1) // clamped to 0
    runBlock(e)
    expect(e.effectiveParam(P.CUTOFF)).toBe(100)
    e.setPressure(NaN) // ignored
    e.setPressure(2) // clamped to 1
    runBlock(e)
    expect(e.effectiveParam(P.CUTOFF)).toBe(1023)
  })

  it('re-assigning MIDI_AT_ASSIGN moves the offset to the new destination', () => {
    const e = new Engine(SR)
    e.setParam(P.MIDI_AT_ASSIGN, DEST_CUTOFF)
    e.setParam(P.CUTOFF, 0)
    e.setParam(P.RESONANCE, 0)
    e.setPressure(1)
    runBlock(e)
    expect(e.effectiveParam(P.CUTOFF)).toBe(1023)
    expect(e.effectiveParam(P.RESONANCE)).toBe(0)

    e.setParam(P.MIDI_AT_ASSIGN, DEST_RESONANCE)
    runBlock(e)
    expect(e.effectiveParam(P.CUTOFF)).toBe(0) // released
    expect(e.effectiveParam(P.RESONANCE)).toBe(1023)
  })

  it('MULTI SHAPE destination re-resolves when the multi type changes', () => {
    const e = new Engine(SR)
    e.setParam(P.MIDI_AT_ASSIGN, DEST_MULTI_SHAPE)
    e.setParam(P.MULTI_TYPE, 1) // VPM
    e.setParam(P.SHAPE_VPM, 0)
    e.setParam(P.SHAPE_NOISE, 0)
    e.setPressure(1)
    runBlock(e)
    expect(e.effectiveParam(P.SHAPE_VPM)).toBe(1023)
    expect(e.effectiveParam(P.SHAPE_NOISE)).toBe(0)

    e.setParam(P.MULTI_TYPE, 0) // NOISE
    runBlock(e)
    expect(e.effectiveParam(P.SHAPE_VPM)).toBe(0)
    expect(e.effectiveParam(P.SHAPE_NOISE)).toBe(1023)
  })

  it('stacks with the joystick Y offset on the same destination', () => {
    const e = new Engine(SR)
    e.setParam(P.MIDI_AT_ASSIGN, DEST_CUTOFF)
    e.setParam(P.JOY_ASSIGN_PLUS, DEST_CUTOFF)
    e.setParam(P.JOY_RANGE_PLUS, 200) // +100%
    e.setParam(P.CUTOFF, 0)
    e.setJoyY(0.5)
    e.setPressure(0.25)
    runBlock(e)
    expect(e.effectiveParam(P.CUTOFF)).toBeCloseTo(0.5 * 1023 + 0.25 * 1023, 6)
  })

  it('GATE TIME destination applies no param offset and keeps processing', () => {
    const e = new Engine(SR)
    e.setParam(P.MIDI_AT_ASSIGN, DEST_GATE_TIME)
    e.setPressure(1)
    runBlock(e)
    for (const m of PARAMS) {
      expect(e.effectiveParam(m.id)).toBe(e.getParam(m.id))
    }
  })

  it('loadProgram clears the pressure offset', () => {
    const e = new Engine(SR)
    e.setParam(P.MIDI_AT_ASSIGN, DEST_CUTOFF)
    e.setParam(P.CUTOFF, 0)
    e.setPressure(1)
    runBlock(e)
    expect(e.effectiveParam(P.CUTOFF)).toBe(1023)

    const p = initProgram()
    e.loadProgram(p)
    runBlock(e)
    expect(e.effectiveParam(P.CUTOFF)).toBe(e.getParam(P.CUTOFF))
  })

  it('takePeak still meters output and resets on read', () => {
    const e = new Engine(SR)
    e.noteOn(60, 127)
    for (let i = 0; i < 40; i++) runBlock(e)
    expect(e.takePeak()).toBeGreaterThan(0)
    expect(e.takePeak()).toBe(0) // reset, no blocks in between
  })
})
