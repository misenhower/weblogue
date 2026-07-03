/*
 * resolveMidiParam — pure resolution of engine-dependent sentinel CC ids
 * (emitted by midi.ts) to concrete params, given the active MULTI TYPE and
 * MOD FX TYPE raw values.
 */
import { describe, expect, it } from 'vitest'
import { resolveMidiParam } from '../src/synths/xd/resolve'
import {
  CC_ID_MODFX_SUB,
  CC_ID_MULTI_SHAPE,
  CC_ID_MULTI_SHIFT_SHAPE,
  CC_ID_MULTI_SUB,
} from '../src/midi/midi'
import { P, PARAMS } from '../src/synths/xd/params'

const MODFX_SUB_IDS = [
  P.MODFX_SUB_CHORUS,
  P.MODFX_SUB_ENSEMBLE,
  P.MODFX_SUB_PHASER,
  P.MODFX_SUB_FLANGER,
  P.MODFX_SUB_USER,
]

describe('resolveMidiParam passthrough', () => {
  it('returns non-negative ids and values unchanged', () => {
    expect(resolveMidiParam(P.CUTOFF, 800, 0, 0)).toEqual({ id: P.CUTOFF, v: 800 })
    expect(resolveMidiParam(0, 0, 2, 4)).toEqual({ id: 0, v: 0 })
    expect(resolveMidiParam(P.REVERB_DRYWET, 1024, 1, 3)).toEqual({ id: P.REVERB_DRYWET, v: 1024 })
  })

  it('passthrough ignores the type arguments entirely', () => {
    for (let mt = 0; mt < 3; mt++) {
      for (let ft = 0; ft < 5; ft++) {
        expect(resolveMidiParam(P.VCO1_PITCH, 512, mt, ft)).toEqual({ id: P.VCO1_PITCH, v: 512 })
      }
    }
  })

  it('unknown negative sentinel ids resolve to null', () => {
    expect(resolveMidiParam(-1, 64, 0, 0)).toBeNull()
    expect(resolveMidiParam(-32768, 64, 2, 4)).toBeNull()
    expect(resolveMidiParam(-999, 0, 1, 1)).toBeNull()
  })
})

describe('CC_ID_MULTI_SHAPE / CC_ID_MULTI_SHIFT_SHAPE', () => {
  it('routes to the active engine shape param for every multi type', () => {
    expect(resolveMidiParam(CC_ID_MULTI_SHAPE, 100, 0, 0)).toEqual({ id: P.SHAPE_NOISE, v: 100 })
    expect(resolveMidiParam(CC_ID_MULTI_SHAPE, 100, 1, 0)).toEqual({ id: P.SHAPE_VPM, v: 100 })
    expect(resolveMidiParam(CC_ID_MULTI_SHAPE, 100, 2, 0)).toEqual({ id: P.SHAPE_USER, v: 100 })
  })

  it('routes shift-shape for every multi type, preserving the 10-bit value', () => {
    expect(resolveMidiParam(CC_ID_MULTI_SHIFT_SHAPE, 1023, 0, 0)).toEqual({ id: P.SHIFTSHAPE_NOISE, v: 1023 })
    expect(resolveMidiParam(CC_ID_MULTI_SHIFT_SHAPE, 0, 1, 0)).toEqual({ id: P.SHIFTSHAPE_VPM, v: 0 })
    expect(resolveMidiParam(CC_ID_MULTI_SHIFT_SHAPE, 512, 2, 0)).toEqual({ id: P.SHIFTSHAPE_USER, v: 512 })
  })

  it('clamps out-of-range multi types to the nearest valid engine', () => {
    expect(resolveMidiParam(CC_ID_MULTI_SHAPE, 7, -1, 0)).toEqual({ id: P.SHAPE_NOISE, v: 7 })
    expect(resolveMidiParam(CC_ID_MULTI_SHAPE, 7, 3, 0)).toEqual({ id: P.SHAPE_USER, v: 7 })
  })
})

describe('CC_ID_MULTI_SUB', () => {
  it('routes to the active engine select param', () => {
    expect(resolveMidiParam(CC_ID_MULTI_SUB, 2, 0, 0)).toEqual({ id: P.SELECT_NOISE, v: 2 })
    expect(resolveMidiParam(CC_ID_MULTI_SUB, 9, 1, 0)).toEqual({ id: P.SELECT_VPM, v: 9 })
    expect(resolveMidiParam(CC_ID_MULTI_SUB, 1, 2, 0)).toEqual({ id: P.SELECT_USER, v: 1 })
  })

  it('clamps the 16-zone CC value to each select param range', () => {
    // NOISE has 4 subtypes, VPM 16, USER 4 (from the registry).
    expect(resolveMidiParam(CC_ID_MULTI_SUB, 15, 0, 0)).toEqual({ id: P.SELECT_NOISE, v: PARAMS[P.SELECT_NOISE].max })
    expect(resolveMidiParam(CC_ID_MULTI_SUB, 15, 1, 0)).toEqual({ id: P.SELECT_VPM, v: 15 })
    expect(resolveMidiParam(CC_ID_MULTI_SUB, 15, 2, 0)).toEqual({ id: P.SELECT_USER, v: PARAMS[P.SELECT_USER].max })
  })
})

describe('CC_ID_MODFX_SUB', () => {
  it('zone counts derive from the param registry (8/3/8/8/2)', () => {
    expect(MODFX_SUB_IDS.map((pid) => PARAMS[pid].max + 1)).toEqual([8, 3, 8, 8, 2])
  })

  it('maps the CC extremes to the first/last subtype for every fx type', () => {
    for (let t = 0; t < MODFX_SUB_IDS.length; t++) {
      const pid = MODFX_SUB_IDS[t]
      expect(resolveMidiParam(CC_ID_MODFX_SUB, 0, 0, t)).toEqual({ id: pid, v: 0 })
      expect(resolveMidiParam(CC_ID_MODFX_SUB, 127, 0, t)).toEqual({ id: pid, v: PARAMS[pid].max })
    }
  })

  it('splits 0..127 into equal zones (boundary values)', () => {
    // CHORUS, 8 zones of 16: 15 -> 0, 16 -> 1, 127 -> 7.
    expect(resolveMidiParam(CC_ID_MODFX_SUB, 15, 0, 0)).toEqual({ id: P.MODFX_SUB_CHORUS, v: 0 })
    expect(resolveMidiParam(CC_ID_MODFX_SUB, 16, 0, 0)).toEqual({ id: P.MODFX_SUB_CHORUS, v: 1 })
    // ENSEMBLE, 3 zones: 42 -> 0, 43 -> 1, 85 -> 1, 86 -> 2.
    expect(resolveMidiParam(CC_ID_MODFX_SUB, 42, 0, 1)).toEqual({ id: P.MODFX_SUB_ENSEMBLE, v: 0 })
    expect(resolveMidiParam(CC_ID_MODFX_SUB, 43, 0, 1)).toEqual({ id: P.MODFX_SUB_ENSEMBLE, v: 1 })
    expect(resolveMidiParam(CC_ID_MODFX_SUB, 85, 0, 1)).toEqual({ id: P.MODFX_SUB_ENSEMBLE, v: 1 })
    expect(resolveMidiParam(CC_ID_MODFX_SUB, 86, 0, 1)).toEqual({ id: P.MODFX_SUB_ENSEMBLE, v: 2 })
    // USER, 2 zones: 63 -> 0, 64 -> 1.
    expect(resolveMidiParam(CC_ID_MODFX_SUB, 63, 0, 4)).toEqual({ id: P.MODFX_SUB_USER, v: 0 })
    expect(resolveMidiParam(CC_ID_MODFX_SUB, 64, 0, 4)).toEqual({ id: P.MODFX_SUB_USER, v: 1 })
  })

  it('every CC value stays inside the subtype range for every fx type', () => {
    for (let t = 0; t < MODFX_SUB_IDS.length; t++) {
      const pid = MODFX_SUB_IDS[t]
      let prev = 0
      for (let v = 0; v <= 127; v++) {
        const r = resolveMidiParam(CC_ID_MODFX_SUB, v, 1, t)
        expect(r).not.toBeNull()
        expect(r!.id).toBe(pid)
        expect(r!.v).toBeGreaterThanOrEqual(prev) // monotonic
        expect(r!.v).toBeLessThanOrEqual(PARAMS[pid].max)
        prev = r!.v
      }
      expect(prev).toBe(PARAMS[pid].max) // full range reached
    }
  })

  it('clamps out-of-range fx types to the nearest valid table entry', () => {
    expect(resolveMidiParam(CC_ID_MODFX_SUB, 127, 0, -3)).toEqual({ id: P.MODFX_SUB_CHORUS, v: 7 })
    expect(resolveMidiParam(CC_ID_MODFX_SUB, 127, 0, 9)).toEqual({ id: P.MODFX_SUB_USER, v: 1 })
  })
})
