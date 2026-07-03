/*
 * minilogue xd parameter table — single source of truth for every program
 * parameter of the xd definition. Ids are stable and append-only; raw ranges
 * mirror the hardware (see docs/xd-spec.md).
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
import { fmtRaw, fmtSec, fmtHz, fmtDb } from '../../shared/maps'
import * as curves from './curves'

export const P = {
  VCO1_WAVE: 0,
  VCO1_OCTAVE: 1,
  VCO1_PITCH: 2,
  VCO1_SHAPE: 3,
  VCO2_WAVE: 4,
  VCO2_OCTAVE: 5,
  VCO2_PITCH: 6,
  VCO2_SHAPE: 7,
  SYNC: 8,
  RING: 9,
  CROSS_MOD: 10,
  MULTI_TYPE: 11,
  SELECT_NOISE: 12,
  SELECT_VPM: 13,
  SELECT_USER: 14,
  MULTI_OCTAVE: 15,
  SHAPE_NOISE: 16,
  SHAPE_VPM: 17,
  SHAPE_USER: 18,
  SHIFTSHAPE_NOISE: 19,
  SHIFTSHAPE_VPM: 20,
  SHIFTSHAPE_USER: 21,
  VCO1_LEVEL: 22,
  VCO2_LEVEL: 23,
  MULTI_LEVEL: 24,
  CUTOFF: 25,
  RESONANCE: 26,
  DRIVE: 27,
  KEYTRACK: 28,
  AMP_ATTACK: 29,
  AMP_DECAY: 30,
  AMP_SUSTAIN: 31,
  AMP_RELEASE: 32,
  EG_ATTACK: 33,
  EG_DECAY: 34,
  EG_INT: 35,
  EG_TARGET: 36,
  LFO_WAVE: 37,
  LFO_MODE: 38,
  LFO_RATE: 39,
  LFO_INT: 40,
  LFO_TARGET: 41,
  MODFX_ON: 42,
  MODFX_TYPE: 43,
  MODFX_SUB_CHORUS: 44,
  MODFX_SUB_ENSEMBLE: 45,
  MODFX_SUB_PHASER: 46,
  MODFX_SUB_FLANGER: 47,
  MODFX_SUB_USER: 48,
  MODFX_TIME: 49,
  MODFX_DEPTH: 50,
  DELAY_ON: 51,
  DELAY_SUB: 52,
  DELAY_TIME: 53,
  DELAY_DEPTH: 54,
  DELAY_DRYWET: 55,
  REVERB_ON: 56,
  REVERB_SUB: 57,
  REVERB_TIME: 58,
  REVERB_DEPTH: 59,
  REVERB_DRYWET: 60,
  VOICE_MODE: 61,
  VM_DEPTH: 62,
  ARP_LATCH: 63,
  ARP_RATE: 64,
  ARP_GATE: 65,
  OCTAVE: 66,
  PORTAMENTO: 67,
  PORTAMENTO_MODE: 68,
  PORTAMENTO_BPM: 69,
  PROGRAM_LEVEL: 70,
  PROGRAM_TUNING: 71,
  PROGRAM_TRANSPOSE: 72,
  BEND_RANGE_PLUS: 73,
  BEND_RANGE_MINUS: 74,
  JOY_ASSIGN_PLUS: 75,
  JOY_RANGE_PLUS: 76,
  JOY_ASSIGN_MINUS: 77,
  JOY_RANGE_MINUS: 78,
  LFO_KEY_SYNC: 79,
  LFO_VOICE_SYNC: 80,
  LFO_TARGET_OSC: 81,
  EG_VELOCITY: 82,
  AMP_VELOCITY: 83,
  EG_LEGATO: 84,
  MULTI_ROUTING: 85,
  VPM_FEEDBACK: 86,
  VPM_NOISE_DEPTH: 87,
  VPM_SHAPE_MOD_INT: 88,
  VPM_MOD_ATTACK: 89,
  VPM_MOD_DECAY: 90,
  VPM_KEY_TRACK: 91,
  MICRO_TUNING: 92,
  SCALE_KEY: 93,
  MIDI_AT_ASSIGN: 94,
} as const

export type ParamId = (typeof P)[keyof typeof P]
export const PARAM_COUNT = 95

const WAVES = ['SQR', 'TRI', 'SAW'] as const
const OCTAVES = ["16'", "8'", "4'", "2'"] as const
const ONOFF = ['Off', 'On'] as const
const PCT3 = ['0%', '50%', '100%'] as const

export const JOY_ASSIGN_DESTS = [
  'GATE TIME',
  'PORTAMENTO',
  'V.M DEPTH',
  'VCO1 PITCH',
  'VCO1 SHAPE',
  'VCO2 PITCH',
  'VCO2 SHAPE',
  'CROSS MOD',
  'MULTI SHAPE',
  'VCO1 LEVEL',
  'VCO2 LEVEL',
  'MULTI LEVEL',
  'CUTOFF',
  'RESONANCE',
  'A.EG ATTACK',
  'A.EG DECAY',
  'A.EG SUSTAIN',
  'A.EG RELEASE',
  'EG ATTACK',
  'EG DECAY',
  'EG INT',
  'LFO RATE',
  'LFO INT',
  'MOD FX SPEED',
  'MOD FX DEPTH',
  'REVERB TIME',
  'REVERB DEPTH',
  'DELAY TIME',
  'DELAY DEPTH',
] as const

const DELAY_SUBS = [
  'Stereo',
  'Mono',
  'Ping Pong',
  'Hipass',
  'Tape',
  'One Tap',
  'Stereo BPM',
  'Mono BPM',
  'Ping BPM',
  'Hipass BPM',
  'Tape BPM',
  'Doubling',
] as const
const REVERB_SUBS = [
  'Hall',
  'Smooth',
  'Arena',
  'Plate',
  'Room',
  'Early Ref',
  'Space',
  'Riser',
  'Submarine',
  'Horror',
] as const
const MODFX_TYPES = ['CHORUS', 'ENSEMBLE', 'PHASER', 'FLANGER', 'USER'] as const
const CHORUS_SUBS = ['Stereo', 'Light', 'Deep', 'Triphase', 'Harmonic', 'Mono', 'Feedback', 'Vibrato'] as const
const ENSEMBLE_SUBS = ['Stereo', 'Light', 'Mono'] as const
const PHASER_SUBS = ['Stereo', 'Fast', 'Orange', 'Small', 'Small Reso', 'Black', 'Formant', 'Twinkle'] as const
const FLANGER_SUBS = ['Stereo', 'Light', 'Mono', 'High Sweep', 'Mid Sweep', 'Pan Sweep', 'Mono Sweep', 'Triphase'] as const
const USER_MODFX_SUBS = ['Rotary', 'Trem'] as const
const USER_OSCS = ['MORPH', 'SPRSAW', 'PWMCLS', 'ORGAN'] as const
const NOISE_TYPES = ['High', 'Low', 'Peak', 'Decim'] as const
const VPM_TYPES = [
  'Sin1', 'Sin2', 'Sin3', 'Sin4', 'Saw1', 'Saw2', 'Squ1', 'Squ2',
  'Fat1', 'Fat2', 'Air1', 'Air2', 'Decay1', 'Decay2', 'Creep', 'Throat',
] as const

const DEFS: ParamMeta[] = [
  sw(P.VCO1_WAVE, 'vco1Wave', 'VCO1 WAVE', WAVES, 2),
  sw(P.VCO1_OCTAVE, 'vco1Octave', 'VCO1 OCTAVE', OCTAVES, 1),
  knob(P.VCO1_PITCH, 'vco1Pitch', 'VCO1 PITCH', 512, { fmt: curves.fmtCents }),
  knob(P.VCO1_SHAPE, 'vco1Shape', 'VCO1 SHAPE', 0),
  sw(P.VCO2_WAVE, 'vco2Wave', 'VCO2 WAVE', WAVES, 2),
  sw(P.VCO2_OCTAVE, 'vco2Octave', 'VCO2 OCTAVE', OCTAVES, 1),
  knob(P.VCO2_PITCH, 'vco2Pitch', 'VCO2 PITCH', 512, { fmt: curves.fmtCents }),
  knob(P.VCO2_SHAPE, 'vco2Shape', 'VCO2 SHAPE', 0),
  sw(P.SYNC, 'sync', 'OSC SYNC', ONOFF, 0),
  sw(P.RING, 'ring', 'RING MOD', ONOFF, 0),
  knob(P.CROSS_MOD, 'crossMod', 'CROSS MOD DEPTH', 0),
  sw(P.MULTI_TYPE, 'multiType', 'MULTI TYPE', ['NOISE', 'VPM', 'USR'], 1),
  sw(P.SELECT_NOISE, 'selectNoise', 'NOISE TYPE', NOISE_TYPES, 0),
  sw(P.SELECT_VPM, 'selectVpm', 'VPM TYPE', VPM_TYPES, 0),
  sw(P.SELECT_USER, 'selectUser', 'USER OSC', USER_OSCS, 0, { motion: false }),
  sw(P.MULTI_OCTAVE, 'multiOctave', 'MULTI OCTAVE', OCTAVES, 1, { motion: false }),
  knob(P.SHAPE_NOISE, 'shapeNoise', 'MULTI SHAPE', 512),
  knob(P.SHAPE_VPM, 'shapeVpm', 'MULTI SHAPE', 0),
  knob(P.SHAPE_USER, 'shapeUser', 'MULTI SHAPE', 0),
  knob(P.SHIFTSHAPE_NOISE, 'shiftShapeNoise', 'SHIFT SHAPE', 0),
  knob(P.SHIFTSHAPE_VPM, 'shiftShapeVpm', 'SHIFT SHAPE', 512),
  knob(P.SHIFTSHAPE_USER, 'shiftShapeUser', 'SHIFT SHAPE', 0),
  knob(P.VCO1_LEVEL, 'vco1Level', 'VCO1 LEVEL', 1023),
  knob(P.VCO2_LEVEL, 'vco2Level', 'VCO2 LEVEL', 0),
  knob(P.MULTI_LEVEL, 'multiLevel', 'MULTI LEVEL', 0),
  knob(P.CUTOFF, 'cutoff', 'CUTOFF', 1023, { fmt: (r) => fmtHz(curves.cutoffToHz(r)) }),
  knob(P.RESONANCE, 'resonance', 'RESONANCE', 0),
  sw(P.DRIVE, 'drive', 'DRIVE', PCT3, 0, { motion: false }),
  sw(P.KEYTRACK, 'keytrack', 'KEYTRACK', PCT3, 0),
  knob(P.AMP_ATTACK, 'ampAttack', 'AMP EG ATTACK', 0, { fmt: (r) => fmtSec(curves.attackToSec(r)) }),
  knob(P.AMP_DECAY, 'ampDecay', 'AMP EG DECAY', 200, { fmt: (r) => fmtSec(curves.decayToSec(r)) }),
  knob(P.AMP_SUSTAIN, 'ampSustain', 'AMP EG SUSTAIN', 1023),
  knob(P.AMP_RELEASE, 'ampRelease', 'AMP EG RELEASE', 100, { fmt: (r) => fmtSec(curves.releaseToSec(r)) }),
  knob(P.EG_ATTACK, 'egAttack', 'EG ATTACK', 0, { fmt: (r) => fmtSec(curves.attackToSec(r)) }),
  knob(P.EG_DECAY, 'egDecay', 'EG DECAY', 300, { fmt: (r) => fmtSec(curves.decayToSec(r)) }),
  knob(P.EG_INT, 'egInt', 'EG INT', 512, { fmt: curves.fmtEgInt }),
  sw(P.EG_TARGET, 'egTarget', 'EG TARGET', ['CUTOFF', 'PITCH 2', 'PITCH'], 0),
  sw(P.LFO_WAVE, 'lfoWave', 'LFO WAVE', WAVES, 1),
  sw(P.LFO_MODE, 'lfoMode', 'LFO MODE', ['1-SHOT', 'NORMAL', 'BPM'], 1),
  knob(P.LFO_RATE, 'lfoRate', 'LFO RATE', 512, {
    fmt: (r) => fmtHz(curves.lfoRateToHz(r)),
  }),
  knob(P.LFO_INT, 'lfoInt', 'LFO INT', 512, { fmt: curves.fmtLfoInt }),
  sw(P.LFO_TARGET, 'lfoTarget', 'LFO TARGET', ['CUTOFF', 'SHAPE', 'PITCH'], 2),
  sw(P.MODFX_ON, 'modFxOn', 'MOD FX', ONOFF, 0),
  sw(P.MODFX_TYPE, 'modFxType', 'MOD FX TYPE', MODFX_TYPES, 0, { motion: false }),
  sw(P.MODFX_SUB_CHORUS, 'modFxSubChorus', 'CHORUS', CHORUS_SUBS, 0, { motion: false }),
  sw(P.MODFX_SUB_ENSEMBLE, 'modFxSubEnsemble', 'ENSEMBLE', ENSEMBLE_SUBS, 0, { motion: false }),
  sw(P.MODFX_SUB_PHASER, 'modFxSubPhaser', 'PHASER', PHASER_SUBS, 0, { motion: false }),
  sw(P.MODFX_SUB_FLANGER, 'modFxSubFlanger', 'FLANGER', FLANGER_SUBS, 0, { motion: false }),
  sw(P.MODFX_SUB_USER, 'modFxSubUser', 'USER FX', USER_MODFX_SUBS, 0, { motion: false }),
  knob(P.MODFX_TIME, 'modFxTime', 'MOD FX TIME', 512),
  knob(P.MODFX_DEPTH, 'modFxDepth', 'MOD FX DEPTH', 512),
  sw(P.DELAY_ON, 'delayOn', 'DELAY', ONOFF, 0),
  sw(P.DELAY_SUB, 'delaySub', 'DELAY TYPE', DELAY_SUBS, 0, { motion: false }),
  knob(P.DELAY_TIME, 'delayTime', 'DELAY TIME', 512),
  knob(P.DELAY_DEPTH, 'delayDepth', 'DELAY DEPTH', 512),
  { id: P.DELAY_DRYWET, key: 'delayDryWet', label: 'DELAY DRY/WET', kind: 'knob', min: 0, max: 1024, def: 512, motion: false, motionSmooth: true, fmt: fmtRaw },
  sw(P.REVERB_ON, 'reverbOn', 'REVERB', ONOFF, 0),
  sw(P.REVERB_SUB, 'reverbSub', 'REVERB TYPE', REVERB_SUBS, 0, { motion: false }),
  knob(P.REVERB_TIME, 'reverbTime', 'REVERB TIME', 512),
  knob(P.REVERB_DEPTH, 'reverbDepth', 'REVERB DEPTH', 512),
  { id: P.REVERB_DRYWET, key: 'reverbDryWet', label: 'REVERB DRY/WET', kind: 'knob', min: 0, max: 1024, def: 512, motion: false, motionSmooth: true, fmt: fmtRaw },
  sw(P.VOICE_MODE, 'voiceMode', 'VOICE MODE', ['ARP', 'CHORD', 'UNISON', 'POLY'], 3),
  knob(P.VM_DEPTH, 'vmDepth', 'VOICE MODE DEPTH', 0),
  sw(P.ARP_LATCH, 'arpLatch', 'ARP LATCH', ONOFF, 0, { motion: false }),
  menu(P.ARP_RATE, 'arpRate', 'ARP RATE', 0, curves.ARP_RATES.length - 1, 4, { labels: curves.ARP_RATES.map((r) => r.label) }),
  menu(P.ARP_GATE, 'arpGate', 'ARP GATE TIME', 0, 72, 54, { fmt: (r) => Math.round((r / 72) * 100) + '%' }),
  menu(P.OCTAVE, 'octave', 'KBD OCTAVE', 0, 4, 2, { labels: ['-2', '-1', '0', '+1', '+2'] }),
  menu(P.PORTAMENTO, 'portamento', 'PORTAMENTO', 0, 127, 0, {
    motion: true,
    motionSmooth: true,
    fmt: (r) => (r <= 0 ? 'Off' : String(Math.round(r))),
  }),
  menu(P.PORTAMENTO_MODE, 'portamentoMode', 'PORTAMENTO MODE', 0, 1, 0, { labels: ['Auto', 'On'] }),
  menu(P.PORTAMENTO_BPM, 'portamentoBpm', 'PORTAMENTO BPM', 0, 1, 0, { labels: ONOFF }),
  menu(P.PROGRAM_LEVEL, 'programLevel', 'PROGRAM LEVEL', 12, 132, 102, {
    fmt: (r) => fmtDb(curves.programLevelToDb(r)),
  }),
  menu(P.PROGRAM_TUNING, 'programTuning', 'PROGRAM TUNING', 0, 100, 50, {
    fmt: (r) => (r - 50 > 0 ? '+' : '') + (r - 50) + 'C',
  }),
  menu(P.PROGRAM_TRANSPOSE, 'programTranspose', 'TRANSPOSE', 0, 24, 12, {
    fmt: (r) => (r - 12 > 0 ? '+' : '') + (r - 12) + ' Note',
  }),
  menu(P.BEND_RANGE_PLUS, 'bendRangePlus', 'BEND RANGE +', 0, 12, 2, { fmt: (r) => (r === 0 ? 'Off' : '+' + r) }),
  menu(P.BEND_RANGE_MINUS, 'bendRangeMinus', 'BEND RANGE -', 0, 12, 2, { fmt: (r) => (r === 0 ? 'Off' : '-' + r) }),
  menu(P.JOY_ASSIGN_PLUS, 'joyAssignPlus', 'JOYSTICK Y+', 0, JOY_ASSIGN_DESTS.length - 1, 22, { labels: JOY_ASSIGN_DESTS }),
  menu(P.JOY_RANGE_PLUS, 'joyRangePlus', 'Y+ RANGE', 0, 200, 200, { fmt: (r) => (r - 100 > 0 ? '+' : '') + (r - 100) + '%' }),
  menu(P.JOY_ASSIGN_MINUS, 'joyAssignMinus', 'JOYSTICK Y-', 0, JOY_ASSIGN_DESTS.length - 1, 12, { labels: JOY_ASSIGN_DESTS }),
  menu(P.JOY_RANGE_MINUS, 'joyRangeMinus', 'Y- RANGE', 0, 200, 0, { fmt: (r) => (r - 100 > 0 ? '+' : '') + (r - 100) + '%' }),
  menu(P.LFO_KEY_SYNC, 'lfoKeySync', 'LFO KEY SYNC', 0, 1, 0, { labels: ONOFF }),
  menu(P.LFO_VOICE_SYNC, 'lfoVoiceSync', 'LFO VOICE SYNC', 0, 1, 0, { labels: ONOFF }),
  menu(P.LFO_TARGET_OSC, 'lfoTargetOsc', 'LFO TARGET OSC', 0, 3, 0, { labels: ['All', 'VCO1+2', 'VCO2', 'Multi'] }),
  menu(P.EG_VELOCITY, 'egVelocity', 'EG VELOCITY', 0, 127, 0),
  menu(P.AMP_VELOCITY, 'ampVelocity', 'AMP VELOCITY', 0, 127, 64),
  menu(P.EG_LEGATO, 'egLegato', 'EG LEGATO', 0, 1, 0, { labels: ONOFF }),
  menu(P.MULTI_ROUTING, 'multiRouting', 'MULTI ROUTING', 0, 1, 0, { labels: ['Pre VCF', 'Post VCF'] }),
  menu(P.VPM_FEEDBACK, 'vpmFeedback', 'VPM FEEDBACK', 0, 200, 100, { fmt: fmtBipolar200 }),
  menu(P.VPM_NOISE_DEPTH, 'vpmNoiseDepth', 'VPM NOISE DEPTH', 0, 200, 100, { fmt: fmtBipolar200 }),
  menu(P.VPM_SHAPE_MOD_INT, 'vpmShapeModInt', 'VPM SHAPE MOD INT', 0, 200, 100, { fmt: fmtBipolar200 }),
  menu(P.VPM_MOD_ATTACK, 'vpmModAttack', 'VPM MOD ATTACK', 0, 200, 100, { fmt: fmtBipolar200 }),
  menu(P.VPM_MOD_DECAY, 'vpmModDecay', 'VPM MOD DECAY', 0, 200, 100, { fmt: fmtBipolar200 }),
  menu(P.VPM_KEY_TRACK, 'vpmKeyTrack', 'VPM KEY TRACK', 0, 200, 100, { fmt: fmtBipolar200 }),
  menu(P.MICRO_TUNING, 'microTuning', 'MICROTUNING', 0, curves.MICRO_TUNINGS.length - 1, 0, {
    labels: curves.MICRO_TUNINGS.map((t) => t.name),
  }),
  menu(P.SCALE_KEY, 'scaleKey', 'SCALE KEY', 0, 24, 12, {
    fmt: (r) => (r - 12 > 0 ? '+' : '') + (r - 12) + ' Note',
  }),
  menu(P.MIDI_AT_ASSIGN, 'midiAtAssign', 'MIDI AFTERTOUCH', 0, JOY_ASSIGN_DESTS.length - 1, 12, {
    labels: JOY_ASSIGN_DESTS,
  }),
]

function fmtBipolar200(r: number): string {
  const v = r - 100
  return (v > 0 ? '+' : '') + v + '%'
}

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

/** Motion-target predicates for the StepSeq core, bound to the xd table. */
export const MOTION_META: MotionTargetMeta = motionMetaFor(PARAMS)
