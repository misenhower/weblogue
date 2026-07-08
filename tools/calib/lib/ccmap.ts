/*
 * Inverse xd CC map for the hardware-calibration harness — the mirror image
 * of decodeCc in src/synths/xd/cc.ts. encodeParamCc turns a param id + raw
 * value into the CC message sequence that sets it on real hardware (receive
 * convention, docs/xd-spec.md §13):
 *
 *   10-bit knobs (incl. the MULTI SHAPE / SHIFT SHAPE sentinels) emit CC63
 *   carrying the LOWER 3 BITS first, then the value CC with the top 7 bits.
 *   Zone switches emit a single CC at the ZONE CENTER,
 *   floor((zone*128 + 64) / zones), which survives the decoder's
 *   (v*zones)>>7 for every zone of every switch. Polarity quirks mirror spec
 *   §15: CC80 SYNC / CC81 RING receive INVERTED (ON = 0), FX ON CCs 92/93/94
 *   are normal (ON = 127).
 *
 * Pure (no node imports, no fs/process) so the root tsc typechecks it via
 * the tests. Params without a CC (VOICE_MODE, menu params, per-engine wave
 * selects…) encode to null.
 */
import { P } from '../../../src/synths/xd/params'
import {
  CC_ID_MULTI_SHAPE,
  CC_ID_MULTI_SHIFT_SHAPE,
  CC_ID_MULTI_SUB,
  CC_ID_MODFX_SUB,
} from '../../../src/synths/xd/cc'

export interface CcMsg {
  cc: number
  value: number
}

// ---------------------------------------------------------------------------
// Encode tables — cc.ts's TEN_BIT / SWITCH tables, inverted (param id keyed).
// ---------------------------------------------------------------------------

/** 10-bit params (0..1023) -> value CC; CC63 carries the lower 3 bits. */
const TEN_BIT_CC: ReadonlyMap<number, number> = new Map([
  [P.AMP_ATTACK, 16],
  [P.AMP_DECAY, 17],
  [P.AMP_SUSTAIN, 18],
  [P.AMP_RELEASE, 19],
  [P.EG_ATTACK, 20],
  [P.EG_DECAY, 21],
  [P.EG_INT, 22],
  [P.LFO_RATE, 24],
  [P.LFO_INT, 26],
  [P.VM_DEPTH, 27],
  [P.MODFX_TIME, 28],
  [P.MODFX_DEPTH, 29],
  [P.MULTI_LEVEL, 33],
  [P.VCO1_PITCH, 34],
  [P.VCO2_PITCH, 35],
  [P.VCO1_SHAPE, 36],
  [P.VCO2_SHAPE, 37],
  [P.VCO1_LEVEL, 39],
  [P.VCO2_LEVEL, 40],
  [P.CROSS_MOD, 41],
  [P.CUTOFF, 43],
  [P.RESONANCE, 44],
  [CC_ID_MULTI_SHAPE, 54],
  [CC_ID_MULTI_SHIFT_SHAPE, 104],
  [P.DELAY_TIME, 105],
  [P.DELAY_DEPTH, 106],
  [P.DELAY_DRYWET, 107],
  [P.REVERB_TIME, 108],
  [P.REVERB_DEPTH, 109],
  [P.REVERB_DRYWET, 110],
])

/** Zone-switch params -> [cc, number of equal zones dividing 0..127]. */
const SWITCH_CC: ReadonlyMap<number, readonly [number, number]> = new Map<
  number,
  readonly [number, number]
>([
  [P.EG_TARGET, [23, 3]],
  [P.VCO1_OCTAVE, [48, 4]],
  [P.VCO2_OCTAVE, [49, 4]],
  [P.VCO1_WAVE, [50, 3]],
  [P.VCO2_WAVE, [51, 3]],
  [P.MULTI_TYPE, [53, 3]],
  [P.LFO_TARGET, [56, 3]],
  [P.LFO_WAVE, [57, 3]],
  [P.LFO_MODE, [58, 3]],
  [P.KEYTRACK, [83, 3]],
  [P.DRIVE, [84, 3]],
  [P.MODFX_TYPE, [88, 5]],
])

/** Sub-select tables ride wider zone grids than their internal range. */
const DELAY_SUB_ZONES = 20
const DELAY_SUB_MAX = 11
const REVERB_SUB_ZONES = 18
const REVERB_SUB_MAX = 9

/** Directly mapped params (single CC, no zone grid shared with a table). */
const DIRECT_IDS: readonly number[] = [
  P.PORTAMENTO,
  P.SYNC,
  P.RING,
  P.MODFX_ON,
  P.DELAY_ON,
  P.REVERB_ON,
  P.DELAY_SUB,
  P.REVERB_SUB,
  CC_ID_MULTI_SUB,
  CC_ID_MODFX_SUB,
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampInt(v: number, max: number): number {
  const i = Math.floor(v)
  return i <= 0 ? 0 : i >= max ? max : i
}

/** Center value of `zone` on a grid of `zones` equal divisions of 0..127. */
function zoneCenter(zone: number, zones: number): number {
  return Math.floor((zone * 128 + 64) / zones)
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

/**
 * CC message sequence that sets param `id` to `raw` on the hardware, or null
 * for params with no CC. Raw is clamped to the param's encodable range (the
 * DRY/WET knobs' raw 1024 is not reachable over CC and clamps to 1023).
 */
export function encodeParamCc(id: number, raw: number): CcMsg[] | null {
  if (!Number.isFinite(raw)) return null

  const tenCc = TEN_BIT_CC.get(id)
  if (tenCc !== undefined) {
    const r = clampInt(raw, 1023)
    return [
      { cc: 63, value: r & 7 },
      { cc: tenCc, value: r >> 3 },
    ]
  }

  const sw = SWITCH_CC.get(id)
  if (sw !== undefined) {
    const [cc, zones] = sw
    return [{ cc, value: zoneCenter(clampInt(raw, zones - 1), zones) }]
  }

  switch (id) {
    case P.PORTAMENTO: // 0..127 direct
      return [{ cc: 5, value: clampInt(raw, 127) }]
    case P.SYNC: // INVERTED receive polarity: 0..63 = ON
      return [{ cc: 80, value: raw >= 1 ? 0 : 127 }]
    case P.RING: // INVERTED receive polarity: 0..63 = ON
      return [{ cc: 81, value: raw >= 1 ? 0 : 127 }]
    case P.MODFX_ON:
      return [{ cc: 92, value: raw >= 1 ? 127 : 0 }]
    case P.DELAY_ON:
      return [{ cc: 93, value: raw >= 1 ? 127 : 0 }]
    case P.REVERB_ON:
      return [{ cc: 94, value: raw >= 1 ? 127 : 0 }]
    case P.DELAY_SUB: // internal 0..11 on a 20-zone grid (USER zones unused)
      return [{ cc: 89, value: zoneCenter(clampInt(raw, DELAY_SUB_MAX), DELAY_SUB_ZONES) }]
    case P.REVERB_SUB: // internal 0..9 on an 18-zone grid (USER zones unused)
      return [{ cc: 90, value: zoneCenter(clampInt(raw, REVERB_SUB_MAX), REVERB_SUB_ZONES) }]
    case CC_ID_MULTI_SUB: // 16 zones; decoder reads v>>3, so park mid-zone
      return [{ cc: 103, value: (clampInt(raw, 15) << 3) + 4 }]
    case CC_ID_MODFX_SUB: // zone count depends on active type; raw passthrough
      return [{ cc: 96, value: clampInt(raw, 127) }]
  }

  return null
}

/** Every param id (incl. negative sentinels) encodeParamCc supports. */
export function ccControlledParamIds(): number[] {
  return [...TEN_BIT_CC.keys(), ...SWITCH_CC.keys(), ...DIRECT_IDS]
}
