/*
 * Engine-dependent MIDI CC resolution (pure, DOM-free).
 *
 * midi.ts cannot resolve CCs whose target param depends on the active multi
 * engine / mod-fx type, so it emits sentinel NEGATIVE ids (see midi.ts
 * header). This module maps them to concrete params given the current
 * MULTI TYPE / MOD FX TYPE raw values.
 */
import { P, PARAMS, clampParam } from './params'
import {
  CC_ID_MODFX_SUB,
  CC_ID_MULTI_SHAPE,
  CC_ID_MULTI_SHIFT_SHAPE,
  CC_ID_MULTI_SUB,
} from '../../midi/midi'

const MULTI_SHAPE = [P.SHAPE_NOISE, P.SHAPE_VPM, P.SHAPE_USER] as const
const MULTI_SHIFT_SHAPE = [P.SHIFTSHAPE_NOISE, P.SHIFTSHAPE_VPM, P.SHIFTSHAPE_USER] as const
const MULTI_SELECT = [P.SELECT_NOISE, P.SELECT_VPM, P.SELECT_USER] as const
const MODFX_SUB = [
  P.MODFX_SUB_CHORUS,
  P.MODFX_SUB_ENSEMBLE,
  P.MODFX_SUB_PHASER,
  P.MODFX_SUB_FLANGER,
  P.MODFX_SUB_USER,
] as const

/** CC96 zone counts per mod-fx type, derived from the param registry
 *  (max + 1 subtypes each) so they can never drift from params.ts. */
const MODFX_SUB_ZONES: readonly number[] = MODFX_SUB.map((pid) => PARAMS[pid].max + 1)

/** Clamp a type selector to a valid table index. */
function typeIndex(v: number, len: number): number {
  const i = Math.round(v)
  return i <= 0 ? 0 : i >= len - 1 ? len - 1 : i
}

/**
 * Resolve engine-dependent sentinel CC ids to concrete params. Non-negative
 * ids pass through unchanged; unknown negative ids resolve to null.
 * `multiType` / `modFxType` are the raw P.MULTI_TYPE / P.MODFX_TYPE values.
 */
export function resolveMidiParam(
  id: number,
  v: number,
  multiType: number,
  modFxType: number,
): { id: number; v: number } | null {
  if (id >= 0) return { id, v }
  switch (id) {
    case CC_ID_MULTI_SHAPE:
      return { id: MULTI_SHAPE[typeIndex(multiType, MULTI_SHAPE.length)], v }
    case CC_ID_MULTI_SHIFT_SHAPE:
      return { id: MULTI_SHIFT_SHAPE[typeIndex(multiType, MULTI_SHIFT_SHAPE.length)], v }
    case CC_ID_MULTI_SUB: {
      const pid = MULTI_SELECT[typeIndex(multiType, MULTI_SELECT.length)]
      return { id: pid, v: clampParam(pid, v) }
    }
    case CC_ID_MODFX_SUB: {
      const t = typeIndex(modFxType, MODFX_SUB.length)
      const pid = MODFX_SUB[t]
      const zones = MODFX_SUB_ZONES[t]
      return { id: pid, v: Math.min(zones - 1, Math.floor((v * zones) / 128)) }
    }
    default:
      return null
  }
}
