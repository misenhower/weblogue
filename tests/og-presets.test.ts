/*
 * OG factory preset bank tests — patterned on tests/presets.test.ts (xd):
 * param integrity (clampParam identity), exact serialization round-trips,
 * naming rules, sequence/motion validity, and coverage of the OG-specific
 * features the bank is required to show off (docs/og-spec.md §3, §6-§9).
 */
import { describe, expect, it } from 'vitest'
import { FACTORY_PRESETS } from '../src/synths/og/presets'
import { PARAMS, PARAM_COUNT, P, clampParam } from '../src/synths/og/params'
import { MOTION_POINTS, NUM_STEPS, isTie } from '../src/shared/program'
import { deserializeProgram, serializeProgram } from '../src/synths/og/program'
import { chordIndex, CHORDS, delayModeDivision } from '../src/synths/og/curves'

describe('OG FACTORY_PRESETS', () => {
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
      expect(back!.synthId).toBe('og')
      expect(back!.name).toBe(prog.name)
      expect(back!.params).toEqual(prog.params)
      expect(back!.seq).toEqual(prog.seq)
    }
  })

  // ------------------------------------------------------------- sequences

  it('includes at least 1 program with sequenced notes, all note data valid', () => {
    const withNotes = FACTORY_PRESETS.filter((prog) =>
      prog.seq.steps.some((s) => s.on && s.notes.length > 0),
    )
    expect(withNotes.length).toBeGreaterThanOrEqual(1)
    for (const prog of withNotes) {
      expect(prog.seq.bpm).toBeGreaterThanOrEqual(10)
      expect(prog.seq.bpm).toBeLessThanOrEqual(300)
      for (const step of prog.seq.steps) {
        if (!step.on) continue
        expect(step.notes.length).toBe(step.vels.length)
        expect(step.notes.length).toBe(step.gates.length)
        for (const n of step.notes) {
          expect(n).toBeGreaterThanOrEqual(0)
          expect(n).toBeLessThanOrEqual(127)
        }
        for (const v of step.vels) {
          expect(v).toBeGreaterThanOrEqual(1)
          expect(v).toBeLessThanOrEqual(127)
        }
        for (const g of step.gates) {
          expect(g).toBeGreaterThanOrEqual(0)
          expect(g).toBeLessThanOrEqual(127)
        }
      }
    }
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

  it('motion lanes target recordable params, stay in range, and cover both smooth and stepped', () => {
    let smoothKnobLanes = 0
    let steppedSwitchLanes = 0
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
        if (lane.smooth && meta.kind === 'knob') smoothKnobLanes++
        if (!lane.smooth && meta.kind === 'switch') steppedSwitchLanes++
      }
    }
    expect(smoothKnobLanes).toBeGreaterThanOrEqual(2)
    // the OG records panel switches into motion lanes too (og-spec.md §10)
    expect(steppedSwitchLanes).toBeGreaterThanOrEqual(1)
  })

  it('includes a sequence that uses a TIE gate', () => {
    const tied = FACTORY_PRESETS.filter((prog) =>
      prog.seq.steps.some((s) => s.on && s.gates.some((g) => isTie(g))),
    )
    expect(tied.length).toBeGreaterThanOrEqual(1)
  })

  // -------------------------------------------------------- required coverage

  it('covers the required OG voice modes: MONO, DELAY, SIDE CHAIN (+ CHORD)', () => {
    const byMode = (mode: number) => FACTORY_PRESETS.filter((p) => p.params[P.VOICE_MODE] === mode)
    expect(byMode(3).length, 'MONO').toBeGreaterThanOrEqual(1)
    expect(byMode(5).length, 'DELAY').toBeGreaterThanOrEqual(1)
    expect(byMode(7).length, 'SIDE CHAIN').toBeGreaterThanOrEqual(1)
    expect(byMode(4).length, 'CHORD').toBeGreaterThanOrEqual(1)
    // MONO patch actually dials in the sub oscillators
    for (const p of byMode(3)) expect(p.params[P.VM_DEPTH]).toBeGreaterThan(0)
    // DELAY patch parks the depth in a real tempo division zone
    for (const p of byMode(5)) {
      const div = delayModeDivision(p.params[P.VM_DEPTH])
      expect(div.beats).toBeGreaterThan(0)
    }
    // CHORD patch lands on a real chord zone
    for (const p of byMode(4)) {
      expect(CHORDS[chordIndex(p.params[P.VM_DEPTH])]).toBeDefined()
    }
  })

  it('covers the 4-POLE filter with self-oscillation-territory resonance', () => {
    const fourPoleHot = FACTORY_PRESETS.filter(
      (p) => p.params[P.FILTER_TYPE] === 1 && p.params[P.RESONANCE] >= 900,
    )
    expect(fourPoleHot.length).toBeGreaterThanOrEqual(1)
  })

  it('covers NOISE in the mix', () => {
    expect(FACTORY_PRESETS.some((p) => p.params[P.NOISE_LEVEL] > 0)).toBe(true)
  })

  it('covers both LFO EG MOD tricks (RATE and INT)', () => {
    const egMods = new Set(
      FACTORY_PRESETS.filter((p) => p.params[P.LFO_EG_MOD] > 0).map((p) => p.params[P.LFO_EG_MOD]),
    )
    expect(egMods.has(1), 'EG MOD = RATE').toBe(true)
    expect(egMods.has(2), 'EG MOD = INT').toBe(true)
  })

  it('covers SYNC + CROSS MOD, the PITCH EG sync sweep, and RING mod', () => {
    expect(
      FACTORY_PRESETS.some((p) => p.params[P.SYNC] === 1 && p.params[P.CROSS_MOD] > 0),
      'SYNC + CROSS MOD lead',
    ).toBe(true)
    // classic sync sweep: SYNC on with a real upward VCO2 pitch EG amount
    expect(
      FACTORY_PRESETS.some((p) => p.params[P.SYNC] === 1 && p.params[P.PITCH_EG_INT] > 532),
      'PITCH EG INT sync sweep',
    ).toBe(true)
    expect(FACTORY_PRESETS.some((p) => p.params[P.RING] === 1), 'RING mod').toBe(true)
  })

  it('uses the HPF delay with PRE routing somewhere (wet-only thinning)', () => {
    const pre = FACTORY_PRESETS.filter((p) => p.params[P.DELAY_ROUTING] === 1)
    expect(pre.length).toBeGreaterThanOrEqual(1)
    for (const p of pre) {
      expect(p.params[P.DELAY_HIPASS], `${p.name} PRE routing engages the HPF`).toBeGreaterThan(0)
      expect(p.params[P.DELAY_FEEDBACK], `${p.name} delay actually repeats`).toBeGreaterThan(0)
    }
  })

  it('keeps delay feedback below runaway whenever the delay is in the path', () => {
    for (const prog of FACTORY_PRESETS) {
      if (prog.params[P.DELAY_ROUTING] !== 0) {
        // loop gain hits unity around raw ~975 (curves.delayFeedback01)
        expect(prog.params[P.DELAY_FEEDBACK], prog.name).toBeLessThanOrEqual(700)
      }
    }
  })

  it('keeps program levels in a comparable loudness window', () => {
    for (const prog of FACTORY_PRESETS) {
      const lvl = prog.params[P.PROGRAM_LEVEL]
      expect(lvl, prog.name).toBeGreaterThanOrEqual(94) // >= -4 dB
      expect(lvl, prog.name).toBeLessThanOrEqual(106) // <= +2 dB
      // stacked-voice modes (UNISON / CHORD / MONO-with-subs) trimmed at or
      // below unity so the bank plays back at comparable loudness
      const mode = prog.params[P.VOICE_MODE]
      const monoSubs = mode === 3 && prog.params[P.VM_DEPTH] > 0
      if (mode === 2 || mode === 4 || monoSubs) {
        expect(lvl, `${prog.name} stacked-voice trim`).toBeLessThanOrEqual(102)
      }
    }
  })
})
