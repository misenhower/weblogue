/*
 * Original Korg minilogue (OG) MIDI CC map, Revision 1.10 (docs/og-spec.md
 * §12) — the pure per-CC decoder injected into the generic MidiInput plumbing
 * (src/midi/midi.ts). Firmware 1.10+ map only; the launch-firmware map
 * (CC1-13/64-67/90-92) is deliberately not implemented (og-spec.md §15.6).
 *
 * Everything is 7-bit: the OG has NO CC63 10-bit LSB scheme (that is the xd),
 * so pendingLsb is ignored and knob values scale 0..127 -> raw 0..1023 as
 * round(v * 1023 / 127).
 *
 * Differences from the xd decoder worth knowing:
 *  - CC80 SYNC / CC81 RING receive NORMAL polarity (0-63 Off / 64-127 On) —
 *    the xd's inverted receive is an xd quirk (og-spec.md §12).
 *  - No engine-dependent sentinels: the OG has no multi engine / mod fx.
 *  - CC5 (portamento on the xd) is NOT in the OG rev 1.10 map — unmapped.
 *  - No CC for VOICE MODE (program data only).
 */
import { P } from './params'
import type { DecodedCc } from '../../midi/midi'

// ---------------------------------------------------------------------------
// CC decode tables (docs/og-spec.md §12)
// ---------------------------------------------------------------------------
const NO = -32768 // "no mapping" marker

/** CCs whose 7-bit value scales to a raw 0..1023 knob. */
const KNOB_ID = new Int16Array(128).fill(NO)
/** Zone-switch CCs: param id + number of equal zones dividing 0..127. */
const SWITCH_ID = new Int16Array(128).fill(NO)
const SWITCH_ZONES = new Uint8Array(128)

{
  const knobs: ReadonlyArray<readonly [number, number]> = [
    [16, P.AMP_ATTACK],
    [17, P.AMP_DECAY],
    [18, P.AMP_SUSTAIN],
    [19, P.AMP_RELEASE],
    [20, P.EG_ATTACK],
    [21, P.EG_DECAY],
    [22, P.EG_SUSTAIN],
    [23, P.EG_RELEASE],
    [24, P.LFO_RATE],
    [26, P.LFO_INT],
    [27, P.VM_DEPTH],
    [29, P.DELAY_HIPASS],
    [30, P.DELAY_TIME],
    [31, P.DELAY_FEEDBACK],
    [33, P.NOISE_LEVEL],
    [34, P.VCO1_PITCH],
    [35, P.VCO2_PITCH],
    [36, P.VCO1_SHAPE],
    [37, P.VCO2_SHAPE],
    [39, P.VCO1_LEVEL],
    [40, P.VCO2_LEVEL],
    [41, P.CROSS_MOD],
    [42, P.PITCH_EG_INT],
    [43, P.CUTOFF],
    [44, P.RESONANCE],
    [45, P.EG_INT], // "CUTOFF EG INT" in the MIDIimp = the filter EG INT knob
  ]
  for (const [cc, id] of knobs) KNOB_ID[cc] = id

  const sw: ReadonlyArray<readonly [number, number, number]> = [
    [48, P.VCO1_OCTAVE, 4], // quartiles: 16'/8'/4'/2' (tx 0,42,84,127)
    [49, P.VCO2_OCTAVE, 4],
    [50, P.VCO1_WAVE, 3], // thirds: SQR/TRI/SAW
    [51, P.VCO2_WAVE, 3],
    [56, P.LFO_TARGET, 3], // thirds: CUTOFF/SHAPE/PITCH
    [57, P.LFO_EG_MOD, 3], // thirds: OFF/RATE/INT
    [58, P.LFO_WAVE, 3],
    [82, P.CUTOFF_VELOCITY, 3], // thirds: 0/50/100%
    [83, P.KEYTRACK, 3],
    [84, P.FILTER_TYPE, 2], // halves: 0-63 2-POLE / 64-127 4-POLE
    // DELAY ROUTING thirds. Enum-order ambiguity (og-spec.md §15.5): the
    // MIDIimp CC table prints BYPASS/POST/PRE but the program-data enum is
    // 0=BYPASS, 1=PRE, 2=POST — we follow the program-data order until the
    // hardware's CC behavior is verified.
    [88, P.DELAY_ROUTING, 3],
  ]
  for (const [cc, id, zones] of sw) {
    SWITCH_ID[cc] = id
    SWITCH_ZONES[cc] = zones
  }
}

/**
 * Decode one control change per the OG rev 1.10 CC map. Pure — pendingLsb is
 * part of the CcDecoder signature but the OG is 7-bit only, so it is ignored
 * (and CC63 itself is unmapped). Returns null for unmapped CCs and for CCs
 * handled at the port level (CC0/1/2/32/120/123).
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
    case 64: // sustain pedal — reception UNCONFIRMED on hardware (og-spec.md
      // §16: the MIDIimp does not list it); decoded anyway, it is harmless.
      return { kind: 'sustain', on: v >= 64 }
    case 80: // OSC SYNC — NORMAL polarity: 0-63 Off / 64-127 On (spec §12)
      return { kind: 'param', id: P.SYNC, v: v >= 64 ? 1 : 0 }
    case 81: // RING MOD — NORMAL polarity (unlike the xd's inverted receive)
      return { kind: 'param', id: P.RING, v: v >= 64 ? 1 : 0 }
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
