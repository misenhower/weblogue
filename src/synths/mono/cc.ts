/*
 * Korg monologue MIDI CC map, Revision 1.00 (docs/monologue-spec.md §10) —
 * the pure per-CC decoder injected into the generic MidiInput plumbing
 * (src/midi/midi.ts).
 *
 * Everything is 7-bit: the monologue has NO xd-style CC63 10-bit LSB scheme,
 * so pendingLsb is ignored and knob values scale 0..127 -> raw 0..1023 as
 * round(v * 1023 / 127).
 *
 * Notes vs the family decoders:
 *  - CC34 VCO1 PITCH and CC48 VCO1 OCTAVE are RECEIVE-only on hardware (no
 *    panel control to transmit them) — decoding IS receiving, so both map.
 *  - CC60 is the exclusive SYNC/RING 3-position switch (RING/OFF/SYNC zones)
 *    — not the OG's separate CC80/CC81 on/off pair.
 *  - CC51 VCO2 WAVE zones are NOISE/TRI/SAW (program-data order, spec §10).
 *  - No CC for DRIVE-as-switch — CC28 DRIVE is a continuous knob here.
 *  - Rx-only CC120/122/123 are handled at the port level, not here.
 */
import { P } from './params'
import type { DecodedCc } from '../../midi/midi'

// ---------------------------------------------------------------------------
// CC decode tables (docs/monologue-spec.md §10)
// ---------------------------------------------------------------------------
const NO = -32768 // "no mapping" marker

/** CCs whose 7-bit value scales to a raw 0..1023 knob. */
const KNOB_ID = new Int16Array(128).fill(NO)
/** Zone-switch CCs: param id + number of equal zones dividing 0..127. */
const SWITCH_ID = new Int16Array(128).fill(NO)
const SWITCH_ZONES = new Uint8Array(128)

{
  const knobs: ReadonlyArray<readonly [number, number]> = [
    [16, P.EG_ATTACK],
    [17, P.EG_DECAY],
    [24, P.LFO_RATE],
    [25, P.EG_INT],
    [26, P.LFO_INT],
    [28, P.DRIVE],
    [34, P.VCO1_PITCH], // receive-only on hardware (no panel knob)
    [35, P.VCO2_PITCH],
    [36, P.VCO1_SHAPE],
    [37, P.VCO2_SHAPE],
    [39, P.VCO1_LEVEL],
    [40, P.VCO2_LEVEL],
    [43, P.CUTOFF],
    [44, P.RESONANCE],
  ]
  for (const [cc, id] of knobs) KNOB_ID[cc] = id

  const sw: ReadonlyArray<readonly [number, number, number]> = [
    [48, P.VCO1_OCTAVE, 4], // receive-only; quartiles: 16'/8'/4'/2'
    [49, P.VCO2_OCTAVE, 4], // quartiles (tx 0,42,84,127)
    [50, P.VCO1_WAVE, 3], // thirds: SQR/TRI/SAW
    [51, P.VCO2_WAVE, 3], // thirds: NOISE/TRI/SAW (spec §10)
    [56, P.LFO_TARGET, 3], // thirds: CUTOFF/SHAPE/PITCH
    [58, P.LFO_WAVE, 3], // thirds: SQR/TRI/SAW
    [59, P.LFO_MODE, 3], // thirds: 1-SHOT/SLOW/FAST
    [60, P.SYNC_RING, 3], // thirds: RING/OFF/SYNC (exclusive 3-pos switch)
    [61, P.EG_TYPE, 3], // thirds: GATE / A/G/D / A/D (program-data order)
    [62, P.EG_TARGET, 3], // thirds: CUTOFF/PITCH 2/PITCH
  ]
  for (const [cc, id, zones] of sw) {
    SWITCH_ID[cc] = id
    SWITCH_ZONES[cc] = zones
  }
}

/**
 * Decode one control change per the monologue rev 1.00 CC map. Pure —
 * pendingLsb is part of the CcDecoder signature but the monologue is 7-bit
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

  if (c === 64) {
    // Sustain pedal — the monologue has no damper input and the MIDIimp does
    // not list CC64; reception UNCONFIRMED, decoded anyway (harmless — the
    // OG decoder does the same).
    return { kind: 'sustain', on: v >= 64 }
  }

  const knobId = KNOB_ID[c]
  if (knobId !== NO) {
    return { kind: 'param', id: knobId, v: Math.round((v * 1023) / 127) }
  }

  const swId = SWITCH_ID[c]
  if (swId !== NO) {
    return { kind: 'param', id: swId, v: (v * SWITCH_ZONES[c]) >> 7 }
  }

  return null
}
