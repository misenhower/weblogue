/*
 * Korg prologue prog_bin codec — the librarian's native binary program format
 * (payload of .prlgprog/.prlglib ZIP containers) <-> a replica Program.
 * Layout per docs/hardware/prologue_MIDIImp.txt TABLE 3 'PROGRAM PARAMETER':
 *
 *   0~3     'PROG' magic
 *   4~15    PROGRAM NAME [12] (ASCII, NUL padded)
 *   16~79   program-global block
 *   80~205  TIMBRE 1 PARAMETERS (126 bytes)
 *   206~331 TIMBRE 2 PARAMETERS (same layout)
 *   332~335 'PRED' trailer magic
 *   = 336 bytes total.
 *
 * Byte order: 2-byte fields are little-endian (low byte first). The prologue
 * table prints them "H:0~7 / L:0~7" but the family's own og/monologue tables
 * print the identical BPM field as "L:0~7 / H:0~3" (low first), and real
 * prog_bin dumps (loguetools) are little-endian throughout — the prologue
 * doc's H/L labels are swapped, the bytes are not.
 *
 * 1-based storage: unlike the xd (which stores these same menus 0-based),
 * the prologue stores several menu values with a +1 offset — the replica
 * strips the offset (params.ts), the codec re-applies it (`bias`):
 *   byte 52 SCALE KEY          "1~25=-12Note~+12Note"   = ours 0..24  +1
 *   byte 53 PROGRAM TUNING     "1~101=-50Cent~+50Cent"  = ours 0..100 +1
 *   byte 54 PROGRAM TRANSPOSE  "1~25=-12~+12 Note"      = ours 0..24  +1
 *   byte 55 ARP GATE TIME      "1~73=0~100%"            = ours 0..72  +1
 *   byte 56 ARP RATE           "1~12" vs note P9's 0~10 = ours 0..10  +1
 *   bytes 57~58 DL/RV DRY WET  "1~1025"                 = ours 0..1024 +1
 *   byte 51 MICRO TUNING       "1~140" vs note P8's 0-based list      +1
 *   timbre +77/+120 WHEEL/AT ASSIGN "2~32" vs note P23's 32-entry 0~31
 *     list — an off-by-one doc quirk (params.ts stores the clean P23 index
 *     0..31); stored = index + 1, treating the printed "2" as a doc error
 *     for "1~32" (32 values for 32 entries). UNCONFIRMED on hardware.
 *   byte 74 ARP RANGE stores raw "0~15"; the replica models the OM's 1..4
 *     octaves — stored = octaves - 1 (0-based count). UNCONFIRMED mapping.
 *
 * Unmodeled hardware fields (CATEGORY, FREQUENT/LIKE sort metadata, E.PEDAL
 * ASSIGN, USER ENGINE PARAM1-6 + types, reserved bytes) are ignored on decode
 * and written as 0 on encode. The replica-only params (RP.LF_COMP_*,
 * RP.VOICE_CAP) have no hardware analog: encode writes nothing, decode leaves
 * them at their defaults. The prologue has no SEQD section (no step/motion
 * sequencing, spec §10) — only TEMPO (bytes 24~25) maps to Program.seq.bpm.
 */
import type { KorgFileCodec } from '../def'
import type { Program } from '../../shared/program'
import {
  hasMagic,
  writeMagic,
  readFixedAscii,
  writeFixedAscii,
  buildTuningMaps,
} from '../../shared/progbin-util'
import { P, TIMBRE_BLOCKS, clampParam, type TimbreParamIds } from './params'
import { initProgram } from './program'
import { MICRO_TUNINGS } from './curves'

export const PROG_BIN_SIZE = 336

const OFF_MAGIC = 0 // "0~3 ASCII 'PROG'"
const OFF_NAME = 4 // "4~15 ASCII PROGRAM NAME [12]"
const NAME_LEN = 12
const OFF_TEMPO = 24 // "24~25 300~6000 TEMPO 300~6000=30.0~600.0" (u16 LE)
const OFF_MICRO_TUNING = 51 // "51 1~140 MICRO TUNING *note P8"
const OFF_TIMBRE1 = 80 // "80~205 TIMBRE 1 PARAMETERS"
const OFF_TIMBRE2 = 206 // "206~331 TIMBRE 2 PARAMETERS (same as TIMBRE1)"
const OFF_TRAILER = 332 // "332~335 ASCII 'PRED'"

// ---------------------------------------------------------------------------
// MICRO TUNING (byte 51, note P8) — the replica ships a preset subset of the
// hardware's list (progbin-util.HW_TUNING_NAMES); map replica index <-> P8
// value by name. Hardware-only entries (Ionian/Dorian/Aeolian, AFX*/DC*,
// user slots 128~139) decode to Equal Temp.
// ---------------------------------------------------------------------------
const TUNING = buildTuningMaps(MICRO_TUNINGS)
/** Replica MICRO_TUNINGS index -> hardware note-P8 value. */
export const TUNING_TO_HW: readonly number[] = TUNING.toHw

// ---------------------------------------------------------------------------
// Field table: byte offset -> param id, with `wide` = u16 little-endian and
// `bias` = stored-value offset (stored = replica + bias). Spec rows quoted
// where the mapping is not a plain 1:1 byte.
// ---------------------------------------------------------------------------
interface Field {
  off: number
  id: number
  wide?: true
  bias?: number
}

const GLOBAL_FIELDS: readonly Field[] = [
  { off: 16, id: P.OCTAVE }, // "16 0~4 OCTAVE 0~4=-2~+2"
  { off: 17, id: P.SUB_ON }, // "17 0,1 SUB ON/PGM FETCH"
  { off: 18, id: P.EDIT_TIMBRE }, // "18 0~2 EDIT TIMBRE 0~2=Main,Main+Sub,Sub"
  { off: 19, id: P.TIMBRE_TYPE }, // "19 0~2 TIMBRE TYPE 0~2=Layer,XFade,Split"
  { off: 20, id: P.BALANCE }, // "20 0~127 MAIN/SUB BALANCE"
  { off: 22, id: P.POSITION }, // "22 0,1 MAIN/SUB POSITION"
  { off: 23, id: P.SPLIT_POINT }, // "23 0~127 SPLIT POINT 0~127=C-1~G9"
  // 24~25 TEMPO handled separately (maps to seq.bpm, not a param).
  { off: 26, id: P.ARP_TARGET }, // "26 0~2 ARP TARGET 0~2=Main+Sub,Main,Sub"
  // 29 CATEGORY, 30~33 FREQUENT: sort metadata, unmodeled.
  { off: 37, id: P.AMP_VELOCITY }, // "37 0~127 AMP VELOCITY"
  { off: 38, id: P.PORTAMENTO_MODE }, // "38 0,1 PORTAMENTO MODE 0,1=Auto,On"
  { off: 40, id: P.PROGRAM_LEVEL }, // "40 12~132 PROGRAM LEVEL 12~132=-18dB~+6dB"
  { off: 41, id: P.MODFX_TYPE }, // "41 0~4 MOD EFFECT TYPE *note P2"
  { off: 42, id: P.MODFX_SPEED, wide: true }, // "42~43 0~1023 MOD EFFECT SPEED"
  { off: 44, id: P.MODFX_DEPTH, wide: true }, // "44~45 0~1023 MOD EFFECT DEPTH"
  { off: 46, id: P.MODFX_SUB_CHORUS }, // "46 0~7 MOD EFFECT CHORUS *note P3"
  { off: 47, id: P.MODFX_SUB_ENSEMBLE }, // "47 0~2 MOD EFFECT ENSEMBLE *note P4"
  { off: 48, id: P.MODFX_SUB_PHASER }, // "48 0~7 MOD EFFECT PHASER *note P5"
  { off: 49, id: P.MODFX_SUB_FLANGER }, // "49 0~7 MOD EFFECT FLANGER *note P6"
  { off: 50, id: P.MODFX_SUB_USER }, // "50 0~15 MOD EFFECT USER *note P7"
  // 51 MICRO TUNING handled separately (value map, not a bias).
  { off: 52, id: P.SCALE_KEY, bias: 1 }, // "52 1~25 SCALE KEY 1~25=-12Note~+12Note"
  { off: 53, id: P.PROGRAM_TUNING, bias: 1 }, // "53 1~101 PROGRAM TUNING"
  { off: 54, id: P.PROGRAM_TRANSPOSE, bias: 1 }, // "54 1~25 PROGRAM TRANSPOSE"
  { off: 55, id: P.ARP_GATE, bias: 1 }, // "55 1~73 ARP GATE TIME 1~73=0~100%"
  { off: 56, id: P.ARP_RATE, bias: 1 }, // "56 1~12 ARP RATE *note P9" (P9 is 0~10)
  { off: 57, id: P.DLRV_DRYWET, wide: true, bias: 1 }, // "57~58 1~1025 DELAY/REVERB DRY WET"
  { off: 62, id: P.DLRV_SELECT }, // "62 0~2 DELAY/REVERB TYPE 0~2=OFF,DELAY,REVERB"
  { off: 63, id: P.DLRV_TIME, wide: true }, // "63~64 0~1023 DELAY/REVERB TIME"
  { off: 65, id: P.DLRV_DEPTH, wide: true }, // "65~66 0~1023 DELAY/REVERB DEPTH"
  { off: 67, id: P.REVERB_SUB }, // "67 0~17 REVERB TYPE *note P10"
  { off: 68, id: P.DELAY_SUB }, // "68 0~19 DELAY TYPE *note P11"
  { off: 69, id: P.MODFX_ROUTING }, // "69 0~2 MOD EFFECT ROUTING"
  { off: 70, id: P.DLRV_ROUTING }, // "70 0~2 DELAY/REVERB ROUTING"
  { off: 71, id: P.MODFX_ON }, // "71 0,1 MOD EFFECT ON/OFF"
  { off: 72, id: P.DLRV_ON }, // "72 0,1 DELAY/REVERB ON/OFF"
  { off: 73, id: P.ARP_ON_LATCH }, // "73 0~2 ARPEGGIATOR 0~2=OFF/ON/LATCH"
  { off: 74, id: P.ARP_RANGE, bias: -1 }, // "74 0~15 ARPEGGIATOR RANGE" (ours 1..4 Oct)
  { off: 75, id: P.ARP_TYPE }, // "75 0~15 ARPEGGIATOR TYPE *note P12" (P12 is 0~5)
  // 76~79 LIKE UPPER/LOWER: sort metadata, unmodeled.
]

/** One timbre block's fields (TABLE 3 "+NN" rows), at absolute base 80/206. */
function timbreFields(base: number, t: TimbreParamIds): Field[] {
  return [
    { off: base + 0, id: t.portamento }, // "+0 0~127 PORTAMENTO TIME"
    { off: base + 2, id: t.voiceSpread }, // "+2 0~127 VOICE SPREAD"
    { off: base + 4, id: t.vmDepth, wide: true }, // "+4~5 0~1023 VOICE MODE DEPTH"
    { off: base + 6, id: t.voiceMode }, // "+6 0~3 VOICE MODE TYPE *note P14"
    { off: base + 10, id: t.vco1Wave }, // "+10 0~2 VCO 1 WAVE"
    { off: base + 11, id: t.vco1Octave }, // "+11 0~3 VCO 1 OCTAVE 0~3=2',4',8',16'"
    { off: base + 12, id: t.vco1Pitch, wide: true }, // "+12~13 0~1023 VCO 1 PITCH"
    { off: base + 14, id: t.vco1Shape, wide: true }, // "+14~15 0~1023 VCO 1 SHAPE"
    { off: base + 16, id: t.pitchEgTarget }, // "+16 0~2 PITCH EG TARGET"
    { off: base + 17, id: t.pitchEgInt, wide: true }, // "+17~18 0~1023 PITCH EG INT"
    { off: base + 19, id: t.vco2Wave }, // "+19 0~2 VCO 2 WAVE"
    { off: base + 20, id: t.vco2Octave }, // "+20 0~3 VCO 2 OCTAVE"
    { off: base + 21, id: t.vco2Pitch, wide: true }, // "+21~22 0~1023 VCO 2 PITCH"
    { off: base + 23, id: t.vco2Shape, wide: true }, // "+23~24 0~1023 VCO 2 SHAPE"
    { off: base + 25, id: t.syncRing }, // "+25 0~2 RING/SYNC 0~2=RING ON,OFF,SYNC ON"
    { off: base + 26, id: t.crossMod, wide: true }, // "+26~27 0~1023 CROSS MOD DEPTH"
    { off: base + 28, id: t.multiRouting }, // "+28 0,1 MULTI ROUTING 0,1=Pre VCF,Post VCF"
    { off: base + 29, id: t.multiType }, // "+29 0~2 MULTI TYPE 0~2=NOISE,VPM,USER"
    { off: base + 30, id: t.multiOctave }, // "+30 0~3 MULTI OCTAVE"
    { off: base + 31, id: t.selectNoise }, // "+31 0~3 SELECT NOISE *note P18"
    { off: base + 32, id: t.selectVpm }, // "+32 0~15 SELECT VPM *note P19"
    { off: base + 33, id: t.selectUser }, // "+33 0~15 SELECT USER *note P7"
    { off: base + 34, id: t.shapeNoise, wide: true }, // "+34~35 0~1023 SHAPE NOISE"
    // +36~37 Reserved (no SHIFT SHAPE NOISE on the prologue).
    { off: base + 38, id: t.vco1Level, wide: true }, // "+38~39 0~1023 VCO1 LEVEL"
    { off: base + 40, id: t.vco2Level, wide: true }, // "+40~41 0~1023 VCO2 LEVEL"
    { off: base + 42, id: t.multiLevel, wide: true }, // "+42~43 0~1023 MULTI LEVEL"
    { off: base + 44, id: t.cutoff, wide: true }, // "+44~45 0~1023 CUTOFF"
    { off: base + 46, id: t.resonance, wide: true }, // "+46~47 0~1023 RESONANCE"
    { off: base + 48, id: t.cutoffEgInt, wide: true }, // "+48~49 0~1023 CUTOFF EG INT"
    { off: base + 50, id: t.drive }, // "+50 0~2 CUTOFF DRIVE *note P21"
    { off: base + 51, id: t.lowCut }, // "+51 0,1 LOW CUT"
    { off: base + 52, id: t.keytrack }, // "+52 0~2 CUTOFF KEYBOARD TRACK *note P21"
    { off: base + 53, id: t.egVelocity }, // "+53 0~127 CUTOFF VELOCITY"
    { off: base + 54, id: t.ampAttack, wide: true }, // "+54~55 0~1023 AMP EG ATTACK"
    { off: base + 56, id: t.ampDecay, wide: true }, // "+56~57 0~1023 AMP EG DECAY"
    { off: base + 58, id: t.ampSustain, wide: true }, // "+58~59 0~1023 AMP EG SUSTAIN"
    { off: base + 60, id: t.ampRelease, wide: true }, // "+60~61 0~1023 AMP EG RELEASE"
    { off: base + 62, id: t.egAttack, wide: true }, // "+62~63 0~1023 EG ATTACK"
    { off: base + 64, id: t.egDecay, wide: true }, // "+64~65 0~1023 EG DECAY"
    { off: base + 66, id: t.egSustain, wide: true }, // "+66~67 0~1023 EG SUSTAIN"
    { off: base + 68, id: t.egRelease, wide: true }, // "+68~69 0~1023 EG RELEASE"
    { off: base + 70, id: t.lfoWave }, // "+70 0~2 LFO WAVE"
    { off: base + 71, id: t.lfoMode }, // "+71 0~2 LFO MODE 0~2=BPM,SLOW,FAST"
    { off: base + 72, id: t.lfoRate, wide: true }, // "+72~73 0~1023 LFO RATE"
    { off: base + 74, id: t.lfoInt, wide: true }, // "+74~75 0~1023 LFO INT"
    { off: base + 76, id: t.lfoTarget }, // "+76 0~2 LFO TARGET 0~2=CUTOFF,SHAPE,PITCH"
    { off: base + 77, id: t.wheelAssign, bias: 1 }, // "+77 2~32 MOD WHEEL ASSIGN *note P23"
    // +78 E.PEDAL ASSIGN: unmodeled (encoded 0 = OFF).
    { off: base + 79, id: t.bendRangePlus }, // "+79 0~12 BEND RANGE (+)"
    { off: base + 80, id: t.bendRangeMinus }, // "+80 0~12 BEND RANGE (-)"
    // VPM ENGINE PARAM1-6 — NOTE the irregular spacing: +82/+84/+86 and
    // +89~90 are Reserved, but PARAM4 (+87) and PARAM5 (+88) are adjacent.
    { off: base + 81, id: t.vpmFeedback }, // "+81 0~200 VPM ENGINE PARAM1"
    { off: base + 83, id: t.vpmNoiseDepth }, // "+83 0~200 VPM ENGINE PARAM2"
    { off: base + 85, id: t.vpmShapeModInt }, // "+85 0~200 VPM ENGINE PARAM3"
    { off: base + 87, id: t.vpmModAttack }, // "+87 0~200 VPM ENGINE PARAM4"
    { off: base + 88, id: t.vpmModDecay }, // "+88 0~200 VPM ENGINE PARAM5"
    { off: base + 91, id: t.vpmKeyTrack }, // "+91 0~200 VPM ENGINE PARAM6"
    // +93~+106 USER ENGINE PARAM1-6 + TYPE bitfields: unmodeled (built-ins).
    { off: base + 107, id: t.shapeVpm, wide: true }, // "+107~108 0~1023 SHAPE VPM"
    { off: base + 109, id: t.shiftShapeVpm, wide: true }, // "+109~110 0~1023 SHIFT SHAPE VPM"
    { off: base + 111, id: t.shapeUser, wide: true }, // "+111~112 0~1023 SHAPE USER"
    { off: base + 113, id: t.shiftShapeUser, wide: true }, // "+113~114 0~1023 SHIFT SHAPE USER"
    { off: base + 115, id: t.wheelRange }, // "+115 0~200 MOD WHEEL RANGE 0~200=-100%~+100%"
    { off: base + 116, id: t.lfoKeySync }, // "+116 0,1 LFO KEY SYNC"
    { off: base + 117, id: t.lfoVoiceSync }, // "+117 0,1 LFO VOICE SYNC"
    { off: base + 118, id: t.lfoTargetOsc }, // "+118 0~3 LFO TARGET OSC *note P27"
    { off: base + 119, id: t.egLegato }, // "+119 0,1 MONO LEGATO"
    { off: base + 120, id: t.atAssign, bias: 1 }, // "+120 2~32 MIDI AFTER TOUCH *note P23"
    // +121~125 Reserved.
  ]
}

const FIELDS: readonly Field[] = [
  ...GLOBAL_FIELDS,
  ...timbreFields(OFF_TIMBRE1, TIMBRE_BLOCKS[0]),
  ...timbreFields(OFF_TIMBRE2, TIMBRE_BLOCKS[1]),
]

export function decodeProgBin(bytes: Uint8Array): Program | null {
  if (bytes.length !== PROG_BIN_SIZE || !hasMagic(bytes, OFF_MAGIC, 'PROG')) return null

  // Name: 12 ASCII chars, NUL padded; family normalization (printable-only,
  // trailing whitespace trimmed, empty -> 'Program').
  const p = initProgram(readFixedAscii(bytes, OFF_NAME, NAME_LEN))

  for (const f of FIELDS) {
    const raw = f.wide ? bytes[f.off] | (bytes[f.off + 1] << 8) : bytes[f.off]
    p.params[f.id] = clampParam(f.id, raw - (f.bias ?? 0))
  }

  // MICRO TUNING: stored = note-P8 value + 1; unmappable -> Equal Temp (0).
  const hwTuning = bytes[OFF_MICRO_TUNING] - 1
  p.params[P.MICRO_TUNING] = clampParam(P.MICRO_TUNING, TUNING.fromHw.get(hwTuning) ?? 0)

  // TEMPO 300~6000 = 30.0~600.0 BPM; the replica transport spans 10..300.
  const tempo = bytes[OFF_TEMPO] | (bytes[OFF_TEMPO + 1] << 8)
  p.seq.bpm = Math.max(10, Math.min(300, tempo / 10))

  return p
}

export function encodeProgBin(p: Program): Uint8Array {
  const out = new Uint8Array(PROG_BIN_SIZE) // reserved/unmodeled bytes stay 0
  writeMagic(out, OFF_MAGIC, 'PROG')
  writeMagic(out, OFF_TRAILER, 'PRED')

  // Name: hardware limit 12 chars (ours is 16) — truncate, NUL pad,
  // printable ASCII kept, anything else stored as '?'.
  writeFixedAscii(out, OFF_NAME, NAME_LEN, p.name)

  for (const f of FIELDS) {
    const v = clampParam(f.id, p.params[f.id]) + (f.bias ?? 0)
    out[f.off] = v & 0xff
    if (f.wide) out[f.off + 1] = (v >> 8) & 0xff
  }

  const tuningIdx = clampParam(P.MICRO_TUNING, p.params[P.MICRO_TUNING])
  out[OFF_MICRO_TUNING] = (TUNING_TO_HW[tuningIdx] ?? 0) + 1

  const tempo = Math.max(300, Math.min(6000, Math.round(p.seq.bpm * 10)))
  out[OFF_TEMPO] = tempo & 0xff
  out[OFF_TEMPO + 1] = (tempo >> 8) & 0xff

  return out
}

/** Korg native file support for both prologue variants (programs are
 *  format-identical across prologue-8/-16; def.ts wraps decode per variant
 *  to cap the replica-only VOICE CAP). */
export const PROLOGUE_KORG_FILE: KorgFileCodec = {
  decodeProgBin,
  encodeProgBin,
  product: 'prologue',
  infoTag: 'prologue_ProgramInformation',
  progExt: 'prlgprog',
  libExts: ['prlglib', 'prlgpreset'],
}
