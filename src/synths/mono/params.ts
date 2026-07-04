/*
 * Korg monologue parameter table — single source of truth for every program
 * parameter of the monologue definition. Ids are stable and append-only; raw
 * ranges mirror the hardware (see docs/monologue-spec.md §2/§9/§11).
 *
 * Motion recordability (monologue-spec.md §8): 4 slots, recording ALL panel
 * knobs/switches except MASTER, TEMPO, OCTAVE — panel switches keep the
 * factory default motion: true. VCO1 PITCH and VCO1 OCTAVE have no panel
 * control but ARE in the MIDIimp S1-1 motion-id list (13-24 covers VCO1/2
 * pitch/shape/octave/wave/levels), so they stay motion-recordable. KEY
 * TRG/HOLD is a sequencer transport button, not motion data (ARP_LATCH
 * precedent in the xd/OG tables).
 */
import {
  type ParamMeta,
  type MotionTargetMeta,
  knob,
  sw,
  menu,
  buildParamTable,
  clampParamIn,
  formatParamIn,
  motionParamIdsOf,
  motionParamLabelIn,
  motionMetaFor,
} from '../../shared/paramdef'
import { fmtSec, fmtHz, fmtDb } from '../../shared/maps'
import * as curves from './curves'
import { SLIDER_ASSIGN_DESTS, MICRO_TUNINGS } from './curves'

export const P = {
  VCO1_WAVE: 0,
  VCO1_PITCH: 1,
  VCO1_SHAPE: 2,
  VCO1_OCTAVE: 3,
  VCO2_OCTAVE: 4,
  VCO2_PITCH: 5,
  VCO2_WAVE: 6,
  SYNC_RING: 7,
  VCO2_SHAPE: 8,
  VCO1_LEVEL: 9,
  VCO2_LEVEL: 10,
  CUTOFF: 11,
  RESONANCE: 12,
  EG_TYPE: 13,
  EG_ATTACK: 14,
  EG_DECAY: 15,
  EG_INT: 16,
  EG_TARGET: 17,
  LFO_WAVE: 18,
  LFO_MODE: 19,
  LFO_RATE: 20,
  LFO_INT: 21,
  LFO_TARGET: 22,
  DRIVE: 23,
  KEY_TRIG: 24,
  OCTAVE: 25,
  PORTAMENTO: 26,
  PORTAMENTO_MODE: 27,
  SLIDE_TIME: 28,
  LFO_BPM_SYNC: 29,
  CUTOFF_VELOCITY: 30,
  CUTOFF_KEYTRACK: 31,
  AMP_VELOCITY: 32,
  PROGRAM_LEVEL: 33,
  PROGRAM_TUNING: 34,
  MICRO_TUNING: 35,
  SCALE_KEY: 36,
  BEND_RANGE_PLUS: 37,
  BEND_RANGE_MINUS: 38,
  SLIDER_ASSIGN: 39,
  SLIDER_RANGE: 40,
} as const

export type ParamId = (typeof P)[keyof typeof P]
export const PARAM_COUNT = 41

/** VCO1 wave, program-data enum order (spec §9 — 0=SQR, 1=TRI, 2=SAW; the
 *  panel prints them SAW/TRI/SQR top-to-bottom). */
const WAVES = ['SQR', 'TRI', 'SAW'] as const
/** VCO2 wave, program-data enum order: NOISE replaces SQR (spec §2/§10). */
const WAVES2 = ['NOISE', 'TRI', 'SAW'] as const
const OCTAVES = ["16'", "8'", "4'", "2'"] as const
const ONOFF = ['Off', 'On'] as const
const PCT3 = ['0%', '50%', '100%'] as const

/** SYNC/RING exclusive 3-position switch, program byte 32 b0-1 order
 *  (spec §3: 0=RING, 1=OFF, 2=SYNC). */
const SYNC_RING_MODES = ['RING', 'OFF', 'SYNC'] as const

/** EG TYPE, program byte 34 b0-1 order (spec §5: 0=GATE, 1=A/G/D, 2=A/D —
 *  the panel prints the label column A/D | A/G/D | GATE top-to-bottom). */
const EG_TYPES = ['GATE', 'A/G/D', 'A/D'] as const

/** LFO MODE, program byte 36 b2-3 order (spec §6: 0=1-SHOT, 1=SLOW, 2=FAST). */
const LFO_MODES = ['1-SHOT', 'SLOW', 'FAST'] as const

// Factory init-program defaults are UNCONFIRMED (spec §16 — extract from a
// program dump when hardware is available); the values below are the
// replica's musically-neutral init, mirroring the family tables.
const DEFS: ParamMeta[] = [
  sw(P.VCO1_WAVE, 'vco1Wave', 'VCO1 WAVE', WAVES, 2),
  // No panel knob (VCO1 pitch follows the master OCTAVE, spec §2) — exists in
  // program data + rx-only CC34, and is motion-recordable (MIDIimp S1-1).
  knob(P.VCO1_PITCH, 'vco1Pitch', 'VCO1 PITCH', 512, { fmt: curves.fmtCents }),
  knob(P.VCO1_SHAPE, 'vco1Shape', 'VCO1 SHAPE', 0),
  // No panel switch either (spec §2: VCO1 has no octave control), but program
  // data byte 30 b4-5 stores VCO1 OCTAVE and rx-only CC48 receives it —
  // kept as a menu-kind param for fidelity; motion: true per MIDIimp S1-1.
  menu(P.VCO1_OCTAVE, 'vco1Octave', 'VCO1 OCTAVE', 0, 3, 1, { labels: OCTAVES, motion: true }),
  sw(P.VCO2_OCTAVE, 'vco2Octave', 'VCO2 OCTAVE', OCTAVES, 1),
  knob(P.VCO2_PITCH, 'vco2Pitch', 'VCO2 PITCH', 512, { fmt: curves.fmtCents }),
  sw(P.VCO2_WAVE, 'vco2Wave', 'VCO2 WAVE', WAVES2, 2),
  sw(P.SYNC_RING, 'syncRing', 'SYNC/RING', SYNC_RING_MODES, 1),
  knob(P.VCO2_SHAPE, 'vco2Shape', 'VCO2 SHAPE', 0),
  knob(P.VCO1_LEVEL, 'vco1Level', 'VCO1 LEVEL', 1023),
  knob(P.VCO2_LEVEL, 'vco2Level', 'VCO2 LEVEL', 0),
  knob(P.CUTOFF, 'cutoff', 'CUTOFF', 1023, { fmt: (r) => fmtHz(curves.cutoffToHz(r)) }),
  knob(P.RESONANCE, 'resonance', 'RESONANCE', 0),
  sw(P.EG_TYPE, 'egType', 'EG TYPE', EG_TYPES, 1),
  knob(P.EG_ATTACK, 'egAttack', 'ATTACK', 0, { fmt: (r) => fmtSec(curves.attackToSec(r)) }),
  knob(P.EG_DECAY, 'egDecay', 'DECAY', 300, { fmt: (r) => fmtSec(curves.decayToSec(r)) }),
  // Bipolar center-512 store, OLED shows -511..+511 (spec §5, UNCONFIRMED
  // community encoding).
  knob(P.EG_INT, 'egInt', 'EG INT', 512, { fmt: curves.fmtEgIntBipolar }),
  sw(P.EG_TARGET, 'egTarget', 'EG TARGET', ['CUTOFF', 'PITCH 2', 'PITCH'], 0),
  sw(P.LFO_WAVE, 'lfoWave', 'LFO WAVE', WAVES, 1),
  sw(P.LFO_MODE, 'lfoMode', 'LFO MODE', LFO_MODES, 1),
  // fmt shows the SLOW-range Hz; the engine picks the curve per LFO MODE
  // (curves.lfoRateToHz) — a static fmt can't see the mode here.
  knob(P.LFO_RATE, 'lfoRate', 'LFO RATE', 512, { fmt: (r) => fmtHz(curves.lfoSlowHz(r)) }),
  // Bipolar center-512 store like EG INT (spec §6, UNCONFIRMED encoding).
  knob(P.LFO_INT, 'lfoInt', 'LFO INT', 512, { fmt: curves.fmtLfoIntBipolar }),
  sw(P.LFO_TARGET, 'lfoTarget', 'LFO TARGET', ['CUTOFF', 'SHAPE', 'PITCH'], 2),
  // Continuous 0..1023 knob (spec §7) — NOT the xd's stepped switch.
  knob(P.DRIVE, 'drive', 'DRIVE', 0),
  // Panel-state-as-param like the family ARP_LATCH precedent: the KEY
  // TRG/HOLD button (spec §8). Not motion data, not program-dump-verified.
  sw(P.KEY_TRIG, 'keyTrig', 'KEY TRG/HOLD', ['Off', 'KEY TRG', 'HOLD'], 0, { motion: false }),
  menu(P.OCTAVE, 'octave', 'KBD OCTAVE', 0, 4, 2, { labels: ['-2', '-1', '0', '+1', '+2'] }),
  // Stored 0,1..129 = OFF,0..128 (spec §9 byte 41 — same quirk as the OG).
  menu(P.PORTAMENTO, 'portamento', 'PORTAMENTO', 0, 129, 0, {
    fmt: (r) => (r <= 0 ? 'Off' : String(Math.round(r) - 1)),
  }),
  menu(P.PORTAMENTO_MODE, 'portamentoMode', 'PORTAMENTO MODE', 0, 1, 0, { labels: ['Auto', 'On'] }),
  // Stored 0..72 = 0..100% (spec §9 byte 40); default UNCONFIRMED.
  menu(P.SLIDE_TIME, 'slideTime', 'SLIDE TIME', 0, 72, 36, {
    fmt: (r) => Math.round((r / 72) * 100) + '%',
  }),
  menu(P.LFO_BPM_SYNC, 'lfoBpmSync', 'LFO BPM SYNC', 0, 1, 0, { labels: ONOFF }),
  menu(P.CUTOFF_VELOCITY, 'cutoffVelocity', 'CUTOFF VELOCITY', 0, 2, 0, { labels: PCT3 }),
  menu(P.CUTOFF_KEYTRACK, 'cutoffKeytrack', 'CUTOFF KEY TRACK', 0, 2, 0, { labels: PCT3 }),
  // 0 = velocity off (spec §13); default UNCONFIRMED (family value).
  menu(P.AMP_VELOCITY, 'ampVelocity', 'AMP VELOCITY', 0, 127, 64),
  // Stored 77..127 = -25..+25, 102 = center (spec §9/§11).
  menu(P.PROGRAM_LEVEL, 'programLevel', 'PROGRAM LEVEL', 77, 127, 102, {
    fmt: (r) => fmtDb(curves.programLevelToDb(r)),
  }),
  menu(P.PROGRAM_TUNING, 'programTuning', 'PROGRAM TUNING', 0, 100, 50, {
    fmt: (r) => (r - 50 > 0 ? '+' : '') + (r - 50) + 'C',
  }),
  // Hardware stores 0..139 (presets incl. AFX/DC + user slots, spec §11-12);
  // the replica ships the family preset subset from dsp/tuning.ts and clamps
  // to it — a DELIBERATE departure until user scales/octaves are implemented.
  menu(P.MICRO_TUNING, 'microTuning', 'MICROTUNING', 0, MICRO_TUNINGS.length - 1, 0, {
    labels: MICRO_TUNINGS.map((t) => t.name),
  }),
  menu(P.SCALE_KEY, 'scaleKey', 'SCALE KEY', 0, 24, 12, {
    fmt: (r) => (r - 12 > 0 ? '+' : '') + (r - 12) + ' Note',
  }),
  menu(P.BEND_RANGE_PLUS, 'bendRangePlus', 'BEND RANGE +', 1, 12, 2, { fmt: (r) => '+' + Math.round(r) }),
  menu(P.BEND_RANGE_MINUS, 'bendRangeMinus', 'BEND RANGE -', 1, 12, 2, { fmt: (r) => '-' + Math.round(r) }),
  menu(P.SLIDER_ASSIGN, 'sliderAssign', 'SLIDER ASSIGN', 0, SLIDER_ASSIGN_DESTS.length - 1, 0, {
    labels: SLIDER_ASSIGN_DESTS,
  }),
  // Stored 0..200 = -100..+100% (storage UNCONFIRMED — family convention).
  menu(P.SLIDER_RANGE, 'sliderRange', 'SLIDER RANGE', 0, 200, 200, {
    fmt: (r) => (r - 100 > 0 ? '+' : '') + (r - 100) + '%',
  }),
]

export const PARAMS: readonly ParamMeta[] = buildParamTable(DEFS, PARAM_COUNT)

export const PARAM_BY_KEY: ReadonlyMap<string, ParamMeta> = new Map(PARAMS.map((p) => [p.key, p]))

export function clampParam(id: number, v: number): number {
  return clampParamIn(PARAMS, id, v)
}

export function formatParam(id: number, v: number): string {
  return formatParamIn(PARAMS, id, v)
}

/** Params recordable into motion lanes (plus the two virtual targets). */
export const MOTION_PARAM_IDS: readonly number[] = motionParamIdsOf(PARAMS)

export function motionParamLabel(id: number): string {
  return motionParamLabelIn(PARAMS, id)
}

/** Motion-target predicates for the StepSeq core, bound to the mono table. */
export const MOTION_META: MotionTargetMeta = motionMetaFor(PARAMS)

// ---------------------------------------------------------------------------
// SLIDER destination -> param id (SLIDER_ASSIGN_DESTS order, curves.ts).
// Lives here rather than in curves.ts so curves stays import-free of the
// param table (no cycle) — same one-way direction as the OG/xd definitions.
// ---------------------------------------------------------------------------

/** Virtual slider destinations that are not program params (the OG's
 *  pattern, synths/og/params.ts): resolved by the engine — PITCH BEND bends
 *  the played pitch, GATE TIME offsets the sequencer gate. */
export const SLIDER_DEST_PITCH_BEND = -1
export const SLIDER_DEST_GATE_TIME = -2

const SLIDER_DEST_IDS: readonly number[] = [
  SLIDER_DEST_PITCH_BEND, // PITCH BEND (the hardware default, spec §11)
  SLIDER_DEST_GATE_TIME, // GATE TIME
  P.VCO1_PITCH,
  P.VCO1_SHAPE,
  P.VCO2_PITCH,
  P.VCO2_SHAPE,
  P.VCO1_LEVEL,
  P.VCO2_LEVEL,
  P.CUTOFF,
  P.RESONANCE,
  P.EG_ATTACK, // ATTACK
  P.EG_DECAY, // DECAY
  P.EG_INT,
  P.LFO_RATE,
  P.LFO_INT,
  P.DRIVE,
]

/** Param id for a slider destination index 0..15; negative = virtual
 *  (SLIDER_DEST_PITCH_BEND / SLIDER_DEST_GATE_TIME). */
export function sliderDestParam(destIndex: number): number {
  const i = Math.max(0, Math.min(SLIDER_DEST_IDS.length - 1, Math.round(destIndex)))
  return SLIDER_DEST_IDS[i]
}
