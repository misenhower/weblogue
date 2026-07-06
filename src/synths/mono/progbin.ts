/*
 * Korg monologue prog_bin codec — the librarian's native binary program
 * format (payload of .molgprog/.molglib ZIP containers) <-> a replica
 * Program. Layout per docs/hardware/monologue_MIDIImp.txt (rev 1.00)
 * TABLE 2 'PROGRAM PARAMETER':
 *
 *   0~3     'PROG' magic
 *   4~15    PROGRAM NAME [12] (ASCII, NUL padded)
 *   16~47   panel / program-edit parameters
 *   48~51   'SEQD' magic
 *   52~95   sequence header (BPM, masks, motion slots)
 *   96~447  16 step events, 22 bytes each (note S2)
 *   = 448 bytes total.
 *
 * KNOWN SPEC ERRATA (documented, deliberately deviated from):
 *  - The step-event rows print "96~107 / 108~119" (12-byte ranges), but
 *    note S2 defines a 22-byte record and the table itself ends the run at
 *    "426~447 Step 16" = 96 + 15*22. The true stride is 22 bytes.
 *  - Note P1's per-field table permutes the upper-byte offsets of three
 *    rows ("LFO RATE 26 / LFO INT 27 / EG INT 28") against TABLE 2 proper
 *    ("26 EG INT / 27 LFO RATE / 28 LFO INT"). TABLE 2 wins: its byte-35
 *    low-bit packing (b0-1 EG INT, b2-3 LFO RATE, b4-5 LFO INT, b6-7 DRIVE)
 *    matches note P1's low-bit columns AND the family pattern that low-bit
 *    packing order follows upper-byte order; note P3 (the LFO RATE value
 *    table) is referenced from TABLE 2's offset-27 row, not 26.
 *
 * The format has no per-step mute bit (bytes 64~65 are the Active Step skip
 * mask): st.on decodes from event presence (velocity != 0), so a
 * muted-but-populated step keeps its note but comes back with on=true —
 * content preservation beats flag fidelity.
 *
 * Hardware fields the replica does not model (step-event Trigger Switch
 * byte 4 b7, reserved bytes) are ignored on decode and written 0 on encode.
 * Replica params with no hardware field: SLIDER_RANGE (TABLE 2 stores no
 * slider range — byte 47 is Reserved) keeps its default on decode and is
 * dropped on encode. KEY_TRIG=HOLD (2) is a transport state, not program
 * data: only KEY TRG (1) maps to byte 36 b6 'SEQ TRIG'; HOLD encodes as Off.
 *
 * Motion data resolution: the hardware stores 4 bytes (0~255) per slot per
 * step, but note S2-2 defines the playback semantics as "only Data1 is used
 * if Smooth is Off or the parameter is a switch type; when Smooth is On, a
 * value interpolated between Data1 and Data2 is played back during the
 * step". The codec follows those semantics: encode writes Data1 = our point
 * 1 and Data2..4 = our point 5 (step start -> step end); decode rebuilds the
 * 5-point lane by linear interpolation Data1 -> Data2 (or flat Data1 for
 * stepped/switch lanes). 10-bit knob targets store their upper 8 bits
 * (value >> 2), so motion values quantize to multiples of 4 — the one
 * genuinely lossy field in the format (hardware resolution is coarser than
 * the replica's; see tests/mono-progbin.test.ts).
 */
import type { KorgFileCodec } from '../def'
import {
  type Program,
  type SeqData,
  NUM_STEPS,
  NUM_MOTION_LANES,
  MOTION_POINTS,
} from '../../shared/program'
import { MOTION_PITCH_BEND, MOTION_GATE_TIME } from '../../shared/paramdef'
import {
  clampInt,
  hasMagic,
  writeMagic,
  readFixedAscii,
  writeFixedAscii,
  buildTuningMaps,
} from '../../shared/progbin-util'
import { P, PARAMS, clampParam } from './params'
import { initProgram } from './program'
import { MICRO_TUNINGS } from './curves'

export const PROG_BIN_SIZE = 448

const OFF_MAGIC = 0 // "0~3 ASCII 'PROG'"
const OFF_NAME = 4 // "4~15 ASCII PROGRAM NAME [12]"
const NAME_LEN = 12
const OFF_SEQD = 48 // "48~51 ASCII 'SEQD'"
const OFF_BPM = 52 // "52 L:0~7 / 53 H:0~3 BPM 100~3000=10.0~300.0"
const OFF_STEP_LENGTH = 54 // "54 1~16 Step Length"
const OFF_STEP_RESOLUTION = 55 // "55 0~4 Step Resolutin 1/16,1/8,1/4,1/2,1/1"
const OFF_SWING = 56 // "56 -75~+75 Swing" (two's-complement byte)
const OFF_DEFAULT_GATE = 57 // "57 0~72 Default Gate Time 0~72=0%~100%"
const OFF_ACTIVE_STEPS = 64 // "64~65 Step 1~16 Off/On" (bit n = step n+1)
const OFF_MOTION_STEPS = 66 // "66~67 Step 1~16 Motion Off/On"
const OFF_SLIDE_STEPS = 68 // "68~69 Step 1~16 Slide Off/On"
const OFF_MOTION_SLOTS = 72 // "72~79 Motion Slot 1~4 Parameter" (2 bytes each, note S1)
const OFF_MOTION_MASKS = 80 // "80~87 Motion Slot 1~4 Step 1~16 Off/On" (2 bytes each)
const OFF_STEP_EVENTS = 96 // "96 + n*22 Step Event Data" (note S2; erratum above)
const STEP_EVENT_SIZE = 22

// note S2 record offsets
const EVT_NOTE = 0 // "0 0~127 Note No"
const EVT_VEL = 2 // "2 0,1~127=NoEvent,Velocity1~127"
const EVT_GATE = 4 // "4 b0-6 0~72,73~127=0%~100%,TIE; b7 Trigger switch"
const EVT_MOTION = 6 // "6~21 Motion Slot 1~4 Data 1~4"

// ---------------------------------------------------------------------------
// 10-bit knobs (note P1): upper 8 bits at `hi`, lower 2 bits at `lo` bits
// `shift`..shift+1. Offsets 26~28 follow TABLE 2 proper (erratum above).
// ---------------------------------------------------------------------------
interface TenBit {
  id: number
  hi: number
  lo: number
  shift: number
}

const TEN_BIT_FIELDS: readonly TenBit[] = [
  { id: P.VCO1_PITCH, hi: 16, lo: 30, shift: 0 }, // "16 VCO 1 PITCH (bit2~9)" / "30 b0~1"
  { id: P.VCO1_SHAPE, hi: 17, lo: 30, shift: 2 }, // "17 VCO 1 SHAPE (bit2~9)" / "30 b2~3"
  { id: P.VCO2_PITCH, hi: 18, lo: 31, shift: 0 }, // "18 VCO 2 PITCH (bit2~9)" / "31 b0~1"
  { id: P.VCO2_SHAPE, hi: 19, lo: 31, shift: 2 }, // "19 VCO 2 SHAPE (bit2~9)" / "31 b2~3"
  { id: P.VCO1_LEVEL, hi: 20, lo: 33, shift: 0 }, // "20 VCO 1 LEVEL (bit2~9)" / "33 b0~1"
  { id: P.VCO2_LEVEL, hi: 21, lo: 33, shift: 2 }, // "21 VCO 2 LEVEL (bit2~9)" / "33 b2~3"
  { id: P.CUTOFF, hi: 22, lo: 33, shift: 4 }, // "22 CUTOFF (bit2~9)" / "33 b4~5"
  { id: P.RESONANCE, hi: 23, lo: 33, shift: 6 }, // "23 RESONANCE (bit2~9)" / "33 b6~7"
  { id: P.EG_ATTACK, hi: 24, lo: 34, shift: 2 }, // "24 EG ATTACK (bit2~9)" / "34 b2~3"
  { id: P.EG_DECAY, hi: 25, lo: 34, shift: 4 }, // "25 EG DECAY (bit2~9)" / "34 b4~5"
  { id: P.EG_INT, hi: 26, lo: 35, shift: 0 }, // "26 EG INT (bit2~9)" / "35 b0~1"
  { id: P.LFO_RATE, hi: 27, lo: 35, shift: 2 }, // "27 LFO RATE (bit2~9)" / "35 b2~3"
  { id: P.LFO_INT, hi: 28, lo: 35, shift: 4 }, // "28 LFO INT (bit2~9)" / "35 b4~5"
  { id: P.DRIVE, hi: 29, lo: 35, shift: 6 }, // "29 DRIVE (bit2~9)" / "35 b6~7"
]

// ---------------------------------------------------------------------------
// MICRO TUNING (byte 38, note P11) — the replica ships a preset subset of
// the hardware list (progbin-util.HW_TUNING_NAMES); map replica index <->
// P11 value by name. Hardware-only entries (Ionian/Dorian/Aeolian 8~10,
// AFX001~006 14~19, user scales/octaves 128~139) decode to Equal Temp (0).
// ---------------------------------------------------------------------------
const TUNING = buildTuningMaps(MICRO_TUNINGS)

// ---------------------------------------------------------------------------
// SLIDER ASSIGN (byte 42, note P12) — replica SLIDER_ASSIGN_DESTS index ->
// stored hardware id. Note P12's "22 : VCO 1 LEVEL" is an obvious typo for
// VCO 2 LEVEL (21 is already VCO 1 LEVEL, matching note S1-1). P12 lists
// PORTAMENT (40) but no DRIVE; the replica's 16-dest list (spec §11) has
// DRIVE and no PORTAMENT — DRIVE encodes as its note S1-1 id 37, and a
// stored 40 (or anything unmapped) decodes to the default PITCH BEND (0).
// ---------------------------------------------------------------------------
const SLIDER_TO_HW: readonly number[] = [
  56, // 0  PITCH BEND   "56 : PITCH BEND"
  57, // 1  GATE TIME    "57 : GATE TIME"
  13, // 2  VCO1 PITCH   "13 : VCO 1 PITCH"
  14, // 3  VCO1 SHAPE   "14 : VCO 1 SHAPE"
  17, // 4  VCO2 PITCH   "17 : VCO 2 PITCH"
  18, // 5  VCO2 SHAPE   "18 : VCO 2 SHAPE"
  21, // 6  VCO1 LEVEL   "21 : VCO 1 LEVEL"
  22, // 7  VCO2 LEVEL   "22 : VCO 1 LEVEL" (P12 typo; see above)
  23, // 8  CUTOFF       "23 : CUTOFF"
  24, // 9  RESONANCE    "24 : RESONANCE"
  26, // 10 ATTACK       "26 ; ATTACK"
  27, // 11 DECAY        "27 : DECAY"
  28, // 12 EG INT       "28 : EG INT"
  31, // 13 LFO RATE     "31 : LFO RATE"
  32, // 14 LFO INT      "32 : LFO INT"
  37, // 15 DRIVE        (note S1-1 id; absent from P12 — see above)
]
const HW_TO_SLIDER: ReadonlyMap<number, number> = new Map(
  SLIDER_TO_HW.map((hw, i) => [hw, i] as [number, number]),
)

// ---------------------------------------------------------------------------
// Motion slot Parameter ID (note S1-1) <-> replica param id. 0 = None.
// PITCH BEND / GATE TIME are the replica's virtual motion targets.
// ---------------------------------------------------------------------------
const MOTION_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [13, P.VCO1_PITCH],
  [14, P.VCO1_SHAPE],
  [15, P.VCO1_OCTAVE],
  [16, P.VCO1_WAVE],
  [17, P.VCO2_PITCH],
  [18, P.VCO2_SHAPE],
  [19, P.VCO2_OCTAVE],
  [20, P.VCO2_WAVE],
  [21, P.VCO1_LEVEL],
  [22, P.VCO2_LEVEL],
  [23, P.CUTOFF],
  [24, P.RESONANCE],
  [25, P.SYNC_RING],
  [26, P.EG_ATTACK], // "26 ; ATTACK"
  [27, P.EG_DECAY], // "27 : DECAY"
  [28, P.EG_INT],
  [29, P.EG_TYPE],
  [30, P.EG_TARGET],
  [31, P.LFO_RATE],
  [32, P.LFO_INT],
  [33, P.LFO_TARGET],
  [34, P.LFO_WAVE], // "34 : LFO TYPE"
  [35, P.LFO_MODE],
  [37, P.DRIVE],
  [40, P.PORTAMENTO], // "40 : PORTAMENT"
  [56, MOTION_PITCH_BEND],
  [57, MOTION_GATE_TIME],
]
const HW_TO_MOTION: ReadonlyMap<number, number> = new Map(MOTION_PAIRS)
const MOTION_TO_HW: ReadonlyMap<number, number> = new Map(
  MOTION_PAIRS.map(([hw, pid]) => [pid, hw] as [number, number]),
)

// ---------------------------------------------------------------------------
// Motion value <-> data byte (0~255), per target.
// ---------------------------------------------------------------------------

function isSmoothTarget(pid: number): boolean {
  if (pid === MOTION_PITCH_BEND || pid === MOTION_GATE_TIME) return true
  return PARAMS[pid]?.motionSmooth === true
}

/** Replica motion value (raw param units) -> hardware data byte. */
function motionToByte(pid: number, v: number): number {
  if (pid === MOTION_PITCH_BEND) {
    // Replica bend lanes store -1..1; center 0 <-> 128 exactly.
    const bent = Math.max(-1, Math.min(1, v))
    return Math.max(0, Math.min(255, Math.round(bent * 127) + 128))
  }
  if (pid === MOTION_GATE_TIME) {
    // Gate override 0..72 + TIE (73~127), same units as the gate byte.
    return Math.max(0, Math.min(127, Math.round(v)))
  }
  const meta = PARAMS[pid]
  if (!meta) return 0
  const cv = clampParam(pid, v)
  // 10-bit knobs keep their upper 8 bits; small-range params fit the byte.
  return meta.max > 255 ? cv >> 2 : cv
}

/** Hardware data byte -> replica motion value (raw param units). */
function motionFromByte(pid: number, byte: number): number {
  if (pid === MOTION_PITCH_BEND) return Math.max(-1, Math.min(1, (byte - 128) / 127))
  if (pid === MOTION_GATE_TIME) return Math.min(127, byte)
  const meta = PARAMS[pid]
  if (!meta) return 0
  return clampParam(pid, meta.max > 255 ? byte << 2 : byte)
}

// ---------------------------------------------------------------------------
// Small helpers (byte-level utilities shared family-wide: progbin-util.ts)
// ---------------------------------------------------------------------------

function bits(byte: number, shift: number, width: number): number {
  return (byte >> shift) & ((1 << width) - 1)
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

export function encodeProgBin(p: Program): Uint8Array {
  const b = new Uint8Array(PROG_BIN_SIZE)
  const pv = (id: number): number => clampParam(id, Number.isFinite(p.params[id]) ? p.params[id] : PARAMS[id].def)

  writeMagic(b, OFF_MAGIC, 'PROG')
  // Name: 12 chars max, printable ASCII kept, anything else stored as '?'.
  writeFixedAscii(b, OFF_NAME, NAME_LEN, p.name)

  for (const f of TEN_BIT_FIELDS) {
    const v = pv(f.id)
    b[f.hi] = v >> 2
    b[f.lo] |= (v & 3) << f.shift
  }

  // "30 b4~5 VCO 1 OCTAVE / b6~7 VCO 1 WAVE"
  b[30] |= (pv(P.VCO1_OCTAVE) << 4) | (pv(P.VCO1_WAVE) << 6)
  // "31 b4~5 VCO 2 OCTAVE / b6~7 VCO 2 WAVE"
  b[31] |= (pv(P.VCO2_OCTAVE) << 4) | (pv(P.VCO2_WAVE) << 6)
  // "32 b0~1 SYNC/RING / b2~4 KEYBOARD OCTAVE 0~4=-2~+2"
  b[32] = pv(P.SYNC_RING) | (pv(P.OCTAVE) << 2)
  // "34 b0~1 EG TYPE / b6~7 EG TARGET" (b2~5 are attack/decay low bits)
  b[34] |= pv(P.EG_TYPE) | (pv(P.EG_TARGET) << 6)
  // "36 b0~1 LFO TYPE / b2~3 LFO MODE / b4~5 LFO TARGET / b6 SEQ TRIG"
  // KEY_TRIG: only the KEY TRG state (1) is program data; HOLD (2) is a
  // transport state and encodes as Off.
  b[36] = pv(P.LFO_WAVE) | (pv(P.LFO_MODE) << 2) | (pv(P.LFO_TARGET) << 4) | ((pv(P.KEY_TRIG) === 1 ? 1 : 0) << 6)
  b[37] = pv(P.PROGRAM_TUNING) // "37 0~100 PROGRAM TUNING -50~+50 Cent"
  b[38] = TUNING.toHw[pv(P.MICRO_TUNING)] ?? 0 // "38 0~139 MICRO TUNING *note P11"
  b[39] = pv(P.SCALE_KEY) // "39 0~24 Scale Key -12~+12"
  b[40] = pv(P.SLIDE_TIME) // "40 0~72 Slide Time 0%~100%"
  b[41] = pv(P.PORTAMENTO) // "41 0,1~129=OFF,0~128 Portament Time"
  b[42] = SLIDER_TO_HW[pv(P.SLIDER_ASSIGN)] ?? 56 // "42 Slider Assign *note P12"
  // "43 b0~3 Bend Range (+) 1~12 / b4~7 Bend Range (-) 1~12"
  b[43] = pv(P.BEND_RANGE_PLUS) | (pv(P.BEND_RANGE_MINUS) << 4)
  // "44 b0 Portament Mode / b3 Lfo BPM Sync / b4~5 Cutoff Velocity / b6~7 Cutoff Key Track"
  b[44] = pv(P.PORTAMENTO_MODE) | (pv(P.LFO_BPM_SYNC) << 3) | (pv(P.CUTOFF_VELOCITY) << 4) | (pv(P.CUTOFF_KEYTRACK) << 6)
  b[45] = pv(P.PROGRAM_LEVEL) // "45 77~127 Program Level -25~+25"
  b[46] = pv(P.AMP_VELOCITY) // "46 0~127 Amp Velocity"
  // byte 47 Reserved. SLIDER_RANGE has no hardware field: dropped.

  encodeSeq(b, p.seq)
  return b
}

function encodeSeq(b: Uint8Array, seq: SeqData): void {
  writeMagic(b, OFF_SEQD, 'SEQD')

  const bpm10 = clampInt(seq.bpm * 10, 100, 3000)
  b[OFF_BPM] = bpm10 & 0xff
  b[OFF_BPM + 1] = (bpm10 >> 8) & 0x0f
  b[OFF_STEP_LENGTH] = clampInt(seq.stepLength, 1, 16)
  b[OFF_STEP_RESOLUTION] = clampInt(seq.stepResolution, 0, 4)
  b[OFF_SWING] = clampInt(seq.swing, -75, 75) & 0xff // two's complement
  b[OFF_DEFAULT_GATE] = clampInt(seq.defaultGate, 0, 72)

  for (let i = 0; i < NUM_STEPS; i++) {
    const byte = i >> 3
    const bit = 1 << (i & 7)
    if (seq.activeSteps[i] !== false) b[OFF_ACTIVE_STEPS + byte] |= bit
    if (seq.steps[i]?.slide === true) b[OFF_SLIDE_STEPS + byte] |= bit
    // "Step N Motion Off/On": any slot has data at this step.
    if (seq.motion.some((l) => l.data[i] !== null)) b[OFF_MOTION_STEPS + byte] |= bit
  }

  for (let l = 0; l < NUM_MOTION_LANES; l++) {
    const lane = seq.motion[l]
    if (!lane) continue
    const hwId = MOTION_TO_HW.get(lane.paramId) ?? 0
    // note S1: "0 b0 Motion Off/On / b1 Smooth Off/On; 1 Parameter ID"
    b[OFF_MOTION_SLOTS + 2 * l] = (lane.on && hwId !== 0 ? 1 : 0) | (lane.smooth ? 2 : 0)
    b[OFF_MOTION_SLOTS + 2 * l + 1] = hwId
    if (hwId === 0) continue
    for (let i = 0; i < NUM_STEPS; i++) {
      if (lane.data[i] !== null) b[OFF_MOTION_MASKS + 2 * l + (i >> 3)] |= 1 << (i & 7)
    }
  }

  for (let i = 0; i < NUM_STEPS; i++) {
    const off = OFF_STEP_EVENTS + i * STEP_EVENT_SIZE
    const st = seq.steps[i]
    // Write the event whenever the step HAS a note, muted or not: the
    // replica's step on/off only mutes existing content (store.toggleStep),
    // and this format has no mute bit — st.on decodes from event presence,
    // so the mute flag is dropped but the note survives the roundtrip.
    if (st && st.notes.length > 0) {
      b[off + EVT_NOTE] = clampInt(st.notes[0], 0, 127)
      b[off + EVT_VEL] = clampInt(Number.isFinite(st.vels[0]) ? st.vels[0] : 100, 1, 127)
      // Trigger Switch (b7) is unmodeled: written 0.
      b[off + EVT_GATE] = clampInt(Number.isFinite(st.gates[0]) ? st.gates[0] : seq.defaultGate, 0, 127)
    }
    // else: NoEvent — note 0, velocity 0 (note S2: "0=NoEvent"), gate 0.

    for (let l = 0; l < NUM_MOTION_LANES; l++) {
      const lane = seq.motion[l]
      if (!lane || !MOTION_TO_HW.has(lane.paramId)) continue
      const pts = lane.data[i]
      if (!pts) continue
      const d1 = motionToByte(lane.paramId, pts[0])
      const d2 = lane.smooth && isSmoothTarget(lane.paramId) ? motionToByte(lane.paramId, pts[MOTION_POINTS - 1]) : d1
      const m = off + EVT_MOTION + 4 * l
      b[m] = d1 // Data1: step start
      b[m + 1] = d2 // Data2: step end (note S2-2 interpolates Data1 -> Data2)
      b[m + 2] = d2 // Data3/4: unused by the documented playback; hold the
      b[m + 3] = d2 //   end value so 4-point players stay close.
    }
  }
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

export function decodeProgBin(bytes: Uint8Array): Program | null {
  if (bytes.length !== PROG_BIN_SIZE) return null
  if (!hasMagic(bytes, OFF_MAGIC, 'PROG')) return null
  if (!hasMagic(bytes, OFF_SEQD, 'SEQD')) return null

  // Name: family normalization (printable-only, trailing whitespace
  // trimmed, empty -> 'Program').
  const prog = initProgram(readFixedAscii(bytes, OFF_NAME, NAME_LEN))
  const set = (id: number, v: number): void => {
    prog.params[id] = clampParam(id, v)
  }

  for (const f of TEN_BIT_FIELDS) set(f.id, (bytes[f.hi] << 2) | bits(bytes[f.lo], f.shift, 2))

  set(P.VCO1_OCTAVE, bits(bytes[30], 4, 2))
  set(P.VCO1_WAVE, bits(bytes[30], 6, 2))
  set(P.VCO2_OCTAVE, bits(bytes[31], 4, 2))
  set(P.VCO2_WAVE, bits(bytes[31], 6, 2))
  set(P.SYNC_RING, bits(bytes[32], 0, 2))
  set(P.OCTAVE, bits(bytes[32], 2, 3))
  set(P.EG_TYPE, bits(bytes[34], 0, 2))
  set(P.EG_TARGET, bits(bytes[34], 6, 2))
  set(P.LFO_WAVE, bits(bytes[36], 0, 2))
  set(P.LFO_MODE, bits(bytes[36], 2, 2))
  set(P.LFO_TARGET, bits(bytes[36], 4, 2))
  set(P.KEY_TRIG, bits(bytes[36], 6, 1)) // SEQ TRIG On -> KEY TRG (HOLD is not program data)
  set(P.PROGRAM_TUNING, bytes[37])
  set(P.MICRO_TUNING, TUNING.fromHw.get(bytes[38]) ?? 0) // unmapped/user scales -> Equal Temp
  set(P.SCALE_KEY, bytes[39])
  set(P.SLIDE_TIME, bytes[40])
  set(P.PORTAMENTO, bytes[41])
  set(P.SLIDER_ASSIGN, HW_TO_SLIDER.get(bytes[42]) ?? 0)
  set(P.BEND_RANGE_PLUS, bits(bytes[43], 0, 4))
  set(P.BEND_RANGE_MINUS, bits(bytes[43], 4, 4))
  set(P.PORTAMENTO_MODE, bits(bytes[44], 0, 1))
  set(P.LFO_BPM_SYNC, bits(bytes[44], 3, 1))
  set(P.CUTOFF_VELOCITY, bits(bytes[44], 4, 2))
  set(P.CUTOFF_KEYTRACK, bits(bytes[44], 6, 2))
  set(P.PROGRAM_LEVEL, bytes[45])
  set(P.AMP_VELOCITY, bytes[46])
  // SLIDER_RANGE: no hardware field — stays at its default.

  decodeSeq(bytes, prog.seq)
  return prog
}

function decodeSeq(b: Uint8Array, seq: SeqData): void {
  const bpm10 = b[OFF_BPM] | ((b[OFF_BPM + 1] & 0x0f) << 8)
  seq.bpm = Math.max(10, Math.min(300, bpm10 / 10))
  seq.stepLength = clampInt(b[OFF_STEP_LENGTH], 1, 16)
  seq.stepResolution = clampInt(b[OFF_STEP_RESOLUTION], 0, 4)
  const swing = b[OFF_SWING] < 128 ? b[OFF_SWING] : b[OFF_SWING] - 256
  seq.swing = clampInt(swing, -75, 75)
  seq.defaultGate = clampInt(b[OFF_DEFAULT_GATE], 0, 72)

  for (let i = 0; i < NUM_STEPS; i++) {
    const byte = i >> 3
    const bit = 1 << (i & 7)
    seq.activeSteps[i] = (b[OFF_ACTIVE_STEPS + byte] & bit) !== 0

    const off = OFF_STEP_EVENTS + i * STEP_EVENT_SIZE
    const vel = b[off + EVT_VEL]
    if (vel === 0) {
      seq.steps[i] = { on: false, notes: [], vels: [], gates: [] }
    } else {
      seq.steps[i] = {
        on: true,
        notes: [Math.min(127, b[off + EVT_NOTE])],
        vels: [Math.min(127, vel)],
        gates: [b[off + EVT_GATE] & 0x7f], // b7 = Trigger Switch, unmodeled
      }
    }
    if ((b[OFF_SLIDE_STEPS + byte] & bit) !== 0) seq.steps[i].slide = true
  }

  for (let l = 0; l < NUM_MOTION_LANES; l++) {
    const lane = seq.motion[l]
    const slot = b[OFF_MOTION_SLOTS + 2 * l]
    const pid = HW_TO_MOTION.get(b[OFF_MOTION_SLOTS + 2 * l + 1]) ?? -1
    if (pid === -1) continue // None / unmappable target: lane stays unassigned+off
    lane.paramId = pid
    lane.on = (slot & 1) !== 0
    lane.smooth = (slot & 2) !== 0
    const smooth = lane.smooth && isSmoothTarget(pid)
    for (let i = 0; i < NUM_STEPS; i++) {
      const stepBit = 1 << (i & 7)
      const masked =
        (b[OFF_MOTION_MASKS + 2 * l + (i >> 3)] & stepBit) !== 0 &&
        (b[OFF_MOTION_STEPS + (i >> 3)] & stepBit) !== 0 // per-step motion switch
      if (!masked) {
        lane.data[i] = null
        continue
      }
      const m = OFF_STEP_EVENTS + i * STEP_EVENT_SIZE + EVT_MOTION + 4 * l
      const v1 = motionFromByte(pid, b[m])
      const pts = new Array<number>(MOTION_POINTS)
      if (smooth) {
        // note S2-2: interpolate Data1 -> Data2 across the step; spread onto
        // our 5 points (matches presets.ts ramp5's rounding exactly).
        const v2 = motionFromByte(pid, b[m + 1])
        for (let k = 0; k < MOTION_POINTS; k++) {
          const v = v1 + ((v2 - v1) * k) / (MOTION_POINTS - 1)
          pts[k] = pid === MOTION_PITCH_BEND ? v : Math.round(v)
        }
      } else {
        for (let k = 0; k < MOTION_POINTS; k++) pts[k] = v1
      }
      lane.data[i] = pts
    }
  }
}

// ---------------------------------------------------------------------------
// The codec object wired into MONO_DEF (src/synths/mono/def.ts).
// ---------------------------------------------------------------------------
export const MONO_KORG_FILE: KorgFileCodec = {
  decodeProgBin,
  encodeProgBin,
  product: 'monologue',
  infoTag: 'monologue_ProgramInformation',
  progExt: 'molgprog',
  libExts: ['molglib', 'molgpreset'],
}
