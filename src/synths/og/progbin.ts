/*
 * Original minilogue (OG) prog_bin codec — the 448-byte binary payload of
 * .mnlgprog / .mnlglib containers (and of the SysEx program dump after 7->8
 * bit unpacking). Layout per docs/hardware/minilogue_MIDIImp.txt Revision
 * 1.10, TABLE 2 "PROGRAM PARAMETER" (authoritative — the *note P1 quick
 * reference sub-table has misprinted bit locations for EG RELEASE / LFO RATE
 * / LFO INT; see docs/og-spec.md §15.3).
 *
 * Blob layout:
 *   0~3    'PROG'
 *   4~15   program name, 12 ASCII bytes, NUL padded
 *   16~95  panel + menu params (10-bit knobs split hi-8/lo-2, packed enums)
 *   96~99  'SEQD'
 *   100~127 sequencer header (BPM x10 12-bit LE, masks, 4 motion slots)
 *   128~447 16 x 20-byte step event blocks (4 note/vel/gate slots +
 *           4 motion slots x 2 data bytes)
 *
 * Lossiness (hardware coarser than the replica):
 *   - motion data for 0..1023 params is stored as the hardware's single
 *     byte per point (value >> 2): the 2 LSBs are lost;
 *   - motion lanes hold 2 points/step on hardware vs our MOTION_POINTS=5
 *     (spread by linear interpolation on decode — exact for lanes recorded
 *     as ramps/flats, which is what the replica records);
 *   - steps keep at most 4 notes (hardware slots) of our NOTES_PER_STEP=8;
 *   - the format has no per-step mute bit: st.on decodes from event presence
 *     (velocity != 0), so a muted-but-populated step keeps its notes but
 *     comes back with on=true (content preservation beats flag fidelity);
 *   - ARP_LATCH and SLIDER_RANGE have no known TABLE 2 field (og-spec.md
 *     §11/§16) and are not encoded: they decode as their init defaults.
 */
import type { KorgFileCodec } from '../def'
import type { Program, SeqData } from '../../shared/program'
import { NUM_STEPS, NUM_MOTION_LANES, MOTION_POINTS } from '../../shared/program'
import { MOTION_PITCH_BEND, MOTION_GATE_TIME } from '../../shared/paramdef'
import {
  clampInt,
  hasMagic,
  writeMagic,
  readFixedAscii,
  writeFixedAscii,
} from '../../shared/progbin-util'
import { P, PARAMS, clampParam, MOTION_META } from './params'
import { initProgram } from './program'

export const OG_PROG_BIN_SIZE = 448

// ---------------------------------------------------------------------------
// Fixed offsets (TABLE 2)
// ---------------------------------------------------------------------------

const OFF_MAGIC = 0 // "0~3 ASCII 'PROG'"
const OFF_NAME = 4 // "4~15 ASCII PROGRAM NAME [12]"
const NAME_LEN = 12
const OFF_AMP_VELOCITY = 33 // "33 0~127 Amp Velocity"
const OFF_PORTAMENTO = 61 // "61 0~128 Portament Time 0,1~129=OFF,0~128"
const OFF_PROGRAM_LEVEL = 71 // "71 77~127 Program Level 77~127=-25~+25"
const OFF_SLIDER_ASSIGN = 72 // "72 0~79 Slider Assign *note P13" (sparse hw ids, see SLIDER_TO_HW)
const OFF_SEQD = 96 // "96~99 ASCII 'SEQD'"
const OFF_BPM = 100 // "100 L:0~7 / 101 H:0~3, 100~3000 = 10.0~300.0"
const OFF_STEP_LENGTH = 103 // "103 1~16 Step Length"
const OFF_SWING = 104 // "104 -75~+75 Swing" (signed byte)
const OFF_DEFAULT_GATE = 105 // "105 0~72 Default Gate Time 0~72=0%~100%"
const OFF_STEP_RESOLUTION = 106 // "106 0~4 Step Resolution *note S1"
const OFF_STEP_ONOFF = 108 // "108/109 bit n = Step 1~8 / 9~16 Off/On"
const OFF_STEP_SWITCH = 110 // "110/111 Step Switch *note S2: set to 0xff when sending"
const OFF_MOTION_SLOT = 112 // "112~119 Motion Slot 1~4 Parameter *note S3" (2 bytes each)
const OFF_MOTION_ONOFF = 120 // "120~127 Motion Slot n Step Off/On" (2 bytes each)
const OFF_STEP_EVENTS = 128 // "128~147 Step 1 Event Data ... 428~447 Step 16" (*note S4)
const STEP_EVENT_SIZE = 20
const HW_NOTES_PER_STEP = 4 // *note S4: 4 note/velocity/gate slots

// ---------------------------------------------------------------------------
// Param field tables
// ---------------------------------------------------------------------------

/** 10-bit knobs: [paramId, upper-8-bits offset, lower-2-bits offset, shift].
 *  Straight transcription of the TABLE 2 rows (bytes 20~51/70 + the packed
 *  low-bit bytes 52~64); the byte-58/59 low-bit rows follow the main table,
 *  not the erroneous *note P1 sub-table (og-spec.md §15.3). */
const TEN_BIT: ReadonlyArray<readonly [number, number, number, number]> = [
  [P.VCO1_PITCH, 20, 52, 0], // "20 VCO 1 PITCH (bit2~9)" / "52 0~1"
  [P.VCO1_SHAPE, 21, 52, 2], // "21 VCO 1 SHAPE (bit2~9)" / "52 2~3"
  [P.VCO2_PITCH, 22, 53, 0], // "22 VCO 2 PITCH (bit2~9)" / "53 0~1"
  [P.VCO2_SHAPE, 23, 53, 2], // "23 VCO 2 SHAPE (bit2~9)" / "53 2~3"
  [P.CROSS_MOD, 24, 54, 0], // "24 CROSS MOD DEPTH (bit2~9)" / "54 0~1"
  [P.PITCH_EG_INT, 25, 54, 2], // "25 VCO 2 PITCH EG INT (bit2~9)" / "54 2~3"
  [P.VCO1_LEVEL, 26, 54, 4], // "26 VCO 1 LEVEL (bit2~9)" / "54 4~5"
  [P.VCO2_LEVEL, 27, 54, 6], // "27 VCO 2 LEVEL (bit2~9)" / "54 6~7"
  [P.NOISE_LEVEL, 28, 55, 2], // "28 NOISE LEVEL (bit2~9)" / "55 2~3"
  [P.CUTOFF, 29, 55, 4], // "29 CUTOFF (bit2~9)" / "55 4~5"
  [P.RESONANCE, 30, 55, 6], // "30 RESONANCE (bit2~9)" / "55 6~7"
  [P.EG_INT, 31, 56, 0], // "31 CUTOFF EG INT (bit2~9)" / "56 0~1"
  [P.AMP_ATTACK, 34, 57, 0], // "34 AMP EG ATTACK (bit2~9)" / "57 0~1"
  [P.AMP_DECAY, 35, 57, 2], // "35 AMP EG DECAY (bit2~9)" / "57 2~3"
  [P.AMP_SUSTAIN, 36, 57, 4], // "36 AMP EG SUSTAIN (bit2~9)" / "57 4~5"
  [P.AMP_RELEASE, 37, 57, 6], // "37 AMP EG RELEASE (bit2~9)" / "57 6~7"
  [P.EG_ATTACK, 38, 58, 0], // "38 EG ATTACK (bit2~9)" / "58 0~1"
  [P.EG_DECAY, 39, 58, 2], // "39 EG DECAY (bit2~9)" / "58 2~3"
  [P.EG_SUSTAIN, 40, 58, 4], // "40 EG SUSTAIN (bit2~9)" / "58 4~5"
  [P.EG_RELEASE, 41, 58, 6], // "41 EG RELEASE (bit2~9)" / "58 6~7" (main table)
  [P.LFO_RATE, 42, 59, 0], // "42 LFO RATE (bit2~9)" / "59 0~1" (main table)
  [P.LFO_INT, 43, 59, 2], // "43 LFO INT (bit2~9)" / "59 2~3" (main table)
  [P.DELAY_HIPASS, 49, 62, 2], // "49 DELAY HI PASS CUTOFF (bit2~9)" / "62 2~3"
  [P.DELAY_TIME, 50, 62, 4], // "50 DELAY TIME (bit2~9)" / "62 4~5"
  [P.DELAY_FEEDBACK, 51, 62, 6], // "51 DELAY FEEDBACK (bit2~9)" / "62 6~7"
  [P.VM_DEPTH, 70, 64, 4], // "70 VOICE MODE DEPTH (bit2~9)" / "64 4~5"
]

/** Packed enums/flags and whole-byte menu params: [paramId, offset, shift, mask]. */
const BIT_FIELDS: ReadonlyArray<readonly [number, number, number, number]> = [
  [P.VCO1_OCTAVE, 52, 4, 0x03], // "52 4~5 VCO 1 OCTAVE 0~3=16',8',4',2'"
  [P.VCO1_WAVE, 52, 6, 0x03], // "52 6~7 VCO 1 WAVE *note P6"
  [P.VCO2_OCTAVE, 53, 4, 0x03], // "53 4~5 VCO 2 OCTAVE"
  [P.VCO2_WAVE, 53, 6, 0x03], // "53 6~7 VCO 2 WAVE"
  [P.SYNC, 55, 0, 0x01], // "55 0 SYNC 0,1=Off,On"
  [P.RING, 55, 1, 0x01], // "55 1 RING 0,1=Off,On"
  [P.CUTOFF_VELOCITY, 56, 2, 0x03], // "56 2~3 CUTOFF VELOCITY *note P10"
  [P.KEYTRACK, 56, 4, 0x03], // "56 4~5 CUTOFF KEYBOARD TRACK *note P10"
  [P.FILTER_TYPE, 56, 6, 0x01], // "56 6 CUTOFF TYPE 0,1=2-POLE,4-POLE"
  [P.LFO_TARGET, 59, 4, 0x03], // "59 4~5 LFO TARGET *note P7"
  [P.LFO_EG_MOD, 59, 6, 0x03], // "59 6~7 LFO EG *note P8"
  [P.LFO_WAVE, 60, 0, 0x03], // "60 0~1 LFO WAVE *note P6"
  [P.DELAY_ROUTING, 60, 6, 0x03], // "60 6~7 DELAY OUTPUT ROUTING *note P9"
  [P.VOICE_MODE, 64, 0, 0x07], // "64 0~2 VOICE MODE *note P11"
  [P.BEND_RANGE_PLUS, 66, 0, 0x0f], // "66 0~3 Bend Range (+) 1~12"
  [P.BEND_RANGE_MINUS, 66, 4, 0x0f], // "66 4~7 Bend Range (-) 1~12"
  [P.LFO_KEY_SYNC, 69, 0, 0x01], // "69 0 LFO Key Sync"
  [P.LFO_BPM_SYNC, 69, 1, 0x01], // "69 1 LFO BPM Sync"
  [P.LFO_VOICE_SYNC, 69, 2, 0x01], // "69 2 LFO Voice Sync"
  [P.PORTAMENTO_BPM, 69, 3, 0x01], // "69 3 Portament BPM"
  [P.PORTAMENTO_MODE, 69, 4, 0x01], // "69 4 Portament Mode 0,1=Auto,On"
  [P.OCTAVE, 73, 0, 0x07], // "73 0~2 KEYBOARD OCTAVE 0~4=-2~+2"
  [P.AMP_VELOCITY, OFF_AMP_VELOCITY, 0, 0xff],
  [P.PORTAMENTO, OFF_PORTAMENTO, 0, 0xff],
  [P.PROGRAM_LEVEL, OFF_PROGRAM_LEVEL, 0, 0xff],
]

// ---------------------------------------------------------------------------
// SLIDER ASSIGN (byte 72, *note P13) — replica SLIDER_ASSIGN_DESTS index ->
// stored hardware id. Korg's printed P13 list (0~28 sequential) is wrong:
// the byte holds sparse panel-parameter ids — hence TABLE 2's own 0~79 range
// column — as independently established by jeffkistler/minilogue-editor
// (display.js SLIDER_ASSIGN choices) and adopted by gazzar/loguetools
// (og.py, "corrected values"). Korg's own monologue MIDIimp *note P12
// documents the same sparse-id scheme for its slider. Anything unmapped
// decodes to the default PITCH BEND (0), same as the mono codec.
// ---------------------------------------------------------------------------
const SLIDER_TO_HW: readonly number[] = [
  77, // 0  PITCH BEND
  78, // 1  GATE TIME
  17, // 2  VCO1 PITCH
  18, // 3  VCO1 SHAPE
  21, // 4  VCO2 PITCH
  22, // 5  VCO2 SHAPE
  25, // 6  CROSS MOD DEPTH
  26, // 7  VCO2 PITCH EG INT
  29, // 8  VCO1 LEVEL
  30, // 9  VCO2 LEVEL
  31, // 10 NOISE LEVEL
  32, // 11 CUTOFF
  33, // 12 RESONANCE
  34, // 13 FILTER EG INT
  40, // 14 AMP EG ATTACK
  41, // 15 AMP EG DECAY
  42, // 16 AMP EG SUSTAIN
  43, // 17 AMP EG RELEASE
  44, // 18 EG ATTACK
  45, // 19 EG DECAY
  46, // 20 EG SUSTAIN
  47, // 21 EG RELEASE
  48, // 22 LFO RATE
  49, // 23 LFO INT
  56, // 24 DELAY HI PASS CUTOFF
  57, // 25 DELAY TIME
  58, // 26 DELAY FEEDBACK
  59, // 27 PORTAMENTO (Portament Time)
  71, // 28 VOICE MODE DEPTH
]
const HW_TO_SLIDER: ReadonlyMap<number, number> = new Map(
  SLIDER_TO_HW.map((hw, i) => [hw, i] as const),
)

// ---------------------------------------------------------------------------
// Motion parameter id mapping (*note S3-1) — hardware id <-> replica param id.
// The published list misprints ids 18~24 (duplicated VCO1 names); corrected by
// symmetry to VCO1/VCO2 PITCH/SHAPE/OCTAVE/WAVE (og-spec.md §15.4). Id 52 is
// printed "LFO TYPE" = LFO WAVE. VOICE MODE / VOICE MODE DEPTH have no id in
// the list, so replica lanes targeting them cannot be encoded.
// ---------------------------------------------------------------------------

const MOTION_ID_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [17, P.VCO1_PITCH],
  [18, P.VCO1_SHAPE],
  [19, P.VCO1_OCTAVE],
  [20, P.VCO1_WAVE],
  [21, P.VCO2_PITCH],
  [22, P.VCO2_SHAPE],
  [23, P.VCO2_OCTAVE],
  [24, P.VCO2_WAVE],
  [25, P.CROSS_MOD],
  [26, P.PITCH_EG_INT],
  [27, P.SYNC],
  [28, P.RING],
  [29, P.VCO1_LEVEL],
  [30, P.VCO2_LEVEL],
  [31, P.NOISE_LEVEL],
  [32, P.CUTOFF],
  [33, P.RESONANCE],
  [34, P.EG_INT], // "34 : CUTOFF EG INT"
  [35, P.CUTOFF_VELOCITY], // "35 : CUTOFF VELOCITY TRACK"
  [36, P.KEYTRACK], // "36 : CUTOFF KEYBOARD TRACK"
  [37, P.FILTER_TYPE], // "37 : CUTOFF TYPE"
  [40, P.AMP_ATTACK],
  [41, P.AMP_DECAY],
  [42, P.AMP_SUSTAIN],
  [43, P.AMP_RELEASE],
  [44, P.EG_ATTACK],
  [45, P.EG_DECAY],
  [46, P.EG_SUSTAIN],
  [47, P.EG_RELEASE],
  [48, P.LFO_RATE],
  [49, P.LFO_INT],
  [50, P.LFO_TARGET],
  [51, P.LFO_EG_MOD], // "51 : LFO EG"
  [52, P.LFO_WAVE], // "52 : LFO TYPE" = LFO WAVE
  [53, P.DELAY_ROUTING],
  [55, P.DELAY_HIPASS],
  [56, P.DELAY_TIME],
  [57, P.DELAY_FEEDBACK],
  [61, MOTION_PITCH_BEND],
  [62, MOTION_GATE_TIME],
]

const HW_TO_MOTION_PARAM: ReadonlyMap<number, number> = new Map(MOTION_ID_PAIRS)
const MOTION_PARAM_TO_HW: ReadonlyMap<number, number> = new Map(
  MOTION_ID_PAIRS.map(([hw, pid]) => [pid, hw] as const),
)

// ---------------------------------------------------------------------------
// Helpers (byte-level utilities shared family-wide: shared/progbin-util.ts)
// ---------------------------------------------------------------------------

/** Replica motion-lane value (raw param units; bend lanes -1..1) -> hardware
 *  motion data byte. Knob params store the top 8 of their 10 bits. */
function encodeMotionByte(pid: number, v: number): number {
  if (pid === MOTION_PITCH_BEND) return clampInt(Math.round(v * 127) + 128, 0, 255)
  if (pid === MOTION_GATE_TIME) return clampInt(v, 0, 127)
  const meta = PARAMS[pid]
  if (!meta) return 0
  if (meta.max > 255) return clampInt(v, 0, 1023) >> 2
  return clampInt(v, meta.min, Math.min(meta.max, 255))
}

/** Hardware motion data byte -> replica lane value. */
function decodeMotionByte(pid: number, b: number): number {
  if (pid === MOTION_PITCH_BEND) return Math.max(-1, Math.min(1, (b - 128) / 127))
  if (pid === MOTION_GATE_TIME) return Math.min(b, 127)
  const meta = PARAMS[pid]
  if (!meta) return 0
  if (meta.max > 255) return b << 2
  return clampParam(pid, b)
}

/** Hardware Data1/Data2 -> MOTION_POINTS lane points. Smooth lanes on
 *  smoothable targets interpolate Data1 -> Data2 (*note S4-2: "a value
 *  interpolated between Data1 and Data2 is played back during the step");
 *  switch-type or smooth-off lanes use Data1 only. */
function spreadMotion(pid: number, smooth: boolean, d1: number, d2: number): number[] {
  const a = decodeMotionByte(pid, d1)
  const pts = new Array<number>(MOTION_POINTS)
  if (!smooth || !MOTION_META.isSmooth(pid)) {
    pts.fill(a)
    return pts
  }
  const b = decodeMotionByte(pid, d2)
  for (let k = 0; k < MOTION_POINTS; k++) {
    const v = a + ((b - a) * k) / (MOTION_POINTS - 1)
    pts[k] = pid === MOTION_PITCH_BEND ? v : Math.round(v)
  }
  return pts
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

export function decodeProgBin(bytes: Uint8Array): Program | null {
  if (bytes.length !== OG_PROG_BIN_SIZE) return null
  if (!hasMagic(bytes, OFF_MAGIC, 'PROG')) return null
  if (!hasMagic(bytes, OFF_SEQD, 'SEQD')) return null

  // Name: 12 ASCII bytes, NUL padded; family normalization (printable-only,
  // trailing whitespace trimmed, empty -> 'Program').
  const prog = initProgram(readFixedAscii(bytes, OFF_NAME, NAME_LEN))

  for (const [pid, hiOff, loOff, shift] of TEN_BIT) {
    const v = (bytes[hiOff] << 2) | ((bytes[loOff] >> shift) & 0x03)
    prog.params[pid] = clampParam(pid, v)
  }
  for (const [pid, off, shift, mask] of BIT_FIELDS) {
    prog.params[pid] = clampParam(pid, (bytes[off] >> shift) & mask)
  }
  prog.params[P.SLIDER_ASSIGN] =
    HW_TO_SLIDER.get(bytes[OFF_SLIDER_ASSIGN]) ?? PARAMS[P.SLIDER_ASSIGN].def

  decodeSeq(bytes, prog.seq)
  return prog
}

function decodeSeq(bytes: Uint8Array, seq: SeqData): void {
  const bpmRaw = clampInt(bytes[OFF_BPM] | ((bytes[OFF_BPM + 1] & 0x0f) << 8), 100, 3000)
  seq.bpm = bpmRaw / 10
  seq.stepLength = clampInt(bytes[OFF_STEP_LENGTH], 1, 16)
  const swing = bytes[OFF_SWING] // signed byte
  seq.swing = clampInt(swing > 127 ? swing - 256 : swing, -75, 75)
  seq.defaultGate = clampInt(bytes[OFF_DEFAULT_GATE], 0, 72)
  seq.stepResolution = clampInt(bytes[OFF_STEP_RESOLUTION], 0, 4)

  const activeMask = bytes[OFF_STEP_ONOFF] | (bytes[OFF_STEP_ONOFF + 1] << 8)
  for (let i = 0; i < NUM_STEPS; i++) seq.activeSteps[i] = (activeMask & (1 << i)) !== 0

  // Step event blocks: note/vel/gate slots (velocity 0 = no event, *note S4).
  for (let i = 0; i < NUM_STEPS; i++) {
    const base = OFF_STEP_EVENTS + i * STEP_EVENT_SIZE
    const notes: number[] = []
    const vels: number[] = []
    const gates: number[] = []
    for (let j = 0; j < HW_NOTES_PER_STEP; j++) {
      const vel = bytes[base + 4 + j]
      if (vel === 0) continue
      notes.push(Math.min(bytes[base + j], 127))
      vels.push(Math.min(vel, 127))
      gates.push(bytes[base + 8 + j] & 0x7f) // bit7 = trigger switch (not modeled)
    }
    seq.steps[i] = { on: notes.length > 0, notes, vels, gates }
  }

  // Motion slots: on/smooth + hardware param id (*note S3), per-step masks,
  // 2 data bytes per step in the event blocks.
  for (let s = 0; s < NUM_MOTION_LANES; s++) {
    const flags = bytes[OFF_MOTION_SLOT + s * 2]
    const hwId = bytes[OFF_MOTION_SLOT + s * 2 + 1]
    const pid = HW_TO_MOTION_PARAM.get(hwId)
    const lane = seq.motion[s]
    if (pid === undefined) {
      // Id 0 = None, or an id the replica does not model: lane off.
      lane.paramId = -1
      lane.on = false
      lane.smooth = false
      for (let i = 0; i < NUM_STEPS; i++) lane.data[i] = null
      continue
    }
    lane.paramId = pid
    lane.on = (flags & 0x01) !== 0
    lane.smooth = (flags & 0x02) !== 0
    const mask = bytes[OFF_MOTION_ONOFF + s * 2] | (bytes[OFF_MOTION_ONOFF + s * 2 + 1] << 8)
    for (let i = 0; i < NUM_STEPS; i++) {
      if ((mask & (1 << i)) === 0) {
        lane.data[i] = null
        continue
      }
      const base = OFF_STEP_EVENTS + i * STEP_EVENT_SIZE + 12 + s * 2
      lane.data[i] = spreadMotion(pid, lane.smooth, bytes[base], bytes[base + 1])
    }
  }
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

export function encodeProgBin(p: Program): Uint8Array {
  const out = new Uint8Array(OG_PROG_BIN_SIZE) // reserved bytes stay 0
  writeMagic(out, OFF_MAGIC, 'PROG')

  // Name: 12 ASCII chars, NUL padded; longer replica names truncate,
  // non-ASCII chars become '?'.
  writeFixedAscii(out, OFF_NAME, NAME_LEN, p.name)

  const val = (pid: number): number => clampParam(pid, p.params[pid] ?? PARAMS[pid].def)
  for (const [pid, hiOff, loOff, shift] of TEN_BIT) {
    const v = val(pid)
    out[hiOff] = (v >> 2) & 0xff
    out[loOff] |= (v & 0x03) << shift
  }
  for (const [pid, off, shift, mask] of BIT_FIELDS) {
    out[off] |= (val(pid) & mask) << shift
  }
  out[OFF_SLIDER_ASSIGN] = SLIDER_TO_HW[val(P.SLIDER_ASSIGN)] ?? SLIDER_TO_HW[0]

  encodeSeq(out, p.seq)
  return out
}

function encodeSeq(out: Uint8Array, seq: SeqData): void {
  writeMagic(out, OFF_SEQD, 'SEQD')

  const bpmRaw = clampInt(seq.bpm * 10, 100, 3000)
  out[OFF_BPM] = bpmRaw & 0xff
  out[OFF_BPM + 1] = (bpmRaw >> 8) & 0x0f
  out[OFF_STEP_LENGTH] = clampInt(seq.stepLength, 1, 16)
  out[OFF_SWING] = clampInt(seq.swing, -75, 75) & 0xff
  out[OFF_DEFAULT_GATE] = clampInt(seq.defaultGate, 0, 72)
  out[OFF_STEP_RESOLUTION] = clampInt(seq.stepResolution, 0, 4)

  let activeMask = 0
  for (let i = 0; i < NUM_STEPS; i++) if (seq.activeSteps[i]) activeMask |= 1 << i
  out[OFF_STEP_ONOFF] = activeMask & 0xff
  out[OFF_STEP_ONOFF + 1] = (activeMask >> 8) & 0xff
  out[OFF_STEP_SWITCH] = 0xff // *note S2: "Set this to 0xff when sending"
  out[OFF_STEP_SWITCH + 1] = 0xff

  for (let i = 0; i < NUM_STEPS; i++) {
    const base = OFF_STEP_EVENTS + i * STEP_EVENT_SIZE
    const st = seq.steps[i]
    // Write the event block whenever the step HAS notes, muted or not: the
    // replica's step on/off only mutes existing content (store.toggleStep),
    // and this format has no mute bit — st.on decodes from event presence,
    // so the mute flag is dropped but the notes survive the roundtrip.
    if (!st || st.notes.length === 0) continue // empty slots (velocity 0 = no event)
    const n = Math.min(st.notes.length, HW_NOTES_PER_STEP)
    for (let j = 0; j < n; j++) {
      out[base + j] = clampInt(st.notes[j] ?? 0, 0, 127)
      out[base + 4 + j] = clampInt(st.vels[j] ?? 100, 1, 127)
      out[base + 8 + j] = clampInt(st.gates[j] ?? seq.defaultGate, 0, 127) // trigger bit 0
    }
  }

  for (let s = 0; s < NUM_MOTION_LANES; s++) {
    const lane = seq.motion[s]
    const hwId = lane ? MOTION_PARAM_TO_HW.get(lane.paramId) : undefined
    if (!lane || hwId === undefined) continue // unmappable target: slot stays 0 = None
    out[OFF_MOTION_SLOT + s * 2] = (lane.on ? 0x01 : 0) | (lane.smooth ? 0x02 : 0)
    out[OFF_MOTION_SLOT + s * 2 + 1] = hwId
    let mask = 0
    for (let i = 0; i < NUM_STEPS; i++) {
      const pts = lane.data[i]
      if (!pts || pts.length === 0) continue
      mask |= 1 << i
      const base = OFF_STEP_EVENTS + i * STEP_EVENT_SIZE + 12 + s * 2
      out[base] = encodeMotionByte(lane.paramId, pts[0])
      out[base + 1] = encodeMotionByte(lane.paramId, pts[pts.length - 1])
    }
    out[OFF_MOTION_ONOFF + s * 2] = mask & 0xff
    out[OFF_MOTION_ONOFF + s * 2 + 1] = (mask >> 8) & 0xff
  }
}

// ---------------------------------------------------------------------------
// Codec object (SynthDef.korgFile)
// ---------------------------------------------------------------------------

export const OG_KORG_FILE: KorgFileCodec = {
  decodeProgBin,
  encodeProgBin,
  product: 'minilogue',
  infoTag: 'minilogue_ProgramInformation',
  progExt: 'mnlgprog',
  libExts: ['mnlglib', 'mnlgpreset'],
}
