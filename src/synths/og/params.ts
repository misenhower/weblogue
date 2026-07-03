/*
 * Original Korg minilogue (OG) parameter table — single source of truth for
 * every program parameter of the OG definition. Ids are stable and
 * append-only; raw ranges mirror the hardware (see docs/og-spec.md).
 *
 * Motion recordability (og-spec.md §10): the OG records ALL panel knobs and
 * switches except MASTER, TEMPO, OCTAVE — including SYNC, RING, FILTER TYPE
 * and DELAY ROUTING (the MIDIimp S3-1 motion-id list names them explicitly),
 * so panel switches keep the factory default motion: true.
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
import { SLIDER_ASSIGN_DESTS } from './curves'

export const P = {
  VCO1_WAVE: 0,
  VCO1_OCTAVE: 1,
  VCO1_PITCH: 2,
  VCO1_SHAPE: 3,
  VCO2_WAVE: 4,
  VCO2_OCTAVE: 5,
  VCO2_PITCH: 6,
  VCO2_SHAPE: 7,
  CROSS_MOD: 8,
  PITCH_EG_INT: 9,
  SYNC: 10,
  RING: 11,
  VCO1_LEVEL: 12,
  VCO2_LEVEL: 13,
  NOISE_LEVEL: 14,
  CUTOFF: 15,
  RESONANCE: 16,
  EG_INT: 17,
  FILTER_TYPE: 18,
  KEYTRACK: 19,
  CUTOFF_VELOCITY: 20,
  AMP_ATTACK: 21,
  AMP_DECAY: 22,
  AMP_SUSTAIN: 23,
  AMP_RELEASE: 24,
  EG_ATTACK: 25,
  EG_DECAY: 26,
  EG_SUSTAIN: 27,
  EG_RELEASE: 28,
  LFO_WAVE: 29,
  LFO_EG_MOD: 30,
  LFO_RATE: 31,
  LFO_INT: 32,
  LFO_TARGET: 33,
  DELAY_HIPASS: 34,
  DELAY_TIME: 35,
  DELAY_FEEDBACK: 36,
  DELAY_ROUTING: 37,
  VOICE_MODE: 38,
  VM_DEPTH: 39,
  ARP_LATCH: 40,
  OCTAVE: 41,
  PORTAMENTO: 42,
  PORTAMENTO_MODE: 43,
  PORTAMENTO_BPM: 44,
  PROGRAM_LEVEL: 45,
  BEND_RANGE_PLUS: 46,
  BEND_RANGE_MINUS: 47,
  SLIDER_ASSIGN: 48,
  SLIDER_RANGE: 49,
  LFO_KEY_SYNC: 50,
  LFO_BPM_SYNC: 51,
  LFO_VOICE_SYNC: 52,
  AMP_VELOCITY: 53,
} as const

export type ParamId = (typeof P)[keyof typeof P]
export const PARAM_COUNT = 54

const WAVES = ['SQR', 'TRI', 'SAW'] as const
const OCTAVES = ["16'", "8'", "4'", "2'"] as const
const ONOFF = ['Off', 'On'] as const
const PCT3 = ['0%', '50%', '100%'] as const

/** Voice-mode buttons 1-8, program-data enum order (og-spec.md §3). */
const VOICE_MODES = ['POLY', 'DUO', 'UNISON', 'MONO', 'CHORD', 'DELAY', 'ARP', 'SIDE CHAIN'] as const

/** Delay output routing, program-data enum order (og-spec.md §9, §15.5). */
const DELAY_ROUTINGS = ['BYPASS', 'PRE FILTER', 'POST FILTER'] as const

const DEFS: ParamMeta[] = [
  sw(P.VCO1_WAVE, 'vco1Wave', 'VCO1 WAVE', WAVES, 2),
  sw(P.VCO1_OCTAVE, 'vco1Octave', 'VCO1 OCTAVE', OCTAVES, 1),
  knob(P.VCO1_PITCH, 'vco1Pitch', 'VCO1 PITCH', 512, { fmt: curves.fmtCents }),
  knob(P.VCO1_SHAPE, 'vco1Shape', 'VCO1 SHAPE', 0),
  sw(P.VCO2_WAVE, 'vco2Wave', 'VCO2 WAVE', WAVES, 2),
  sw(P.VCO2_OCTAVE, 'vco2Octave', 'VCO2 OCTAVE', OCTAVES, 1),
  knob(P.VCO2_PITCH, 'vco2Pitch', 'VCO2 PITCH', 512, { fmt: curves.fmtCents }),
  knob(P.VCO2_SHAPE, 'vco2Shape', 'VCO2 SHAPE', 0),
  knob(P.CROSS_MOD, 'crossMod', 'CROSS MOD DEPTH', 0),
  knob(P.PITCH_EG_INT, 'pitchEgInt', 'PITCH EG INT', 512, { fmt: curves.fmtPitchEgInt }),
  // Motion-recordable per og-spec.md §10 (unlike the xd, which excludes none
  // of these anyway — SYNC/RING/FILTER TYPE/DELAY ROUTING are named in S3-1).
  sw(P.SYNC, 'sync', 'OSC SYNC', ONOFF, 0),
  sw(P.RING, 'ring', 'RING MOD', ONOFF, 0),
  knob(P.VCO1_LEVEL, 'vco1Level', 'VCO1 LEVEL', 1023),
  knob(P.VCO2_LEVEL, 'vco2Level', 'VCO2 LEVEL', 0),
  knob(P.NOISE_LEVEL, 'noiseLevel', 'NOISE LEVEL', 0),
  knob(P.CUTOFF, 'cutoff', 'CUTOFF', 1023, { fmt: (r) => fmtHz(curves.cutoffToHz(r)) }),
  knob(P.RESONANCE, 'resonance', 'RESONANCE', 0),
  knob(P.EG_INT, 'egInt', 'EG INT', 512, { fmt: curves.fmtEgInt }),
  sw(P.FILTER_TYPE, 'filterType', 'FILTER TYPE', ['2-POLE', '4-POLE'], 1),
  sw(P.KEYTRACK, 'keytrack', 'KEYTRACK', PCT3, 0),
  sw(P.CUTOFF_VELOCITY, 'cutoffVelocity', 'CUTOFF VELOCITY', PCT3, 0),
  knob(P.AMP_ATTACK, 'ampAttack', 'AMP EG ATTACK', 0, { fmt: (r) => fmtSec(curves.attackToSec(r)) }),
  knob(P.AMP_DECAY, 'ampDecay', 'AMP EG DECAY', 200, { fmt: (r) => fmtSec(curves.decayToSec(r)) }),
  knob(P.AMP_SUSTAIN, 'ampSustain', 'AMP EG SUSTAIN', 1023),
  knob(P.AMP_RELEASE, 'ampRelease', 'AMP EG RELEASE', 100, { fmt: (r) => fmtSec(curves.releaseToSec(r)) }),
  knob(P.EG_ATTACK, 'egAttack', 'EG ATTACK', 0, { fmt: (r) => fmtSec(curves.attackToSec(r)) }),
  knob(P.EG_DECAY, 'egDecay', 'EG DECAY', 300, { fmt: (r) => fmtSec(curves.decayToSec(r)) }),
  knob(P.EG_SUSTAIN, 'egSustain', 'EG SUSTAIN', 0),
  knob(P.EG_RELEASE, 'egRelease', 'EG RELEASE', 0, { fmt: (r) => fmtSec(curves.releaseToSec(r)) }),
  sw(P.LFO_WAVE, 'lfoWave', 'LFO WAVE', WAVES, 1),
  // Replaces the xd's LFO MODE — no 1-shot on the OG (og-spec.md §8).
  sw(P.LFO_EG_MOD, 'lfoEgMod', 'LFO EG MOD', ['OFF', 'RATE', 'INT'], 0),
  knob(P.LFO_RATE, 'lfoRate', 'LFO RATE', 512, { fmt: (r) => fmtHz(curves.lfoRateToHz(r)) }),
  // UNIPOLAR 0..1023 (og-spec.md §8) — the xd's 512-centered store came later.
  knob(P.LFO_INT, 'lfoInt', 'LFO INT', 0),
  sw(P.LFO_TARGET, 'lfoTarget', 'LFO TARGET', ['CUTOFF', 'SHAPE', 'PITCH'], 2),
  knob(P.DELAY_HIPASS, 'delayHipass', 'DELAY HI PASS', 0, { fmt: (r) => fmtHz(curves.delayHipassHz(r)) }),
  knob(P.DELAY_TIME, 'delayTime', 'DELAY TIME', 512, { fmt: (r) => fmtSec(curves.delayTimeToSec(r)) }),
  knob(P.DELAY_FEEDBACK, 'delayFeedback', 'DELAY FEEDBACK', 0),
  sw(P.DELAY_ROUTING, 'delayRouting', 'OUTPUT ROUTING', DELAY_ROUTINGS, 0),
  sw(P.VOICE_MODE, 'voiceMode', 'VOICE MODE', VOICE_MODES, 0),
  knob(P.VM_DEPTH, 'vmDepth', 'VOICE MODE DEPTH', 0),
  sw(P.ARP_LATCH, 'arpLatch', 'ARP LATCH', ONOFF, 0, { motion: false }),
  menu(P.OCTAVE, 'octave', 'KBD OCTAVE', 0, 4, 2, { labels: ['-2', '-1', '0', '+1', '+2'] }),
  // Stored 0,1..129 = OFF,0..128 (og-spec.md §11 byte 61).
  menu(P.PORTAMENTO, 'portamento', 'PORTAMENTO', 0, 129, 0, {
    motion: true,
    motionSmooth: true,
    fmt: (r) => (r <= 0 ? 'Off' : String(Math.round(r) - 1)),
  }),
  menu(P.PORTAMENTO_MODE, 'portamentoMode', 'PORTAMENTO MODE', 0, 1, 0, { labels: ['Auto', 'On'] }),
  menu(P.PORTAMENTO_BPM, 'portamentoBpm', 'PORTAMENTO BPM', 0, 1, 0, { labels: ONOFF }),
  // Stored 77..127 = -25..+25, 102 = center (og-spec.md §11 byte 71).
  menu(P.PROGRAM_LEVEL, 'programLevel', 'PROGRAM LEVEL', 77, 127, 102, {
    fmt: (r) => fmtDb(curves.programLevelToDb(r)),
  }),
  menu(P.BEND_RANGE_PLUS, 'bendRangePlus', 'BEND RANGE +', 1, 12, 2, { fmt: (r) => '+' + Math.round(r) }),
  menu(P.BEND_RANGE_MINUS, 'bendRangeMinus', 'BEND RANGE -', 1, 12, 2, { fmt: (r) => '-' + Math.round(r) }),
  menu(P.SLIDER_ASSIGN, 'sliderAssign', 'SLIDER ASSIGN', 0, SLIDER_ASSIGN_DESTS.length - 1, 0, {
    labels: SLIDER_ASSIGN_DESTS,
  }),
  // Stored 0..200 = -100..+100% (storage UNCONFIRMED, og-spec.md §11).
  menu(P.SLIDER_RANGE, 'sliderRange', 'SLIDER RANGE', 0, 200, 200, {
    fmt: (r) => (r - 100 > 0 ? '+' : '') + (r - 100) + '%',
  }),
  menu(P.LFO_KEY_SYNC, 'lfoKeySync', 'LFO KEY SYNC', 0, 1, 0, { labels: ONOFF }),
  menu(P.LFO_BPM_SYNC, 'lfoBpmSync', 'LFO BPM SYNC', 0, 1, 0, { labels: ONOFF }),
  menu(P.LFO_VOICE_SYNC, 'lfoVoiceSync', 'LFO VOICE SYNC', 0, 1, 0, { labels: ONOFF }),
  // og-spec.md §7: Amp Velocity menu, stored byte 33, 0..127.
  menu(P.AMP_VELOCITY, 'ampVelocity', 'AMP VELOCITY', 0, 127, 64),
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

/** Motion-target predicates for the StepSeq core, bound to the OG table. */
export const MOTION_META: MotionTargetMeta = motionMetaFor(PARAMS)

// ---------------------------------------------------------------------------
// SLIDER destination -> param id (SLIDER_ASSIGN_DESTS order, curves.ts).
// Lives here rather than in curves.ts so curves stays import-free of the
// param table (no cycle) — same one-way direction as the xd definition.
// ---------------------------------------------------------------------------

/** Virtual slider destinations that are not program params (the xd's
 *  JOY_DEST_IDS pattern, synths/xd/engine.ts): resolved by the engine —
 *  PITCH BEND bends the played pitch, GATE TIME offsets the sequencer gate. */
export const SLIDER_DEST_PITCH_BEND = -1
export const SLIDER_DEST_GATE_TIME = -2

const SLIDER_DEST_IDS: readonly number[] = [
  SLIDER_DEST_PITCH_BEND, // PITCH BEND
  SLIDER_DEST_GATE_TIME, // GATE TIME
  P.VCO1_PITCH,
  P.VCO1_SHAPE,
  P.VCO2_PITCH,
  P.VCO2_SHAPE,
  P.CROSS_MOD,
  P.PITCH_EG_INT,
  P.VCO1_LEVEL,
  P.VCO2_LEVEL,
  P.NOISE_LEVEL,
  P.CUTOFF,
  P.RESONANCE,
  P.EG_INT, // FILTER EG INT
  P.AMP_ATTACK,
  P.AMP_DECAY,
  P.AMP_SUSTAIN,
  P.AMP_RELEASE,
  P.EG_ATTACK,
  P.EG_DECAY,
  P.EG_SUSTAIN,
  P.EG_RELEASE,
  P.LFO_RATE,
  P.LFO_INT,
  P.DELAY_HIPASS, // DELAY HI PASS CUTOFF
  P.DELAY_TIME,
  P.DELAY_FEEDBACK,
  P.PORTAMENTO,
  P.VM_DEPTH, // VOICE MODE DEPTH
]

/** Param id for a slider destination index 0..28; negative = virtual
 *  (SLIDER_DEST_PITCH_BEND / SLIDER_DEST_GATE_TIME). */
export function sliderDestParam(destIndex: number): number {
  const i = Math.max(0, Math.min(SLIDER_DEST_IDS.length - 1, Math.round(destIndex)))
  return SLIDER_DEST_IDS[i]
}
