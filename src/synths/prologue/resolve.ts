/*
 * resolveMidiParam — pure resolution of the prologue's engine-dependent
 * sentinel CC ids (synths/prologue/cc.ts) to concrete params. The prologue's
 * multi-engine CCs address the EDIT-TIMBRE-scoped timbre; FX sub-type CCs
 * address the active MOD FX type / DELAY-REVERB side (program-global).
 */
import { P, TIMBRE_BLOCKS } from './params'
import {
  CC_ID_MULTI_SHAPE,
  CC_ID_MULTI_SHIFT_SHAPE,
  CC_ID_MULTI_SUB,
  CC_ID_MODFX_SUB,
  CC_ID_DLRV_SUB,
} from './cc'

const MODFX_SUB_PARAM = [
  P.MODFX_SUB_CHORUS, P.MODFX_SUB_ENSEMBLE, P.MODFX_SUB_PHASER,
  P.MODFX_SUB_FLANGER, P.MODFX_SUB_USER,
]

/**
 * Resolve a sentinel id + raw value to a concrete { id, v }, given the
 * current EDIT TIMBRE (0=Main, 1=Main+Sub -> Main, 2=Sub), the scoped
 * timbre's MULTI TYPE, the MOD FX TYPE and the DELAY/REVERB select.
 * Returns null when unresolvable.
 */
export function resolveMidiParam(
  id: number,
  v: number,
  editTimbre: number,
  multiType: number,
  modFxType: number,
  dlrvSelect: number,
): { id: number; v: number } | null {
  const t = TIMBRE_BLOCKS[Math.round(editTimbre) === 2 ? 1 : 0]
  const mt = Math.round(multiType)
  switch (id) {
    case CC_ID_MULTI_SHAPE:
      return { id: mt === 0 ? t.shapeNoise : mt === 1 ? t.shapeVpm : t.shapeUser, v }
    case CC_ID_MULTI_SHIFT_SHAPE:
      // No shift-shape for NOISE on the prologue (spec §6).
      if (mt === 0) return null
      return { id: mt === 1 ? t.shiftShapeVpm : t.shiftShapeUser, v }
    case CC_ID_MULTI_SUB: {
      const sel = mt === 0 ? t.selectNoise : mt === 1 ? t.selectVpm : t.selectUser
      const zones = mt === 0 ? 4 : 16
      return { id: sel, v: Math.min(zones - 1, (v * zones) >> 7) }
    }
    case CC_ID_MODFX_SUB: {
      const sub = MODFX_SUB_PARAM[Math.round(modFxType)] ?? P.MODFX_SUB_CHORUS
      return { id: sub, v }
    }
    case CC_ID_DLRV_SUB: {
      const side = Math.round(dlrvSelect)
      if (side === 1) return { id: P.DELAY_SUB, v: Math.min(11, (v * 12) >> 7) }
      if (side === 2) return { id: P.REVERB_SUB, v: Math.min(9, (v * 10) >> 7) }
      return null // OFF: nothing to address
    }
    default:
      return id >= 0 ? { id, v } : null
  }
}
