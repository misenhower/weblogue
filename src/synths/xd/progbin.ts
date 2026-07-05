/*
 * minilogue xd prog_bin codec — the 1024-byte binary program blob carried in
 * .mnlgxdprog / .mnlgxdlib containers (Prog_NNN.prog_bin entries).
 *
 * Layout is docs/hardware/minilogue_xd_MIDIImp.txt TABLE 2 "PROGRAM
 * PARAMETER": 'PROG' magic at 0, name[12] at 4, panel/menu parameters up to
 * 155, 'PRED' at 156, then the sequencer section headed by 'SQ' at 160
 * (2-byte active-step mask follows; legacy Ver1.xx files carry a 4-byte
 * 'SEQD' header instead — *note S1 — with implicit all-on active steps),
 * 16 x 52-byte step event blocks at 190, ARP gate/rate at 1022/1023.
 *
 * Replica params are deliberately kept in raw hardware units, so most fields
 * map 1:1. Known deviations are commented inline with the spec row quoted.
 *
 * Byte order: all 2-byte fields are little-endian (low byte first). TABLE 2
 * prints the knob rows "H:0~7 / L:0~7" but its own BPM row is "L / H", and
 * every independent decoder of real xd blobs (loguetools' xd table `<H`,
 * xd-patch's DataView.getInt16(off, true) over live sysex dumps) reads them
 * little-endian — the doc's H/L labels are swapped, the bytes are not. Same
 * conclusion as the prologue codec (see src/synths/prologue/progbin.ts).
 */
import {
  NUM_STEPS,
  NUM_MOTION_LANES,
  NOTES_PER_STEP,
  MOTION_POINTS,
  type Program,
  type SeqStep,
} from '../../shared/program'
import { MOTION_PITCH_BEND, MOTION_GATE_TIME } from '../../shared/paramdef'
import {
  clampInt,
  hasMagic,
  writeMagic,
  readFixedAscii,
  writeFixedAscii,
} from '../../shared/progbin-util'
import type { KorgFileCodec } from '../def'
import { P, clampParam } from './params'
import { initProgram } from './program'

export const XD_PROG_BIN_SIZE = 1024

// ---------------------------------------------------------------------------
// Offsets (TABLE 2)
// ---------------------------------------------------------------------------
const OFF_MAGIC = 0 // "|  0~3  | ASCII | 'PROG' |"
const OFF_NAME = 4 // "|  4~15 | ASCII | PROGRAM NAME [12] *note P1 |"
const NAME_LEN = 12
const OFF_KEY_TRIG = 18 // "| 18 | 0,1 | KEY TRIG |" — not modeled by the replica
const OFF_VOICE_MODE_TYPE = 21 // "| 21 | 1~4 | VOICE MODE TYPE *note P3 |" (hw is 1-based, ours 0-based)
const OFF_SYNC = 34 // "| 34 | 0,1 | SYNC 0,1=SYNC ON, SYNC OFF |" — INVERTED vs our Off/On switch
const OFF_RING = 35 // "| 35 | 0,1 | RING 0,1=RING ON, RING OFF |" — INVERTED vs our Off/On switch
const OFF_MODFX_TYPE = 89 // "| 89 | 1~5 | MOD FX TYPE *note P12 |" (hw is 1-based, ours 0-based)
const OFF_MICRO_TUNING = 122 // "| 122 | 0~139 | MICRO TUNING *note P21 |"
const OFF_TRANSPOSE = 150 // "| 150 | 1~25 | PROGRAM TRANSPOSE -12~+12 Note |" (hw is 1-based, ours 0..24)
const OFF_PRED = 156 // "| 156~159 | ASCII | 'PRED' |"
const OFF_SEQ_MAGIC = 160 // "| 160~161 | ASCII | 'SQ' *note S1 |"
const OFF_ACTIVE_STEP = 162 // "| 162..163 | Step 1..16 Active Step Off/On |" (bit i = step i+1)
const OFF_BPM = 164 // "| 164 L:0~7 | 165 H:0~3 | 100~3000 = 10.0~300.0 |" (little-endian, 12 bits)
const OFF_STEP_LENGTH = 166 // "| 166 | 1~16 | Step Length |"
const OFF_STEP_RESOLUTION = 167 // "| 167 | 0~4 | Step Resolution 1/16..1/1 |"
const OFF_SWING = 168 // "| 168 | -75~+75 | Swing |" stored biased: 0,75,150 = -75%,0,+75% (loguetools)
const OFF_DEFAULT_GATE = 169 // "| 169 | 0~72 | Default Gate Time 0%~100% |"
const OFF_STEP_ON = 170 // "| 170..171 | Step 1..16 Off/On |"
const OFF_STEP_MOTION_ON = 172 // "| 172..173 | Step 1..16 Motion Off/On |"
const OFF_MOTION_SLOT = 174 // "| 174~175 | Motion Slot 1 Parameter *note S2 |" (2 bytes/slot: flags, hw param id)
const OFF_MOTION_STEP_MASK = 182 // "| 182~183 | Motion Slot 1 Step Off/On |" (2 bytes/slot)
const OFF_STEP_EVENT = 190 // "| 190~241 | Step 1 Event Data *note S3 |"
const STEP_EVENT_SIZE = 52 // note S3: 8 notes + 8 velocities + 8 gates + 4 x 7-byte motion slots
const EVT_NOTES = 0 // note S3: "| 0..7 | Note No (1..8) |"
const EVT_VELS = 8 // note S3: "| 8..15 | Velocity No (1..8) 0,1~127=NoEvent,Velocity1~127 |"
const EVT_GATES = 16 // note S3: "| 16..23 | bit0-6 Gate time, bit7 Trigger switch |"
const EVT_MOTION = 24 // note S3: "| 24~30 | Motion Slot 1 *note S3-2 |" (7 bytes/slot)
const MOTION_SLOT_BYTES = 7
const OFF_ARP_GATE = 1022 // "| 1022 | 0~72 | ARP Gate Time |"
// "| 1023 | 0~10 | ARP Rate *note S4 |". Caveat: loguetools remarks the S4
// list "seems to be off by 1 in Korg's docs" (they write 5, not 4, to get
// 16th notes); we follow the spec's 0~10 until real-file evidence says else.
const OFF_ARP_RATE = 1023

// ---------------------------------------------------------------------------
// Parameter field tables — replica param id <-> blob offset, no value
// transformation beyond clamping (raw ranges mirror hardware).
// ---------------------------------------------------------------------------

/** Single-byte fields: [offset, paramId]. */
const BYTE_FIELDS: ReadonlyArray<readonly [number, number]> = [
  [16, P.OCTAVE], // "| 16 | 0~4 | OCTAVE 0~4=-2~+2 |"
  [17, P.PORTAMENTO], // "| 17 | PORTAMENTO 0~127 |"
  [22, P.VCO1_WAVE],
  [23, P.VCO1_OCTAVE],
  [28, P.VCO2_WAVE],
  [29, P.VCO2_OCTAVE],
  [38, P.MULTI_TYPE],
  [39, P.SELECT_NOISE],
  [40, P.SELECT_VPM],
  [41, P.SELECT_USER], // "| 41 | 0~15 | SELECT USER |" — clamped to the replica's 4 stand-in slots
  [64, P.DRIVE],
  [65, P.KEYTRACK],
  [80, P.EG_TARGET],
  [81, P.LFO_WAVE],
  [82, P.LFO_MODE],
  [87, P.LFO_TARGET],
  [88, P.MODFX_ON],
  [90, P.MODFX_SUB_CHORUS],
  [91, P.MODFX_SUB_ENSEMBLE],
  [92, P.MODFX_SUB_PHASER],
  [93, P.MODFX_SUB_FLANGER],
  [94, P.MODFX_SUB_USER], // "| 94 | 0~15 | MOD FX USER |" — clamped to the replica's 2 user FX
  [99, P.DELAY_ON],
  [100, P.DELAY_SUB], // "| 100 | 0~19 | DELAY SUB TYPE |" — 12..19 are USER slots, clamped away
  [105, P.REVERB_ON],
  [106, P.REVERB_SUB], // "| 106 | 0~19 | REVERB SUB TYPE |" — 10..17 are USER slots, clamped away
  [111, P.BEND_RANGE_PLUS],
  [112, P.BEND_RANGE_MINUS],
  [113, P.JOY_ASSIGN_PLUS], // *note P19 order matches JOY_ASSIGN_DESTS 1:1 (verified)
  [114, P.JOY_RANGE_PLUS],
  [115, P.JOY_ASSIGN_MINUS],
  [116, P.JOY_RANGE_MINUS],
  [123, P.SCALE_KEY],
  [124, P.PROGRAM_TUNING],
  [125, P.LFO_KEY_SYNC],
  [126, P.LFO_VOICE_SYNC],
  [127, P.LFO_TARGET_OSC],
  [128, P.EG_VELOCITY], // "| 128 | 0~127 | CUTOFF VELOCITY |"
  [129, P.AMP_VELOCITY],
  [130, P.MULTI_OCTAVE],
  [131, P.MULTI_ROUTING],
  [132, P.EG_LEGATO],
  [133, P.PORTAMENTO_MODE],
  [134, P.PORTAMENTO_BPM],
  [135, P.PROGRAM_LEVEL], // "| 135 | 12~132 | PROGRAM LEVEL -18dB~+6dB |"
  [136, P.VPM_FEEDBACK],
  [137, P.VPM_NOISE_DEPTH],
  [138, P.VPM_SHAPE_MOD_INT],
  [139, P.VPM_MOD_ATTACK],
  [140, P.VPM_MOD_DECAY],
  [141, P.VPM_KEY_TRACK],
  [155, P.MIDI_AT_ASSIGN],
  [OFF_ARP_GATE, P.ARP_GATE],
  [OFF_ARP_RATE, P.ARP_RATE],
]

/**
 * Two-byte fields, little-endian (low byte at `off`, high byte at `off+1` —
 * TABLE 2's "H / L" row labels are swapped, see header). 10-bit knobs
 * (0~1023) and the two 0~1024 dry/wet fields at 151/153.
 */
const WORD_FIELDS: ReadonlyArray<readonly [number, number]> = [
  [19, P.VM_DEPTH],
  [24, P.VCO1_PITCH],
  [26, P.VCO1_SHAPE],
  [30, P.VCO2_PITCH],
  [32, P.VCO2_SHAPE],
  [36, P.CROSS_MOD],
  [42, P.SHAPE_NOISE],
  [44, P.SHAPE_VPM],
  [46, P.SHAPE_USER],
  [48, P.SHIFTSHAPE_NOISE],
  [50, P.SHIFTSHAPE_VPM],
  [52, P.SHIFTSHAPE_USER],
  [54, P.VCO1_LEVEL],
  [56, P.VCO2_LEVEL],
  [58, P.MULTI_LEVEL],
  [60, P.CUTOFF],
  [62, P.RESONANCE],
  [66, P.AMP_ATTACK],
  [68, P.AMP_DECAY],
  [70, P.AMP_SUSTAIN],
  [72, P.AMP_RELEASE],
  [74, P.EG_ATTACK],
  [76, P.EG_DECAY],
  [78, P.EG_INT],
  [83, P.LFO_RATE],
  [85, P.LFO_INT],
  [95, P.MODFX_TIME],
  [97, P.MODFX_DEPTH],
  [101, P.DELAY_TIME],
  [103, P.DELAY_DEPTH],
  [107, P.REVERB_TIME],
  [109, P.REVERB_DEPTH],
  [151, P.DELAY_DRYWET], // "| 151 H / 152 L | 0~1024 | DELAY DRY WET |"
  [153, P.REVERB_DRYWET], // "| 153 H / 154 L | 0~1024 | REVERB DRY WET |"
]

/**
 * MICRO TUNING (*note P21): hardware ids 0~139 with a gap — 8~10 are
 * Ionian/Dorian/Aeolian, 14~22 AFX/DC sets and 128~139 user slots, none of
 * which the replica models. Replica menu indices 0..10 map as follows.
 */
const MICRO_TUNING_TO_HW: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 11, 12, 13]
const MICRO_TUNING_FROM_HW = new Map<number, number>(MICRO_TUNING_TO_HW.map((hw, ours) => [hw, ours]))

/**
 * Motion slot parameter ids (*note S2-1) <-> replica param ids. Hardware ids
 * absent here (32 SELECT USER, 44 DRIVE, anything else) are not
 * motion-recordable in the replica: such lanes decode as unassigned/off.
 */
const MOTION_ID_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [15, P.PORTAMENTO],
  [16, P.VM_DEPTH],
  [17, P.VOICE_MODE],
  [18, P.VCO1_WAVE],
  [19, P.VCO1_OCTAVE],
  [20, P.VCO1_PITCH],
  [21, P.VCO1_SHAPE],
  [22, P.VCO2_WAVE],
  [23, P.VCO2_OCTAVE],
  [24, P.VCO2_PITCH],
  [25, P.VCO2_SHAPE],
  [26, P.SYNC],
  [27, P.RING],
  [28, P.CROSS_MOD],
  [29, P.MULTI_TYPE],
  [30, P.SELECT_NOISE],
  [31, P.SELECT_VPM],
  [33, P.SHAPE_NOISE],
  [34, P.SHAPE_VPM],
  [35, P.SHAPE_USER],
  [36, P.SHIFTSHAPE_NOISE],
  [37, P.SHIFTSHAPE_VPM],
  [38, P.SHIFTSHAPE_USER],
  [39, P.VCO1_LEVEL],
  [40, P.VCO2_LEVEL],
  [41, P.MULTI_LEVEL],
  [42, P.CUTOFF],
  [43, P.RESONANCE],
  [45, P.KEYTRACK],
  [46, P.AMP_ATTACK],
  [47, P.AMP_DECAY],
  [48, P.AMP_SUSTAIN],
  [49, P.AMP_RELEASE],
  [50, P.EG_ATTACK],
  [51, P.EG_DECAY],
  [52, P.EG_INT],
  [53, P.EG_TARGET],
  [54, P.LFO_WAVE],
  [55, P.LFO_MODE],
  [56, P.LFO_RATE],
  [57, P.LFO_INT],
  [58, P.LFO_TARGET],
  [59, P.MODFX_ON],
  [66, P.MODFX_TIME],
  [67, P.MODFX_DEPTH],
  [68, P.DELAY_ON],
  [70, P.DELAY_TIME],
  [71, P.DELAY_DEPTH],
  [72, P.REVERB_ON],
  [74, P.REVERB_TIME],
  [75, P.REVERB_DEPTH],
  [126, MOTION_PITCH_BEND], // "126 : PITCH BEND"
  [129, MOTION_GATE_TIME], // "129 : GATE TIME"
]
const MOTION_HW_TO_OURS = new Map<number, number>(MOTION_ID_PAIRS)
const MOTION_OURS_TO_HW = new Map<number, number>(MOTION_ID_PAIRS.map(([hw, ours]) => [ours, hw]))

// ---------------------------------------------------------------------------
// Helpers (byte-level utilities shared family-wide: shared/progbin-util.ts)
// ---------------------------------------------------------------------------

/**
 * Motion values are 10-bit on hardware. Replica lanes store raw param units:
 * identical for real targets and GATE TIME (0..127); PITCH BEND lanes store
 * -1..1 floats, mapped to 0..1023 (center 511.5) — a 10-bit quantization,
 * the one motion field that does not roundtrip bit-exactly.
 */
function motionValToHw(pid: number, v: number): number {
  if (pid === MOTION_PITCH_BEND) return clampInt((Math.max(-1, Math.min(1, v)) + 1) * 511.5, 0, 1023)
  return clampInt(v, 0, 1023)
}

function motionValFromHw(pid: number, raw: number): number {
  if (pid === MOTION_PITCH_BEND) return raw / 511.5 - 1
  if (pid === MOTION_GATE_TIME) return Math.min(127, raw) // gate override units: 0..72 = %, >=73 TIE
  return clampParam(pid, raw)
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

export function decodeProgBin(bytes: Uint8Array): Program | null {
  if (bytes.length !== XD_PROG_BIN_SIZE) return null
  if (!hasMagic(bytes, OFF_MAGIC, 'PROG')) return null
  const b = bytes

  const prog = initProgram()

  // Name: 12 ASCII bytes (*note P1), zero-padded; family normalization
  // (printable-only, trailing whitespace trimmed, empty -> 'Program').
  prog.name = readFixedAscii(b, OFF_NAME, NAME_LEN)

  const set = (id: number, v: number): void => {
    prog.params[id] = clampParam(id, v)
  }

  for (const [off, id] of BYTE_FIELDS) set(id, b[off])
  for (const [off, id] of WORD_FIELDS) set(id, b[off] | (b[off + 1] << 8))

  // "| 21 | 1~4 | VOICE MODE TYPE |": 1~4=ARP,CHORD,UNISON,POLY; ours 0~3.
  set(P.VOICE_MODE, b[OFF_VOICE_MODE_TYPE] - 1)
  // "| 89 | 1~5 | MOD FX TYPE |": 1~5=CHORUS..USER; ours 0~4.
  set(P.MODFX_TYPE, b[OFF_MODFX_TYPE] - 1)
  // "| 150 | 1~25 | PROGRAM TRANSPOSE -12~+12 |": ours 0~24.
  set(P.PROGRAM_TRANSPOSE, b[OFF_TRANSPOSE] - 1)
  // "0,1=SYNC ON, SYNC OFF": hardware 0 means ON — inverted vs our Off/On.
  set(P.SYNC, b[OFF_SYNC] === 0 ? 1 : 0)
  set(P.RING, b[OFF_RING] === 0 ? 1 : 0)
  set(P.MICRO_TUNING, MICRO_TUNING_FROM_HW.get(b[OFF_MICRO_TUNING]) ?? 0)

  // ---- sequencer section ----
  const seq = prog.seq

  // *note S1: Ver1.xx files carry 'SEQD' where 'SQ' + active-step mask live;
  // for those, active steps are implicitly all on.
  const legacySeqd = hasMagic(b, OFF_SEQ_MAGIC, 'SEQD')
  if (!legacySeqd) {
    for (let i = 0; i < NUM_STEPS; i++) {
      seq.activeSteps[i] = (b[OFF_ACTIVE_STEP + (i >> 3)] >> (i & 7) & 1) === 1
    }
  }

  const bpmRaw = b[OFF_BPM] | ((b[OFF_BPM + 1] & 0x0f) << 8) // L at 164, H bits 0~3 at 165
  seq.bpm = clampInt(bpmRaw, 100, 3000) / 10
  seq.stepLength = clampInt(b[OFF_STEP_LENGTH], 1, 16)
  seq.stepResolution = clampInt(b[OFF_STEP_RESOLUTION], 0, 4)
  seq.swing = clampInt(b[OFF_SWING] - 75, -75, 75) // biased: 0,75,150 = -75%,0,+75%
  seq.defaultGate = clampInt(b[OFF_DEFAULT_GATE], 0, 72)

  for (let i = 0; i < NUM_STEPS; i++) {
    const evt = OFF_STEP_EVENT + i * STEP_EVENT_SIZE
    const stepOn = (b[OFF_STEP_ON + (i >> 3)] >> (i & 7) & 1) === 1
    const notes: number[] = []
    const vels: number[] = []
    const gates: number[] = []
    for (let j = 0; j < NOTES_PER_STEP; j++) {
      const vel = b[evt + EVT_VELS + j]
      if (vel === 0) continue // "0,1~127=NoEvent,Velocity1~127"
      notes.push(Math.min(127, b[evt + EVT_NOTES + j]))
      vels.push(Math.min(127, vel))
      gates.push(b[evt + EVT_GATES + j] & 0x7f) // bit7 is the trigger switch
    }
    const st: SeqStep = { on: stepOn && notes.length > 0, notes, vels, gates }
    seq.steps[i] = st
  }

  for (let l = 0; l < NUM_MOTION_LANES; l++) {
    const lane = seq.motion[l]
    const flags = b[OFF_MOTION_SLOT + l * 2] // *note S2: bit0 on, bit1 smooth
    const hwId = b[OFF_MOTION_SLOT + l * 2 + 1]
    const pid = MOTION_HW_TO_OURS.get(hwId)
    if (pid === undefined) {
      // Unmappable target (None, SELECT USER, DRIVE, garbage): lane off.
      lane.paramId = -1
      lane.on = false
      lane.smooth = false
      continue
    }
    lane.paramId = pid
    lane.on = (flags & 1) === 1
    lane.smooth = (flags & 2) === 2
    for (let i = 0; i < NUM_STEPS; i++) {
      const has = (b[OFF_MOTION_STEP_MASK + l * 2 + (i >> 3)] >> (i & 7) & 1) === 1
      if (!has) continue // lane.data[i] stays null
      const md = OFF_STEP_EVENT + i * STEP_EVENT_SIZE + EVT_MOTION + l * MOTION_SLOT_BYTES
      const pts: number[] = []
      for (let k = 0; k < MOTION_POINTS; k++) {
        // *note S3-2: byte k = bits 2-9; bits 0-1 packed 4-per-byte at +5/+6.
        const lo = (b[md + 5 + (k >> 2)] >> ((k & 3) * 2)) & 3
        pts.push(motionValFromHw(pid, (b[md + k] << 2) | lo))
      }
      lane.data[i] = pts
    }
  }

  return prog
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

export function encodeProgBin(p: Program): Uint8Array {
  const b = new Uint8Array(XD_PROG_BIN_SIZE) // unmodeled fields (KEY TRIG, CV IN, USER PARAMs) stay 0
  writeMagic(b, OFF_MAGIC, 'PROG')
  writeMagic(b, OFF_PRED, 'PRED')
  writeMagic(b, OFF_SEQ_MAGIC, 'SQ')

  // Name: truncate to the hardware's 12 chars, printable ASCII only.
  writeFixedAscii(b, OFF_NAME, NAME_LEN, p.name)

  const raw = (id: number): number => clampParam(id, p.params[id] ?? 0)

  for (const [off, id] of BYTE_FIELDS) b[off] = raw(id)
  for (const [off, id] of WORD_FIELDS) {
    const v = raw(id)
    b[off] = v & 0xff // little-endian: low byte first
    b[off + 1] = (v >> 8) & 0x07 // 0~1024 needs 3 high bits
  }

  b[OFF_KEY_TRIG] = 0 // not modeled; hardware init = Off
  b[OFF_VOICE_MODE_TYPE] = raw(P.VOICE_MODE) + 1 // hw 1~4
  b[OFF_MODFX_TYPE] = raw(P.MODFX_TYPE) + 1 // hw 1~5
  b[OFF_TRANSPOSE] = raw(P.PROGRAM_TRANSPOSE) + 1 // hw 1~25
  b[OFF_SYNC] = raw(P.SYNC) ? 0 : 1 // hw 0 = SYNC ON (inverted)
  b[OFF_RING] = raw(P.RING) ? 0 : 1 // hw 0 = RING ON (inverted)
  b[OFF_MICRO_TUNING] = MICRO_TUNING_TO_HW[raw(P.MICRO_TUNING)] ?? 0

  // ---- sequencer section ----
  const seq = p.seq

  for (let i = 0; i < NUM_STEPS; i++) {
    if (seq.activeSteps[i]) b[OFF_ACTIVE_STEP + (i >> 3)] |= 1 << (i & 7)
  }

  const bpm = clampInt(seq.bpm * 10, 100, 3000)
  b[OFF_BPM] = bpm & 0xff
  b[OFF_BPM + 1] = (bpm >> 8) & 0x0f
  b[OFF_STEP_LENGTH] = clampInt(seq.stepLength, 1, 16)
  b[OFF_STEP_RESOLUTION] = clampInt(seq.stepResolution, 0, 4)
  b[OFF_SWING] = clampInt(seq.swing, -75, 75) + 75 // biased: 0,75,150 = -75%,0,+75%
  b[OFF_DEFAULT_GATE] = clampInt(seq.defaultGate, 0, 72)

  for (let i = 0; i < NUM_STEPS; i++) {
    const st = seq.steps[i]
    const evt = OFF_STEP_EVENT + i * STEP_EVENT_SIZE
    // The Step Off/On mask carries the mute independently of the event data,
    // so a muted-but-populated step keeps its notes/vels/gates in the blob.
    if (st.on) b[OFF_STEP_ON + (i >> 3)] |= 1 << (i & 7)
    const n = Math.min(st.notes.length, NOTES_PER_STEP)
    for (let j = 0; j < n; j++) {
      b[evt + EVT_NOTES + j] = clampInt(st.notes[j], 0, 127)
      b[evt + EVT_VELS + j] = clampInt(st.vels[j] ?? 100, 1, 127) // 0 would mean NoEvent
      // bit7 = trigger switch: notes present at this step are (re)triggered.
      b[evt + EVT_GATES + j] = (clampInt(st.gates[j] ?? seq.defaultGate, 0, 127) & 0x7f) | 0x80
    }
  }

  for (let l = 0; l < NUM_MOTION_LANES; l++) {
    const lane = seq.motion[l]
    const hwId = MOTION_OURS_TO_HW.get(lane.paramId)
    if (hwId === undefined) continue // unassigned/unmappable lane: slot stays None/off
    b[OFF_MOTION_SLOT + l * 2] = (lane.on ? 1 : 0) | (lane.smooth ? 2 : 0)
    b[OFF_MOTION_SLOT + l * 2 + 1] = hwId
    for (let i = 0; i < NUM_STEPS; i++) {
      const data = lane.data[i]
      if (!data) continue
      b[OFF_MOTION_STEP_MASK + l * 2 + (i >> 3)] |= 1 << (i & 7)
      // Per-step "Motion Off/On" summary mask (172~173). Deliberately
      // write-only: encode keeps it in sync for librarian/hardware readers,
      // but decode trusts the per-slot masks (182+) alone, so a real file
      // whose summary bits are stale can never lose recorded motion data.
      b[OFF_STEP_MOTION_ON + (i >> 3)] |= 1 << (i & 7)
      const md = OFF_STEP_EVENT + i * STEP_EVENT_SIZE + EVT_MOTION + l * MOTION_SLOT_BYTES
      for (let k = 0; k < MOTION_POINTS; k++) {
        const v = motionValToHw(lane.paramId, data[Math.min(k, data.length - 1)])
        b[md + k] = (v >> 2) & 0xff
        b[md + 5 + (k >> 2)] |= (v & 3) << ((k & 3) * 2)
      }
    }
  }

  return b
}

export const XD_KORG_FILE: KorgFileCodec = {
  decodeProgBin,
  encodeProgBin,
  product: 'minilogue xd',
  infoTag: 'xd_ProgramInformation',
  progExt: 'mnlgxdprog',
  libExts: ['mnlgxdlib'],
}
