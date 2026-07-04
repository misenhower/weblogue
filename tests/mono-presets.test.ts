/*
 * monologue factory preset bank tests — patterned on tests/og-presets.test.ts:
 * param integrity (clampParam identity), exact serialization round-trips
 * (including the monologue's per-step SLIDE flags), naming rules, sequence /
 * motion validity, and coverage of the monologue-specific features the bank
 * is required to show off (docs/monologue-spec.md §3-§8, §11).
 */
import { describe, expect, it } from 'vitest'
import { FACTORY_PRESETS } from '../src/synths/mono/presets'
import { PARAMS, PARAM_COUNT, P, clampParam } from '../src/synths/mono/params'
import { MOTION_POINTS, NUM_STEPS, isTie } from '../src/shared/program'
import { deserializeProgram, serializeProgram } from '../src/synths/mono/program'
import { MICRO_TUNINGS } from '../src/synths/mono/curves'

describe('mono FACTORY_PRESETS', () => {
  it('contains at least 10 programs', () => {
    expect(FACTORY_PRESETS.length).toBeGreaterThanOrEqual(10)
  })

  it('gives every program a non-empty hardware-style name of at most 12 chars', () => {
    for (const prog of FACTORY_PRESETS) {
      expect(prog.name.length).toBeGreaterThan(0)
      expect(prog.name.length).toBeLessThanOrEqual(12)
    }
  })

  it('has unique names', () => {
    const names = FACTORY_PRESETS.map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('has a full params array where every value is a clampParam fixed point', () => {
    for (const prog of FACTORY_PRESETS) {
      expect(prog.params.length).toBe(PARAM_COUNT)
      for (const meta of PARAMS) {
        const v = prog.params[meta.id]
        expect(Number.isFinite(v), `${prog.name} / ${meta.key} finite`).toBe(true)
        expect(Number.isInteger(v), `${prog.name} / ${meta.key} integer`).toBe(true)
        expect(v, `${prog.name} / ${meta.key} >= min`).toBeGreaterThanOrEqual(meta.min)
        expect(v, `${prog.name} / ${meta.key} <= max`).toBeLessThanOrEqual(meta.max)
        // clamp identity: the stored value already IS the legal value
        expect(clampParam(meta.id, v), `${prog.name} / ${meta.key} clamp identity`).toBe(v)
      }
    }
  })

  it('survives a serialize -> deserialize roundtrip exactly', () => {
    for (const prog of FACTORY_PRESETS) {
      const back = deserializeProgram(serializeProgram(prog))
      expect(back, prog.name).not.toBeNull()
      expect(back!.synthId).toBe('mono')
      expect(back!.name).toBe(prog.name)
      expect(back!.params).toEqual(prog.params)
      expect(back!.seq).toEqual(prog.seq)
    }
  })

  // ------------------------------------------------------------- sequences

  it('includes at least 3 programs with sequenced notes, all step data valid and monophonic', () => {
    const withNotes = FACTORY_PRESETS.filter((prog) =>
      prog.seq.steps.some((s) => s.on && s.notes.length > 0),
    )
    expect(withNotes.length).toBeGreaterThanOrEqual(3)
    for (const prog of withNotes) {
      expect(prog.seq.bpm).toBeGreaterThanOrEqual(10)
      expect(prog.seq.bpm).toBeLessThanOrEqual(300)
      for (const step of prog.seq.steps) {
        if (!step.on) continue
        // the monologue sequencer is MONOPHONIC: 1 note per step (spec §8)
        expect(step.notes.length, `${prog.name} monophonic step`).toBe(1)
        expect(step.vels.length).toBe(1)
        expect(step.gates.length).toBe(1)
        expect(step.notes[0]).toBeGreaterThanOrEqual(0)
        expect(step.notes[0]).toBeLessThanOrEqual(127)
        // step events store note + gate only, no per-step velocity (spec §8)
        expect(step.vels[0]).toBe(100)
        expect(step.gates[0]).toBeGreaterThanOrEqual(0)
        expect(step.gates[0]).toBeLessThanOrEqual(127)
      }
    }
  })

  it('includes a sequence with per-step gate variety and a TIE', () => {
    const varied = FACTORY_PRESETS.filter((prog) => {
      const gates = prog.seq.steps.filter((s) => s.on).map((s) => s.gates[0])
      return new Set(gates).size >= 3
    })
    expect(varied.length).toBeGreaterThanOrEqual(1)
    const tied = FACTORY_PRESETS.filter((prog) =>
      prog.seq.steps.some((s) => s.on && s.gates.some((g) => isTie(g))),
    )
    expect(tied.length).toBeGreaterThanOrEqual(1)
  })

  it('includes a sequence with SLIDE flags on 2-3 steps, each gliding into a sounding step', () => {
    const slid = FACTORY_PRESETS.filter((prog) => prog.seq.steps.some((s) => s.on && s.slide === true))
    expect(slid.length).toBeGreaterThanOrEqual(1)
    for (const prog of slid) {
      const n = prog.seq.steps.filter((s) => s.slide === true).length
      expect(n, `${prog.name} slide count`).toBeGreaterThanOrEqual(2)
      expect(n, `${prog.name} slide count`).toBeLessThanOrEqual(3)
      // a flagged step glides INTO the next step's note (spec §8) — so the
      // next step (wrapping) must actually sound
      for (let i = 0; i < NUM_STEPS; i++) {
        if (prog.seq.steps[i].slide !== true) continue
        expect(prog.seq.steps[i].on, `${prog.name} slide step ${i} sounds`).toBe(true)
        const next = prog.seq.steps[(i + 1) % NUM_STEPS]
        expect(next.on, `${prog.name} step after slide ${i} sounds`).toBe(true)
      }
      // a slide patch dials in a real SLIDE_TIME
      expect(prog.params[P.SLIDE_TIME], `${prog.name} slide time`).toBeGreaterThan(0)
    }
  })

  it('slide flags survive a serialization round-trip exactly', () => {
    for (const prog of FACTORY_PRESETS) {
      const back = deserializeProgram(serializeProgram(prog))
      for (let i = 0; i < NUM_STEPS; i++) {
        expect(back!.seq.steps[i].slide, `${prog.name} step ${i}`).toBe(prog.seq.steps[i].slide)
      }
    }
  })

  it('includes a sequenced program with an active-step skip', () => {
    const skipped = FACTORY_PRESETS.filter(
      (prog) =>
        prog.seq.steps.some((s) => s.on && s.notes.length > 0) &&
        prog.seq.activeSteps.some((a) => a === false),
    )
    expect(skipped.length).toBeGreaterThanOrEqual(1)
  })

  it('includes at least 2 programs with a fully populated motion lane', () => {
    const withMotion = FACTORY_PRESETS.filter((prog) =>
      prog.seq.motion.some(
        (lane) =>
          lane.on &&
          lane.paramId >= 0 &&
          lane.data.length === NUM_STEPS &&
          lane.data.every((d) => Array.isArray(d) && d.length === MOTION_POINTS),
      ),
    )
    expect(withMotion.length).toBeGreaterThanOrEqual(2)
  })

  it('motion lanes target recordable params, stay in range, and cover smooth + stepped', () => {
    let smoothLanes = 0
    let steppedLanes = 0
    for (const prog of FACTORY_PRESETS) {
      for (const lane of prog.seq.motion) {
        if (!lane.on || lane.paramId < 0) continue
        const meta = PARAMS[lane.paramId]
        expect(meta, `${prog.name} motion targets a real param`).toBeDefined()
        expect(meta.motion, `${prog.name} / ${meta.key} is motion-recordable`).toBe(true)
        // smooth lanes only on smoothable (knob-like) params
        if (lane.smooth) expect(meta.motionSmooth, `${prog.name} / ${meta.key} smoothable`).toBe(true)
        for (const d of lane.data) {
          if (!d) continue
          for (const v of d) {
            expect(v).toBeGreaterThanOrEqual(meta.min)
            expect(v).toBeLessThanOrEqual(meta.max)
          }
        }
        if (lane.smooth) smoothLanes++
        else steppedLanes++
      }
    }
    expect(smoothLanes).toBeGreaterThanOrEqual(2)
    expect(steppedLanes).toBeGreaterThanOrEqual(1)
  })

  // -------------------------------------------------------- required coverage

  it('covers SYNC with the EG->PITCH 2 sweep (spec §3/§5)', () => {
    expect(
      FACTORY_PRESETS.some(
        (p) => p.params[P.SYNC_RING] === 2 && p.params[P.EG_TARGET] === 1 && p.params[P.EG_INT] > 512,
      ),
      'SYNC lead with an upward PITCH 2 EG sweep',
    ).toBe(true)
  })

  it('covers RING with a short percussive A/D (spec §3)', () => {
    expect(
      FACTORY_PRESETS.some(
        (p) =>
          p.params[P.SYNC_RING] === 0 &&
          p.params[P.EG_TYPE] === 2 &&
          p.params[P.EG_ATTACK] === 0 &&
          p.params[P.EG_DECAY] <= 600,
      ),
      'RING percussion',
    ).toBe(true)
  })

  it('covers VCO2 NOISE driving a GATE-type VCA (spec §3/§5)', () => {
    const noiseGate = FACTORY_PRESETS.filter(
      (p) => p.params[P.VCO2_WAVE] === 0 && p.params[P.VCO2_LEVEL] > 0 && p.params[P.EG_TYPE] === 0,
    )
    expect(noiseGate.length, 'NOISE + GATE percussion').toBeGreaterThanOrEqual(1)
  })

  it('covers the FAST (audio-rate) LFO on both PITCH and CUTOFF (spec §6)', () => {
    const fast = FACTORY_PRESETS.filter(
      (p) => p.params[P.LFO_MODE] === 2 && p.params[P.LFO_INT] !== 512,
    )
    expect(fast.some((p) => p.params[P.LFO_TARGET] === 2), 'FAST LFO -> PITCH growl').toBe(true)
    expect(fast.some((p) => p.params[P.LFO_TARGET] === 0), 'FAST LFO -> CUTOFF pseudo ring').toBe(true)
  })

  it('covers the 1-SHOT LFO as a second envelope (spec §6)', () => {
    expect(
      FACTORY_PRESETS.some((p) => p.params[P.LFO_MODE] === 0 && p.params[P.LFO_INT] !== 512),
      '1-SHOT LFO with engaged depth',
    ).toBe(true)
  })

  it('covers non-zero DRIVE, including one properly pushed patch (spec §7)', () => {
    expect(FACTORY_PRESETS.some((p) => p.params[P.DRIVE] > 0)).toBe(true)
    expect(
      FACTORY_PRESETS.some((p) => p.params[P.DRIVE] >= 600),
      'a drive-pushed patch',
    ).toBe(true)
  })

  it('covers a non-equal microtuning carrying a sequence (spec §11)', () => {
    const micro = FACTORY_PRESETS.filter((p) => {
      const t = MICRO_TUNINGS[p.params[P.MICRO_TUNING]]
      return t !== undefined && t.cents !== null
    })
    expect(micro.length, 'non-equal microtuning').toBeGreaterThanOrEqual(1)
    expect(
      micro.some((p) => p.seq.steps.some((s) => s.on && s.notes.length > 0)),
      'microtuned patch carries a sequence',
    ).toBe(true)
  })

  it('covers a portamento lead (spec §11)', () => {
    expect(
      FACTORY_PRESETS.some((p) => p.params[P.PORTAMENTO] > 0),
      'portamento engaged (stored 0,1..129 = OFF,0..128)',
    ).toBe(true)
  })

  it('keeps program levels in a comparable loudness window', () => {
    for (const prog of FACTORY_PRESETS) {
      const lvl = prog.params[P.PROGRAM_LEVEL]
      expect(lvl, prog.name).toBeGreaterThanOrEqual(94) // >= -4 dB
      expect(lvl, prog.name).toBeLessThanOrEqual(106) // <= +2 dB
      // DRIVE-pushed patches trimmed at or below unity: drive adds density,
      // and the bank should play back at comparable loudness
      if (prog.params[P.DRIVE] >= 600) {
        expect(lvl, `${prog.name} drive trim`).toBeLessThanOrEqual(102)
      }
    }
  })
})
