/*
 * Korg prologue MIDI CC map, Revision 1.01 (docs/prologue-spec.md §11) — the
 * pure per-CC decoder injected into the generic MidiInput plumbing
 * (src/midi/midi.ts).
 *
 * Everything is plain 7-bit (no NRPN, no xd-style CC63 10-bit LSB scheme —
 * 10-bit granularity is SysEx-only, spec §11): pendingLsb is ignored and
 * 10-bit knob values scale 0..127 -> raw 0..1023 as round(v * 1023 / 127).
 *
 * TIMBRE SCOPE: the prologue's CCs address ONE timbre — the hardware routes
 * the main channel's CCs per the panel TIMBRE EDIT scope and offers the SUB
 * timbre the same CCs on a dedicated global "MIDI Sub CC Ch" (spec §11).
 * Channel routing is app-level (the port layer filters one channel); this
 * decoder is channel-blind and returns TIMBRE 1 param ids — the app
 * re-scopes them to the EDIT TIMBRE / sub channel target before
 * store.setParam (TIMBRE_BLOCKS makes that an id-offset lookup).
 *
 * Engine-dependent CCs cannot be resolved here (the active multi-engine /
 * FX type lives in the store), so they are emitted with sentinel NEGATIVE
 * ids (the xd precedent) resolved by the app:
 *   CC54  MULTI SHAPE       -> CC_ID_MULTI_SHAPE       (-54),  v = raw 0..1023
 *   CC104 MULTI SHIFT SHAPE -> CC_ID_MULTI_SHIFT_SHAPE (-104), v = raw 0..1023
 *                              (VPM/USER only — NOISE has no shift shape)
 *   CC103 MULTI SUB TYPE    -> CC_ID_MULTI_SUB         (-103), v = raw 0..127
 *                              (zones per active type: NOISE 4 / VPM 16 /
 *                              USER 16; the receive doc's 8-zone NOISE print
 *                              is spec §16.3)
 *   CC96  MOD FX SUB TYPE   -> CC_ID_MODFX_SUB         (-96),  v = raw 0..127
 *   CC97  DL/RV SUB TYPE    -> CC_ID_DLRV_SUB          (-97),  v = raw 0..127
 *                              (RECEIVE-only on hardware — decoding IS
 *                              receiving, so it maps; zones per the active
 *                              side: DELAY 20 / REVERB 18, USER zones
 *                              ignored like the xd's CC89/90)
 *
 * Quirks handled here (receive notes *5-xx):
 *  - CC85 TIMBRE EDIT zones arrive as SUB / + / MAIN — the REVERSE of the
 *    program-data enum (Main, Main+Sub, Sub); decode flips them.
 *  - CC88 MOD FX TYPE receives in FIVE zones (incl. USER) although the doc's
 *    receive table prints four — spec §16.2.
 *  - CC89 DELAY/REVERB TYPE is halves DELAY/REVERB — there is NO OFF via CC
 *    (program values 1/2; the 3-way OFF stays panel/SysEx-only).
 *  - CC81 PITCH EG zone->enum order is UNCONFIRMED (spec §16.6: the doc's
 *    zones print VCO1/VCO1+2/VCO2 against the OM's VCO2/VCO1+2/ALL switch);
 *    zones decode positionally until hardware reconciles them.
 *  - CC80 RING-SYNC is the exclusive 3-position switch in program order
 *    (RING/OFF/SYNC) — NOT the xd's inverted-polarity on/off pair.
 *  - CC1 mod wheel is handled at the port level (mapped to wheel deflection,
 *    a documented deviation — the hardware wheel transmits its assigned
 *    destination's CC and CC1 is not in the receive map, spec §9); CC0/32
 *    bank select and CC120/122/123 are port-level too.
 */
import { P, TIMBRE_BLOCKS } from './params'
import type { DecodedCc } from '../../midi/midi'

// ---------------------------------------------------------------------------
// Sentinel ids for engine-dependent CCs (resolved by the app).
// ---------------------------------------------------------------------------
export const CC_ID_MULTI_SHAPE = -54
export const CC_ID_MULTI_SHIFT_SHAPE = -104
export const CC_ID_MULTI_SUB = -103
export const CC_ID_MODFX_SUB = -96
export const CC_ID_DLRV_SUB = -97

/** TIMBRE 1 ids — the decoder's fixed scope (see header). */
const T1 = TIMBRE_BLOCKS[0]

// ---------------------------------------------------------------------------
// CC decode tables (docs/prologue-spec.md §11, MIDIimp 2-1)
// ---------------------------------------------------------------------------
const NO = -32768 // "no mapping" marker (param ids can be 0 or small negatives)

/** CCs whose 7-bit value scales to a raw 0..1023 knob. */
const KNOB_ID = new Int16Array(128).fill(NO)
/** CCs whose 7-bit value maps 1:1 onto a 0..127 param. */
const DIRECT_ID = new Int16Array(128).fill(NO)
/** Zone-switch CCs: param id + number of equal zones dividing 0..127. */
const SWITCH_ID = new Int16Array(128).fill(NO)
const SWITCH_ZONES = new Uint8Array(128)

{
  const knobs: ReadonlyArray<readonly [number, number]> = [
    [16, T1.ampAttack],
    [17, T1.ampDecay],
    [18, T1.ampSustain],
    [19, T1.ampRelease],
    [20, T1.egAttack],
    [21, T1.egDecay],
    [22, T1.egSustain],
    [23, T1.egRelease],
    [24, T1.lfoRate],
    [26, T1.lfoInt],
    [27, T1.vmDepth],
    [28, P.MODFX_SPEED],
    [29, P.MODFX_DEPTH],
    [30, P.DLRV_TIME],
    [31, P.DLRV_DEPTH],
    [33, T1.multiLevel],
    [34, T1.vco1Pitch],
    [35, T1.vco2Pitch],
    [36, T1.vco1Shape],
    [37, T1.vco2Shape],
    [39, T1.vco1Level],
    [40, T1.vco2Level],
    [41, T1.crossMod],
    [42, T1.pitchEgInt],
    [43, T1.cutoff],
    [44, T1.resonance],
    [45, T1.cutoffEgInt],
    [54, CC_ID_MULTI_SHAPE],
    [104, CC_ID_MULTI_SHIFT_SHAPE],
  ]
  for (const [cc, id] of knobs) KNOB_ID[cc] = id

  const direct: ReadonlyArray<readonly [number, number]> = [
    [5, T1.portamento],
    [8, P.BALANCE], // prologue-16 only on hardware; harmless on the 8
    [14, T1.voiceSpread], // prologue-16 only on hardware
  ]
  for (const [cc, id] of direct) DIRECT_ID[cc] = id

  const sw: ReadonlyArray<readonly [number, number, number]> = [
    [48, T1.vco1Octave, 4], // quartiles: 2'/4'/8'/16' (prologue enum order)
    [49, T1.vco2Octave, 4],
    [50, T1.vco1Wave, 3], // thirds: SQR/TRI/SAW
    [51, T1.vco2Wave, 3],
    [52, T1.multiOctave, 4],
    [53, T1.multiType, 3], // NOISE/VPM/USR
    [56, T1.lfoTarget, 3],
    [57, T1.lfoWave, 3],
    [58, T1.lfoMode, 3], // BPM/SLOW/FAST
    [80, T1.syncRing, 3], // RING/OFF/SYNC (program order — not inverted)
    [81, T1.pitchEgTarget, 3], // zone->enum order UNCONFIRMED (spec §16.6)
    [82, T1.lowCut, 2], // OFF/ON
    [83, T1.keytrack, 3],
    [84, T1.drive, 3],
    [86, P.TIMBRE_TYPE, 3], // LAYER/XFADE/SPLIT (prologue-16 only)
    [88, P.MODFX_TYPE, 5], // FIVE zones incl. USER (spec §16.2)
  ]
  for (const [cc, id, zones] of sw) {
    SWITCH_ID[cc] = id
    SWITCH_ZONES[cc] = zones
  }
}

/**
 * Decode one control change per the prologue rev 1.01 CC map. Pure —
 * pendingLsb is part of the CcDecoder signature but the prologue is 7-bit
 * only, so it is ignored (and CC63 itself is unmapped). Returns null for
 * unmapped CCs and for CCs handled at the port level (CC0/1/2/32/120/123).
 */
export function decodeCc(
  cc: number,
  value: number,
  _pendingLsb: number | null
): DecodedCc | null {
  if (!Number.isFinite(cc) || !Number.isFinite(value)) return null
  const c = cc | 0
  if (c < 0 || c > 127) return null
  const v = value <= 0 ? 0 : value >= 127 ? 127 : value | 0

  switch (c) {
    case 64: // DAMPER
      return { kind: 'sustain', on: v >= 64 }
    case 85: // TIMBRE EDIT — zones SUB/+/MAIN, program enum Main/Main+Sub/Sub
      return { kind: 'param', id: P.EDIT_TIMBRE, v: 2 - ((v * 3) >> 7) }
    case 89: {
      // DELAY/REVERB TYPE — halves onto program values DELAY(1)/REVERB(2);
      // no OFF via CC.
      return { kind: 'param', id: P.DLRV_SELECT, v: v >= 64 ? 2 : 1 }
    }
    case 92:
      return { kind: 'param', id: P.MODFX_ON, v: v >= 64 ? 1 : 0 }
    case 94:
      return { kind: 'param', id: P.DLRV_ON, v: v >= 64 ? 1 : 0 }
    case 96: // MOD FX SUB — zone count depends on the active type; app resolves
      return { kind: 'param', id: CC_ID_MODFX_SUB, v }
    case 97: // DL/RV SUB (receive-only) — zones depend on the active side
      return { kind: 'param', id: CC_ID_DLRV_SUB, v }
    case 103: // MULTI SUB — zones depend on the active multi type
      return { kind: 'param', id: CC_ID_MULTI_SUB, v }
    case 111: // DL/RV DRY WET (FW2) — 7-bit onto the 0..1024 store
      return { kind: 'param', id: P.DLRV_DRYWET, v: Math.round((v * 1024) / 127) }
  }

  const knobId = KNOB_ID[c]
  if (knobId !== NO) {
    return { kind: 'param', id: knobId, v: Math.round((v * 1023) / 127) }
  }

  const directId = DIRECT_ID[c]
  if (directId !== NO) {
    return { kind: 'param', id: directId, v }
  }

  const swId = SWITCH_ID[c]
  if (swId !== NO) {
    return { kind: 'param', id: swId, v: (v * SWITCH_ZONES[c]) >> 7 }
  }

  return null
}
