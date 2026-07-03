/*
 * minilogue xd MIDI CC map (docs/xd-spec.md §13) — the pure per-CC decoder
 * injected into the generic MidiInput plumbing (src/midi/midi.ts).
 *
 * Panel params decode to OUR raw units (param ids from ./params): 10-bit
 * knobs 0..1023 (CC63 carries the LOWER 3 BITS and arrives before the value
 * CC), zone switches as small ints, portamento 0..127.
 *
 * Engine-dependent CCs cannot be resolved here (the active multi engine /
 * mod-fx type lives in the store), so they are emitted with sentinel NEGATIVE
 * ids resolved by ./resolve.ts:
 *   CC54  MULTI SHAPE        -> CC_ID_MULTI_SHAPE       (-54),  v = 10-bit
 *   CC104 MULTI SHIFT SHAPE  -> CC_ID_MULTI_SHIFT_SHAPE (-104), v = 10-bit
 *   CC103 MULTI SUB (type)   -> CC_ID_MULTI_SUB         (-103), v = zone 0..15
 *   CC96  MOD FX SUB         -> CC_ID_MODFX_SUB         (-96),  v = raw 0..127
 *
 * Polarity quirks (spec §15): CC80 SYNC and CC81 RING receive INVERTED —
 * 0..63 = ON. FX ON CCs 92/93/94 are normal (>= 64 = ON).
 */
import { P } from './params'
import type { DecodedCc } from '../../midi/midi'

// ---------------------------------------------------------------------------
// Sentinel ids for engine-dependent CCs (resolved by the app).
// ---------------------------------------------------------------------------
export const CC_ID_MULTI_SHAPE = -54
export const CC_ID_MULTI_SHIFT_SHAPE = -104
export const CC_ID_MULTI_SUB = -103
export const CC_ID_MODFX_SUB = -96


// ---------------------------------------------------------------------------
// CC decode tables (docs/xd-spec.md §13)
// ---------------------------------------------------------------------------
const NO = -32768 // "no mapping" marker (param ids can be 0 or small negatives)

/** CCs whose value is the top 7 bits of a 10-bit param (CC63 = lower 3). */
const TEN_BIT = new Int16Array(128).fill(NO)
/** Zone-switch CCs: param id + number of equal zones dividing 0..127. */
const SWITCH_ID = new Int16Array(128).fill(NO)
const SWITCH_ZONES = new Uint8Array(128)

{
  const ten: ReadonlyArray<readonly [number, number]> = [
    [16, P.AMP_ATTACK],
    [17, P.AMP_DECAY],
    [18, P.AMP_SUSTAIN],
    [19, P.AMP_RELEASE],
    [20, P.EG_ATTACK],
    [21, P.EG_DECAY],
    [22, P.EG_INT],
    [24, P.LFO_RATE],
    [26, P.LFO_INT],
    [27, P.VM_DEPTH],
    [28, P.MODFX_TIME],
    [29, P.MODFX_DEPTH],
    [33, P.MULTI_LEVEL],
    [34, P.VCO1_PITCH],
    [35, P.VCO2_PITCH],
    [36, P.VCO1_SHAPE],
    [37, P.VCO2_SHAPE],
    [39, P.VCO1_LEVEL],
    [40, P.VCO2_LEVEL],
    [41, P.CROSS_MOD],
    [43, P.CUTOFF],
    [44, P.RESONANCE],
    [54, CC_ID_MULTI_SHAPE],
    [104, CC_ID_MULTI_SHIFT_SHAPE],
    [105, P.DELAY_TIME],
    [106, P.DELAY_DEPTH],
    [107, P.DELAY_DRYWET],
    [108, P.REVERB_TIME],
    [109, P.REVERB_DEPTH],
    [110, P.REVERB_DRYWET],
  ]
  for (const [cc, id] of ten) TEN_BIT[cc] = id

  const sw: ReadonlyArray<readonly [number, number, number]> = [
    [23, P.EG_TARGET, 3], // thirds: CUTOFF / PITCH 2 / PITCH
    [48, P.VCO1_OCTAVE, 4], // quartiles: 16'/8'/4'/2'
    [49, P.VCO2_OCTAVE, 4],
    [50, P.VCO1_WAVE, 3], // thirds: SQR/TRI/SAW
    [51, P.VCO2_WAVE, 3],
    [53, P.MULTI_TYPE, 3], // NOISE/VPM/USR
    [56, P.LFO_TARGET, 3],
    [57, P.LFO_WAVE, 3],
    [58, P.LFO_MODE, 3],
    [83, P.KEYTRACK, 3],
    [84, P.DRIVE, 3],
    [88, P.MODFX_TYPE, 5], // fifths: CHORUS/ENSEMBLE/PHASER/FLANGER/USER
  ]
  for (const [cc, id, zones] of sw) {
    SWITCH_ID[cc] = id
    SWITCH_ZONES[cc] = zones
  }
}

/** Delay sub table: 12 internal + 8 USER = 20 zones; USER zones ignored. */
const DELAY_SUB_ZONES = 20
const DELAY_SUB_MAX = 11
/** Reverb sub table: 10 internal + 8 USER = 18 zones; USER zones ignored. */
const REVERB_SUB_ZONES = 18
const REVERB_SUB_MAX = 9

/**
 * Decode one control change per the xd CC map. Pure — pendingLsb (lower 3
 * bits from a preceding CC63, or null) is passed in explicitly so the decoder
 * is unit-testable without MIDI hardware. Returns null for unmapped CCs and
 * for CCs handled at the port level (CC0/1/2/32/120/123).
 */
export function decodeCc(
  cc: number,
  value: number,
  pendingLsb: number | null
): { kind: 'param'; id: number; v: number } | { kind: 'lsb'; v: number } | { kind: 'sustain'; on: boolean } | null {
  if (!Number.isFinite(cc) || !Number.isFinite(value)) return null
  const c = cc | 0
  if (c < 0 || c > 127) return null
  const v = value <= 0 ? 0 : value >= 127 ? 127 : value | 0

  switch (c) {
    case 63: // 10-bit LSB, arrives before the value CC
      return { kind: 'lsb', v: v & 7 }
    case 64: // sustain pedal
      return { kind: 'sustain', on: v >= 64 }
    case 5: // portamento, 0..127 direct
      return { kind: 'param', id: P.PORTAMENTO, v }
    // NOTE: CC59 is deliberately unmapped (spec §13); decoding it as a 7-bit
    // VM DEPTH would corrupt 14-bit CC27/CC59 MSB/LSB pairs from DAWs.
    case 80: // OSC SYNC — INVERTED receive polarity: 0..63 = ON
      return { kind: 'param', id: P.SYNC, v: v <= 63 ? 1 : 0 }
    case 81: // RING MOD — INVERTED receive polarity: 0..63 = ON
      return { kind: 'param', id: P.RING, v: v <= 63 ? 1 : 0 }
    case 92:
      return { kind: 'param', id: P.MODFX_ON, v: v >= 64 ? 1 : 0 }
    case 93:
      return { kind: 'param', id: P.DELAY_ON, v: v >= 64 ? 1 : 0 }
    case 94:
      return { kind: 'param', id: P.REVERB_ON, v: v >= 64 ? 1 : 0 }
    case 89: {
      const z = (v * DELAY_SUB_ZONES) >> 7
      return z <= DELAY_SUB_MAX ? { kind: 'param', id: P.DELAY_SUB, v: z } : null
    }
    case 90: {
      const z = (v * REVERB_SUB_ZONES) >> 7
      return z <= REVERB_SUB_MAX ? { kind: 'param', id: P.REVERB_SUB, v: z } : null
    }
    case 96: // MOD FX SUB — zone count depends on active type; app resolves
      return { kind: 'param', id: CC_ID_MODFX_SUB, v }
    case 103: // MULTI SUB — 16 zones; app routes to the active engine select
      return { kind: 'param', id: CC_ID_MULTI_SUB, v: v >> 3 }
  }

  const tenId = TEN_BIT[c]
  if (tenId !== NO) {
    const lsb = pendingLsb == null || !Number.isFinite(pendingLsb) ? 0 : pendingLsb & 7
    return { kind: 'param', id: tenId, v: (v << 3) | lsb }
  }

  const swId = SWITCH_ID[c]
  if (swId !== NO) {
    return { kind: 'param', id: swId, v: (v * SWITCH_ZONES[c]) >> 7 }
  }

  return null
}

