import { describe, expect, it } from 'vitest'
import { FACTORY_PRESETS } from '../src/state/presets'
import { PARAMS, PARAM_COUNT, P } from '../src/shared/params'
import {
  deserializeProgram,
  serializeProgram,
  MOTION_POINTS,
  NUM_STEPS,
} from '../src/shared/program'
import { arpTypeIndex, chordIndex, polyDuo, isTie } from '../src/shared/maps'

describe('FACTORY_PRESETS', () => {
  it('contains at least 28 programs', () => {
    expect(FACTORY_PRESETS.length).toBeGreaterThanOrEqual(28)
  })

  it('gives every program a non-empty name of at most 16 chars', () => {
    for (const prog of FACTORY_PRESETS) {
      expect(prog.name.length).toBeGreaterThan(0)
      expect(prog.name.length).toBeLessThanOrEqual(16)
    }
  })

  it('has unique names', () => {
    const names = FACTORY_PRESETS.map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('has a full params array with every value inside its meta range', () => {
    for (const prog of FACTORY_PRESETS) {
      expect(prog.params.length).toBe(PARAM_COUNT)
      for (const meta of PARAMS) {
        const v = prog.params[meta.id]
        expect(Number.isFinite(v), `${prog.name} / ${meta.key} finite`).toBe(true)
        expect(Number.isInteger(v), `${prog.name} / ${meta.key} integer`).toBe(true)
        expect(v, `${prog.name} / ${meta.key} >= min`).toBeGreaterThanOrEqual(meta.min)
        expect(v, `${prog.name} / ${meta.key} <= max`).toBeLessThanOrEqual(meta.max)
      }
    }
  })

  it('survives a serialize -> deserialize roundtrip with params intact', () => {
    for (const prog of FACTORY_PRESETS) {
      const back = deserializeProgram(serializeProgram(prog))
      expect(back, prog.name).not.toBeNull()
      expect(back!.name).toBe(prog.name)
      expect(back!.params).toEqual(prog.params)
      expect(back!.seq).toEqual(prog.seq)
    }
  })

  it('includes at least 3 programs with sequenced notes', () => {
    const withNotes = FACTORY_PRESETS.filter((prog) =>
      prog.seq.steps.some((s) => s.on && s.notes.length > 0),
    )
    expect(withNotes.length).toBeGreaterThanOrEqual(3)
    for (const prog of withNotes) {
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

  it('automates CUTOFF or MULTI shape smoothly, and one switch param stepwise', () => {
    const shapeIds = new Set<number>([P.CUTOFF, P.SHAPE_NOISE, P.SHAPE_VPM, P.SHAPE_USER])
    let smoothLanes = 0
    let switchLanes = 0
    for (const prog of FACTORY_PRESETS) {
      for (const lane of prog.seq.motion) {
        if (!lane.on || lane.paramId < 0) continue
        const meta = PARAMS[lane.paramId]
        expect(meta, `${prog.name} motion targets a real param`).toBeDefined()
        expect(meta.motion, `${prog.name} / ${meta.key} is motion-recordable`).toBe(true)
        // motion data must stay within the target param's range
        for (const d of lane.data) {
          if (!d) continue
          for (const v of d) {
            expect(v).toBeGreaterThanOrEqual(meta.min)
            expect(v).toBeLessThanOrEqual(meta.max)
          }
        }
        if (lane.smooth && shapeIds.has(lane.paramId)) smoothLanes++
        if (!lane.smooth && meta.kind === 'switch') switchLanes++
      }
    }
    expect(smoothLanes).toBeGreaterThanOrEqual(2)
    expect(switchLanes).toBeGreaterThanOrEqual(1)
  })

  it('includes a sequence that uses a TIE gate', () => {
    const tied = FACTORY_PRESETS.filter((prog) =>
      prog.seq.steps.some((s) => s.on && s.gates.some((g) => isTie(g))),
    )
    expect(tied.length).toBeGreaterThanOrEqual(1)
  })

  it('covers the required voice modes and engine features', () => {
    const byMode = (mode: number) => FACTORY_PRESETS.filter((p) => p.params[P.VOICE_MODE] === mode)
    // 3 arp programs, latched, landing on distinct arp types
    const arps = byMode(0)
    expect(arps.length).toBeGreaterThanOrEqual(3)
    const arpTypes = new Set(arps.map((p) => arpTypeIndex(p.params[P.VM_DEPTH])))
    expect(arpTypes.size).toBeGreaterThanOrEqual(3)
    for (const p of arps) expect(p.params[P.ARP_LATCH]).toBe(1)
    // 2 chord programs on distinct chords
    const chords = byMode(1)
    expect(chords.length).toBeGreaterThanOrEqual(2)
    const chordTypes = new Set(chords.map((p) => chordIndex(p.params[P.VM_DEPTH])))
    expect(chordTypes.size).toBeGreaterThanOrEqual(2)
    // at least 2 unison programs (lead + bass)
    expect(byMode(2).length).toBeGreaterThanOrEqual(2)
    // at least one POLY program pushed into the DUO zone
    const duo = byMode(3).filter((p) => polyDuo(p.params[P.VM_DEPTH]).duo)
    expect(duo.length).toBeGreaterThanOrEqual(1)
    // multi engine coverage: NOISE, VPM and USER all appear as the lead engine
    const engines = new Set(
      FACTORY_PRESETS.filter((p) => p.params[P.MULTI_LEVEL] > 0).map((p) => p.params[P.MULTI_TYPE]),
    )
    expect(engines.has(0)).toBe(true)
    expect(engines.has(1)).toBe(true)
    expect(engines.has(2)).toBe(true)
    // hard sync and ring mod each showcased somewhere
    expect(FACTORY_PRESETS.some((p) => p.params[P.SYNC] === 1)).toBe(true)
    expect(FACTORY_PRESETS.some((p) => p.params[P.RING] === 1)).toBe(true)
  })

  it('keeps program levels in a comparable loudness window', () => {
    for (const prog of FACTORY_PRESETS) {
      const lvl = prog.params[P.PROGRAM_LEVEL]
      expect(lvl, prog.name).toBeGreaterThanOrEqual(82) // >= -4 dB
      expect(lvl, prog.name).toBeLessThanOrEqual(112) // <= +2 dB
      // stacked-voice modes trimmed below unity
      const mode = prog.params[P.VOICE_MODE]
      const duo = mode === 3 && polyDuo(prog.params[P.VM_DEPTH]).duo
      if (mode === 1 || mode === 2 || duo) {
        expect(lvl, `${prog.name} stacked-voice trim`).toBeLessThanOrEqual(102)
      }
    }
  })

  it('sets delay dry/wet in a tasteful window whenever delay is on', () => {
    for (const prog of FACTORY_PRESETS) {
      if (prog.params[P.DELAY_ON] === 1) {
        const dw = prog.params[P.DELAY_DRYWET]
        expect(dw, prog.name).toBeGreaterThanOrEqual(350)
        expect(dw, prog.name).toBeLessThanOrEqual(550)
      }
    }
  })
})
