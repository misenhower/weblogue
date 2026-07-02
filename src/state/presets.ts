/*
 * Factory preset bank — 32 programs showcasing the whole engine.
 *
 * Values are chosen against the real mapping curves in shared/maps.ts:
 *   - VCO PITCH raw 512 = 0 cents (dead zone 492..532); 532-548 spans 0..+16c,
 *     so subtle analog detune lives around 536..546.
 *   - EG_INT / LFO_INT store 512 = zero; the EG curve is quadratic, so
 *     ~640 = +5%, ~750 = +20%, ~870 = +50%, >=1013 = +100%.
 *   - CUTOFF is exponential 16 Hz..21 kHz: ~460 = 400 Hz, ~560 = 800 Hz,
 *     ~690 = 2 kHz, ~820 = 5 kHz.
 *   - Envelope times are exponential; a ~1 s pad attack needs raw ~890.
 *   - VM_DEPTH zone tables (chordIndex / arpTypeIndex / polyDuo) decide
 *     chord type, arp type, and the POLY->DUO split at 256.
 */
import { P, clampParam } from '../shared/params'
import {
  initProgram,
  NUM_STEPS,
  MOTION_POINTS,
  type Program,
  type SeqData,
} from '../shared/program'
import { GATE_TIE } from '../shared/maps'

// --- readable enum values (indices into the switch label tables) -------------
const SQR = 0
const TRI = 1
const SAW = 2
const OCT16 = 0
const OCT8 = 1
const OCT4 = 2
const ON = 1
const M_NOISE = 0
const M_VPM = 1
const M_USER = 2
const N_PEAK = 2
const V_SIN1 = 0
const V_SIN3 = 2
const V_SIN4 = 3
const V_FAT1 = 8
const V_AIR1 = 10
const V_DECAY1 = 12
const V_CREEP = 14
const V_THROAT = 15
const U_MORPH = 0
const U_SPRSAW = 1
const U_ORGAN = 3
const EGT_CUTOFF = 0
const EGT_PITCH2 = 1
const LFO_1SHOT = 0
const LFO_BPM = 2
const LT_CUTOFF = 0
const LT_SHAPE = 1
const LT_PITCH = 2
const FX_CHORUS = 0
const FX_ENSEMBLE = 1
const FX_PHASER = 2
const FX_FLANGER = 3
const FX_USER = 4
const DLY_STEREO = 0
const DLY_PINGPONG = 2
const DLY_HIPASS = 3
const DLY_TAPE = 4
const DLY_STEREO_BPM = 6
const DLY_TAPE_BPM = 10
const RV_HALL = 0
const RV_SMOOTH = 1
const RV_ARENA = 2
const RV_PLATE = 3
const RV_ROOM = 4
const RV_SPACE = 6
const RV_RISER = 7
const RV_HORROR = 9
const VM_ARP = 0
const VM_CHORD = 1
const VM_UNISON = 2
const TGT_ALL = 0
const TGT_VCO12 = 1
const TGT_MULTI = 3

type Edit = readonly [number, number]

function patch(name: string, edits: readonly Edit[], seqEdit?: (seq: SeqData) => void): Program {
  const prog = initProgram(name)
  for (const [id, v] of edits) prog.params[id] = clampParam(id, v)
  if (seqEdit) seqEdit(prog.seq)
  return prog
}

/** Write one sequencer step (single or stacked notes, shared gate/velocity). */
function st(seq: SeqData, i: number, notes: readonly number[], gate: number, vel = 100): void {
  seq.steps[i] = {
    on: true,
    notes: [...notes],
    vels: notes.map(() => vel),
    gates: notes.map(() => gate),
  }
}

/** 5 evenly spaced points from a to b (one step of a smooth motion lane). */
function ramp5(a: number, b: number): number[] {
  const out: number[] = []
  for (let k = 0; k < MOTION_POINTS; k++) out.push(Math.round(a + ((b - a) * k) / (MOTION_POINTS - 1)))
  return out
}

function flat5(v: number): number[] {
  return [v, v, v, v, v]
}

function setMotion(seq: SeqData, lane: number, paramId: number, smooth: boolean, data: number[][]): void {
  const m = seq.motion[lane]
  m.paramId = paramId
  m.on = true
  m.smooth = smooth
  for (let i = 0; i < NUM_STEPS; i++) m.data[i] = data[i] ?? null
}

/** Smooth 16-step lane from 17 breakpoints (value at each step boundary). */
function sweepLane(bp: readonly number[]): number[][] {
  const data: number[][] = []
  for (let i = 0; i < NUM_STEPS; i++) data.push(ramp5(bp[i], bp[i + 1]))
  return data
}

/** Triangle breakpoint curve lo -> hi -> lo across the bar (17 points). */
function triangleBp(lo: number, hi: number): number[] {
  const bp: number[] = []
  for (let i = 0; i <= NUM_STEPS; i++) {
    const t = i <= 8 ? i / 8 : (NUM_STEPS - i) / 8
    bp.push(Math.round(lo + (hi - lo) * t))
  }
  return bp
}

// =============================================================================
// The bank
// =============================================================================

function buildPresets(): Program[] {
  const bank: Program[] = []

  // -------------------------------------------------------------- POLY PADS
  // Warm analog poly pad: two saws a few cents apart, half keytrack, gentle
  // EG bloom, stereo chorus into a long hall.
  bank.push(
    patch('Xd Prologue', [
      [P.VCO1_WAVE, SAW],
      [P.VCO2_WAVE, SAW],
      [P.VCO2_PITCH, 541], // +9 cents
      [P.VCO2_LEVEL, 900],
      [P.CUTOFF, 640],
      [P.RESONANCE, 120],
      [P.KEYTRACK, 1],
      [P.AMP_ATTACK, 850],
      [P.AMP_DECAY, 700],
      [P.AMP_SUSTAIN, 850],
      [P.AMP_RELEASE, 800],
      [P.EG_ATTACK, 700],
      [P.EG_DECAY, 800],
      [P.EG_INT, 640], // +5% slow bloom
      [P.EG_TARGET, EGT_CUTOFF],
      [P.LFO_RATE, 300],
      [P.LFO_INT, 552],
      [P.LFO_TARGET, LT_CUTOFF],
      [P.MODFX_ON, ON],
      [P.MODFX_TYPE, FX_CHORUS],
      [P.MODFX_TIME, 400],
      [P.MODFX_DEPTH, 600],
      [P.REVERB_ON, ON],
      [P.REVERB_SUB, RV_HALL],
      [P.REVERB_TIME, 700],
      [P.REVERB_DEPTH, 500],
      [P.REVERB_DRYWET, 450],
      [P.PROGRAM_LEVEL, 100],
    ]),
  )

  // PWM strings: two squares, LFO sweeping pulse width on both VCOs, ensemble.
  bank.push(
    patch('PWM Strings', [
      [P.VCO1_WAVE, SQR],
      [P.VCO1_SHAPE, 400],
      [P.VCO2_WAVE, SQR],
      [P.VCO2_SHAPE, 700],
      [P.VCO2_PITCH, 545], // +13 cents
      [P.VCO2_LEVEL, 850],
      [P.CUTOFF, 700],
      [P.RESONANCE, 100],
      [P.KEYTRACK, 1],
      [P.AMP_ATTACK, 700],
      [P.AMP_DECAY, 600],
      [P.AMP_SUSTAIN, 900],
      [P.AMP_RELEASE, 700],
      [P.LFO_WAVE, TRI],
      [P.LFO_RATE, 450], // ~0.9 Hz
      [P.LFO_INT, 600],
      [P.LFO_TARGET, LT_SHAPE],
      [P.LFO_TARGET_OSC, TGT_VCO12],
      [P.MODFX_ON, ON],
      [P.MODFX_TYPE, FX_ENSEMBLE],
      [P.MODFX_TIME, 500],
      [P.MODFX_DEPTH, 650],
      [P.REVERB_ON, ON],
      [P.REVERB_SUB, RV_SMOOTH],
      [P.REVERB_TIME, 550],
      [P.REVERB_DEPTH, 450],
      [P.REVERB_DRYWET, 400],
      [P.PROGRAM_LEVEL, 100],
    ]),
  )

  // USER osc showcase: SPRSAW supersaw, wide spread, deep chorus into Space.
  bank.push(
    patch('Sprsaw Pad', [
      [P.MULTI_TYPE, M_USER],
      [P.SELECT_USER, U_SPRSAW],
      [P.SHAPE_USER, 700], // spread
      [P.SHIFTSHAPE_USER, 300],
      [P.MULTI_LEVEL, 1023],
      [P.VCO1_LEVEL, 300],
      [P.VCO2_LEVEL, 0],
      [P.CUTOFF, 680],
      [P.RESONANCE, 80],
      [P.AMP_ATTACK, 800],
      [P.AMP_DECAY, 700],
      [P.AMP_SUSTAIN, 900],
      [P.AMP_RELEASE, 850],
      [P.MODFX_ON, ON],
      [P.MODFX_TYPE, FX_CHORUS],
      [P.MODFX_SUB_CHORUS, 2], // Deep
      [P.MODFX_TIME, 450],
      [P.MODFX_DEPTH, 550],
      [P.REVERB_ON, ON],
      [P.REVERB_SUB, RV_SPACE],
      [P.REVERB_TIME, 650],
      [P.REVERB_DEPTH, 500],
      [P.REVERB_DRYWET, 480],
      [P.PROGRAM_LEVEL, 96],
    ]),
  )

  // USER MORPH motion pad: LFO scans the wavetable morph on the multi engine.
  bank.push(
    patch('Morph Pad', [
      [P.MULTI_TYPE, M_USER],
      [P.SELECT_USER, U_MORPH],
      [P.SHAPE_USER, 400],
      [P.MULTI_LEVEL, 1023],
      [P.VCO1_WAVE, TRI],
      [P.VCO1_LEVEL, 350],
      [P.VCO2_LEVEL, 0],
      [P.CUTOFF, 720],
      [P.AMP_ATTACK, 820],
      [P.AMP_DECAY, 700],
      [P.AMP_SUSTAIN, 900],
      [P.AMP_RELEASE, 830],
      [P.LFO_WAVE, TRI],
      [P.LFO_RATE, 250], // slow scan
      [P.LFO_INT, 650],
      [P.LFO_TARGET, LT_SHAPE],
      [P.LFO_TARGET_OSC, TGT_MULTI],
      [P.MODFX_ON, ON],
      [P.MODFX_TYPE, FX_CHORUS],
      [P.MODFX_TIME, 420],
      [P.MODFX_DEPTH, 480],
      [P.REVERB_ON, ON],
      [P.REVERB_SUB, RV_HALL],
      [P.REVERB_TIME, 620],
      [P.REVERB_DEPTH, 480],
      [P.REVERB_DRYWET, 430],
      [P.PROGRAM_LEVEL, 98],
    ]),
  )

  // Breathy VPM Air pad, noise-modulated sine over a quiet triangle bed.
  bank.push(
    patch('Air Pad', [
      [P.MULTI_TYPE, M_VPM],
      [P.SELECT_VPM, V_AIR1],
      [P.SHAPE_VPM, 450],
      [P.MULTI_LEVEL, 1023],
      [P.VPM_NOISE_DEPTH, 130], // +30%
      [P.VCO1_WAVE, TRI],
      [P.VCO1_LEVEL, 400],
      [P.VCO2_LEVEL, 0],
      [P.CUTOFF, 750],
      [P.AMP_ATTACK, 780],
      [P.AMP_DECAY, 700],
      [P.AMP_SUSTAIN, 880],
      [P.AMP_RELEASE, 820],
      [P.MODFX_ON, ON],
      [P.MODFX_TYPE, FX_ENSEMBLE],
      [P.MODFX_TIME, 480],
      [P.MODFX_DEPTH, 520],
      [P.REVERB_ON, ON],
      [P.REVERB_SUB, RV_SMOOTH],
      [P.REVERB_TIME, 680],
      [P.REVERB_DEPTH, 520],
      [P.REVERB_DRYWET, 460],
      [P.PROGRAM_LEVEL, 100],
    ]),
  )

  // Vowel-ish pad through the Formant phaser.
  bank.push(
    patch('Formant Pad', [
      [P.VCO1_WAVE, SAW],
      [P.VCO2_WAVE, SAW],
      [P.VCO2_PITCH, 538],
      [P.VCO2_LEVEL, 850],
      [P.CUTOFF, 600],
      [P.RESONANCE, 200],
      [P.AMP_ATTACK, 700],
      [P.AMP_DECAY, 650],
      [P.AMP_SUSTAIN, 850],
      [P.AMP_RELEASE, 750],
      [P.MODFX_ON, ON],
      [P.MODFX_TYPE, FX_PHASER],
      [P.MODFX_SUB_PHASER, 6], // Formant
      [P.MODFX_TIME, 300],
      [P.MODFX_DEPTH, 620],
      [P.REVERB_ON, ON],
      [P.REVERB_SUB, RV_PLATE],
      [P.REVERB_TIME, 500],
      [P.REVERB_DEPTH, 420],
      [P.REVERB_DRYWET, 400],
      [P.PROGRAM_LEVEL, 100],
    ]),
  )

  // ------------------------------------------------------------ POLY KEYS
  // Brass: bright saws, filter EG bite, a little drive, velocity on the EG.
  bank.push(
    patch('Xd Brass', [
      [P.VCO1_WAVE, SAW],
      [P.VCO2_WAVE, SAW],
      [P.VCO2_PITCH, 537], // +5 cents
      [P.VCO2_LEVEL, 800],
      [P.CUTOFF, 480],
      [P.RESONANCE, 200],
      [P.DRIVE, 1],
      [P.AMP_ATTACK, 60],
      [P.AMP_DECAY, 500],
      [P.AMP_SUSTAIN, 800],
      [P.AMP_RELEASE, 300],
      [P.EG_ATTACK, 120],
      [P.EG_DECAY, 620],
      [P.EG_INT, 780], // +26% bite
      [P.EG_TARGET, EGT_CUTOFF],
      [P.EG_VELOCITY, 80],
      [P.REVERB_ON, ON],
      [P.REVERB_SUB, RV_ROOM],
      [P.REVERB_TIME, 400],
      [P.REVERB_DEPTH, 350],
      [P.REVERB_DRYWET, 380],
      [P.PROGRAM_LEVEL, 102],
    ]),
  )

  // 80s polysynth stab: saw + sub square, chorus, medium filter envelope.
  bank.push(
    patch('Retro Stab', [
      [P.VCO1_WAVE, SAW],
      [P.VCO2_WAVE, SQR],
      [P.VCO2_OCTAVE, OCT16],
      [P.VCO2_LEVEL, 700],
      [P.CUTOFF, 560],
      [P.RESONANCE, 180],
      [P.AMP_ATTACK, 0],
      [P.AMP_DECAY, 600],
      [P.AMP_SUSTAIN, 600],
      [P.AMP_RELEASE, 300],
      [P.EG_DECAY, 550],
      [P.EG_INT, 730], // +18%
      [P.MODFX_ON, ON],
      [P.MODFX_TYPE, FX_CHORUS],
      [P.MODFX_TIME, 380],
      [P.MODFX_DEPTH, 520],
      [P.DELAY_ON, ON],
      [P.DELAY_SUB, DLY_STEREO],
      [P.DELAY_TIME, 480],
      [P.DELAY_DEPTH, 350],
      [P.DELAY_DRYWET, 360],
      [P.PROGRAM_LEVEL, 100],
    ]),
  )

  // VPM electric piano: Sin1 with a decaying mod EG, velocity-sensitive.
  bank.push(
    patch('Ep Tines', [
      [P.MULTI_TYPE, M_VPM],
      [P.SELECT_VPM, V_SIN1],
      [P.SHAPE_VPM, 300],
      [P.MULTI_LEVEL, 1023],
      [P.VPM_MOD_DECAY, 130], // +30% longer tine ring
      [P.VCO1_LEVEL, 0],
      [P.VCO2_LEVEL, 0],
      [P.CUTOFF, 850],
      [P.AMP_ATTACK, 0],
      [P.AMP_DECAY, 750],
      [P.AMP_SUSTAIN, 200],
      [P.AMP_RELEASE, 400],
      [P.AMP_VELOCITY, 110],
      [P.EG_VELOCITY, 60],
      [P.MODFX_ON, ON],
      [P.MODFX_TYPE, FX_CHORUS],
      [P.MODFX_TIME, 400],
      [P.MODFX_DEPTH, 450],
      [P.REVERB_ON, ON],
      [P.REVERB_SUB, RV_ROOM],
      [P.REVERB_TIME, 420],
      [P.REVERB_DEPTH, 380],
      [P.REVERB_DRYWET, 370],
      [P.PROGRAM_LEVEL, 102],
    ]),
  )

  // VPM bell keys: Sin4 (5x harmonic mod), long release, hall.
  bank.push(
    patch('VPM Bells', [
      [P.MULTI_TYPE, M_VPM],
      [P.SELECT_VPM, V_SIN4],
      [P.SHAPE_VPM, 550],
      [P.SHIFTSHAPE_VPM, 640],
      [P.MULTI_OCTAVE, OCT4],
      [P.MULTI_LEVEL, 1023],
      [P.VPM_MOD_DECAY, 140], // +40%
      [P.VPM_FEEDBACK, 110],
      [P.VCO1_LEVEL, 0],
      [P.VCO2_LEVEL, 0],
      [P.CUTOFF, 900],
      [P.AMP_ATTACK, 0],
      [P.AMP_DECAY, 780],
      [P.AMP_SUSTAIN, 0],
      [P.AMP_RELEASE, 800],
      [P.AMP_VELOCITY, 100],
      [P.MODFX_ON, ON],
      [P.MODFX_TYPE, FX_CHORUS],
      [P.MODFX_SUB_CHORUS, 1], // Light
      [P.MODFX_TIME, 420],
      [P.MODFX_DEPTH, 380],
      [P.REVERB_ON, ON],
      [P.REVERB_SUB, RV_HALL],
      [P.REVERB_TIME, 720],
      [P.REVERB_DEPTH, 520],
      [P.REVERB_DRYWET, 460],
      [P.PROGRAM_LEVEL, 102],
    ]),
  )

  // USER ORGAN through the rotary user mod FX; instant on, short release.
  bank.push(
    patch('Xd Organ', [
      [P.MULTI_TYPE, M_USER],
      [P.SELECT_USER, U_ORGAN],
      [P.SHAPE_USER, 600],
      [P.MULTI_LEVEL, 1023],
      [P.VCO1_LEVEL, 0],
      [P.VCO2_LEVEL, 0],
      [P.CUTOFF, 1023],
      [P.AMP_ATTACK, 10],
      [P.AMP_DECAY, 200],
      [P.AMP_SUSTAIN, 1023],
      [P.AMP_RELEASE, 60],
      [P.AMP_VELOCITY, 0],
      [P.MODFX_ON, ON],
      [P.MODFX_TYPE, FX_USER],
      [P.MODFX_SUB_USER, 0], // Rotary
      [P.MODFX_TIME, 600],
      [P.MODFX_DEPTH, 500],
      [P.REVERB_ON, ON],
      [P.REVERB_SUB, RV_ROOM],
      [P.REVERB_TIME, 350],
      [P.REVERB_DEPTH, 320],
      [P.REVERB_DRYWET, 350],
      [P.PROGRAM_LEVEL, 98],
    ]),
  )

  // Pluck: no sustain, fast filter decay, full keytrack, LFO key sync,
  // ping-pong echoes.
  bank.push(
    patch('Pluck It', [
      [P.VCO1_WAVE, SAW],
      [P.VCO2_WAVE, SAW],
      [P.VCO2_PITCH, 544], // +12 cents
      [P.VCO2_LEVEL, 600],
      [P.CUTOFF, 350],
      [P.RESONANCE, 250],
      [P.KEYTRACK, 2],
      [P.AMP_ATTACK, 0],
      [P.AMP_DECAY, 450],
      [P.AMP_SUSTAIN, 0],
      [P.AMP_RELEASE, 350],
      [P.EG_ATTACK, 0],
      [P.EG_DECAY, 420],
      [P.EG_INT, 760], // +22%
      [P.EG_TARGET, EGT_CUTOFF],
      [P.LFO_KEY_SYNC, 1],
      [P.DELAY_ON, ON],
      [P.DELAY_SUB, DLY_PINGPONG],
      [P.DELAY_TIME, 560],
      [P.DELAY_DEPTH, 400],
      [P.DELAY_DRYWET, 400],
      [P.REVERB_ON, ON],
      [P.REVERB_SUB, RV_PLATE],
      [P.REVERB_TIME, 450],
      [P.REVERB_DEPTH, 400],
      [P.REVERB_DRYWET, 350],
      [P.PROGRAM_LEVEL, 104],
    ]),
  )

  // ---------------------------------------------------------------- CHORD
  // CHORD mode in the m7 zone (366..438): one-finger neo-soul stabs.
  bank.push(
    patch('Neo Chords', [
      [P.VOICE_MODE, VM_CHORD],
      [P.VM_DEPTH, 400], // m7
      [P.VCO1_WAVE, SAW],
      [P.VCO1_LEVEL, 800],
      [P.VCO2_WAVE, SQR],
      [P.VCO2_SHAPE, 300],
      [P.VCO2_LEVEL, 600],
      [P.CUTOFF, 560],
      [P.RESONANCE, 150],
      [P.AMP_ATTACK, 40],
      [P.AMP_DECAY, 600],
      [P.AMP_SUSTAIN, 700],
      [P.AMP_RELEASE, 400],
      [P.MODFX_ON, ON],
      [P.MODFX_TYPE, FX_CHORUS],
      [P.MODFX_TIME, 380],
      [P.MODFX_DEPTH, 420],
      [P.REVERB_ON, ON],
      [P.REVERB_SUB, RV_PLATE],
      [P.REVERB_TIME, 480],
      [P.REVERB_DEPTH, 380],
      [P.REVERB_DRYWET, 380],
      [P.PROGRAM_LEVEL, 90], // 4 voices per key
    ]),
  )

  // CHORD 5th zone + RING + CROSS MOD: clangorous power chord.
  bank.push(
    patch('Metal Chord', [
      [P.VOICE_MODE, VM_CHORD],
      [P.VM_DEPTH, 40], // 5th
      [P.RING, ON],
      [P.CROSS_MOD, 350],
      [P.VCO1_WAVE, SAW],
      [P.VCO1_LEVEL, 500],
      [P.VCO2_WAVE, SAW],
      [P.VCO2_PITCH, 650], // ~+220 cents = inharmonic ring partials
      [P.VCO2_LEVEL, 900],
      [P.CUTOFF, 720],
      [P.RESONANCE, 250],
      [P.AMP_ATTACK, 0],
      [P.AMP_DECAY, 700],
      [P.AMP_SUSTAIN, 500],
      [P.AMP_RELEASE, 500],
      [P.REVERB_ON, ON],
      [P.REVERB_SUB, RV_ARENA],
      [P.REVERB_TIME, 600],
      [P.REVERB_DEPTH, 450],
      [P.REVERB_DRYWET, 420],
      [P.PROGRAM_LEVEL, 88],
    ]),
  )

  // ---------------------------------------------------------------- LEADS
  // Unison detune saw lead with stereo delay.
  bank.push(
    patch('Super Lead', [
      [P.VOICE_MODE, VM_UNISON],
      [P.VM_DEPTH, 380], // ~19 cents detune
      [P.VCO1_WAVE, SAW],
      [P.VCO2_WAVE, SAW],
      [P.VCO2_PITCH, 540], // +8 cents
      [P.VCO2_LEVEL, 950],
      [P.CUTOFF, 750],
      [P.RESONANCE, 150],
      [P.DRIVE, 1],
      [P.AMP_ATTACK, 20],
      [P.AMP_DECAY, 400],
      [P.AMP_SUSTAIN, 900],
      [P.AMP_RELEASE, 250],
      [P.EG_DECAY, 500],
      [P.EG_INT, 600],
      [P.DELAY_ON, ON],
      [P.DELAY_SUB, DLY_STEREO],
      [P.DELAY_TIME, 520],
      [P.DELAY_DEPTH, 450],
      [P.DELAY_DRYWET, 430],
      [P.PROGRAM_LEVEL, 92], // 4 stacked voices
    ]),
  )

  // Classic sync scream: VCO2 slaved to VCO1, EG sweeps VCO2 pitch only.
  bank.push(
    patch('Sync Scream', [
      [P.SYNC, ON],
      [P.VCO1_WAVE, SAW],
      [P.VCO1_LEVEL, 200],
      [P.VCO2_WAVE, SAW],
      [P.VCO2_PITCH, 700], // start ~+340 cents above master
      [P.VCO2_LEVEL, 1023],
      [P.CUTOFF, 800],
      [P.RESONANCE, 100],
      [P.DRIVE, 2],
      [P.AMP_ATTACK, 10],
      [P.AMP_DECAY, 600],
      [P.AMP_SUSTAIN, 850],
      [P.AMP_RELEASE, 200],
      [P.EG_ATTACK, 0],
      [P.EG_DECAY, 650],
      [P.EG_INT, 800], // +33% downward-settling sweep
      [P.EG_TARGET, EGT_PITCH2],
      [P.DELAY_ON, ON],
      [P.DELAY_SUB, DLY_STEREO],
      [P.DELAY_TIME, 480],
      [P.DELAY_DEPTH, 380],
      [P.DELAY_DRYWET, 380],
      [P.PROGRAM_LEVEL, 96],
    ]),
  )

  // Portamento lead: glide always on, legato EGs, light vibrato, tape echo.
  bank.push(
    patch('Glide Lead', [
      [P.PORTAMENTO, 55],
      [P.PORTAMENTO_MODE, 1], // On
      [P.EG_LEGATO, 1],
      [P.VCO1_WAVE, SAW],
      [P.VCO2_WAVE, SQR],
      [P.VCO2_PITCH, 538],
      [P.VCO2_LEVEL, 700],
      [P.CUTOFF, 620],
      [P.RESONANCE, 220],
      [P.AMP_ATTACK, 30],
      [P.AMP_DECAY, 500],
      [P.AMP_SUSTAIN, 900],
      [P.AMP_RELEASE, 280],
      [P.LFO_WAVE, TRI],
      [P.LFO_RATE, 730], // ~4.5 Hz vibrato
      [P.LFO_INT, 528],
      [P.LFO_TARGET, LT_PITCH],
      [P.LFO_TARGET_OSC, TGT_ALL],
      [P.DELAY_ON, ON],
      [P.DELAY_SUB, DLY_TAPE],
      [P.DELAY_TIME, 540],
      [P.DELAY_DEPTH, 420],
      [P.DELAY_DRYWET, 420],
      [P.PROGRAM_LEVEL, 100],
    ]),
  )

  // --------------------------------------------------------------- BASSES
  // Fat unison bass: both saws at 16', full drive, dry and punchy.
  bank.push(
    patch('Fat Uni Bass', [
      [P.VOICE_MODE, VM_UNISON],
      [P.VM_DEPTH, 300], // ~15 cents
      [P.VCO1_WAVE, SAW],
      [P.VCO1_OCTAVE, OCT16],
      [P.VCO2_WAVE, SAW],
      [P.VCO2_OCTAVE, OCT16],
      [P.VCO2_PITCH, 540],
      [P.VCO2_LEVEL, 900],
      [P.DRIVE, 2],
      [P.CUTOFF, 420],
      [P.RESONANCE, 180],
      [P.KEYTRACK, 1],
      [P.AMP_ATTACK, 0],
      [P.AMP_DECAY, 500],
      [P.AMP_SUSTAIN, 750],
      [P.AMP_RELEASE, 150],
      [P.EG_DECAY, 380],
      [P.EG_INT, 700], // +14% snap
      [P.PROGRAM_LEVEL, 88], // unison + drive
    ]),
  )

  // Acid bass: single saw, screaming resonance, big EG sweep, velocity to EG.
  bank.push(
    patch('Acid Bass', [
      [P.VCO1_WAVE, SAW],
      [P.VCO1_OCTAVE, OCT8],
      [P.VCO2_LEVEL, 0],
      [P.CUTOFF, 300],
      [P.RESONANCE, 850],
      [P.DRIVE, 1],
      [P.KEYTRACK, 1],
      [P.AMP_ATTACK, 0],
      [P.AMP_DECAY, 400],
      [P.AMP_SUSTAIN, 300],
      [P.AMP_RELEASE, 120],
      [P.EG_ATTACK, 0],
      [P.EG_DECAY, 350],
      [P.EG_INT, 830], // +40%
      [P.EG_TARGET, EGT_CUTOFF],
      [P.EG_VELOCITY, 100],
      [P.PROGRAM_LEVEL, 96],
    ]),
  )

  // DUO sub bass: POLY knob pushed into the DUO zone (>256) stacks a
  // detuned second voice; square sub an octave down.
  bank.push(
    patch('Sub Duo', [
      [P.VM_DEPTH, 620], // POLY -> DUO zone
      [P.VCO1_WAVE, TRI],
      [P.VCO1_OCTAVE, OCT8],
      [P.VCO2_WAVE, SQR],
      [P.VCO2_OCTAVE, OCT16],
      [P.VCO2_SHAPE, 200],
      [P.VCO2_LEVEL, 800],
      [P.CUTOFF, 380],
      [P.RESONANCE, 100],
      [P.AMP_ATTACK, 0],
      [P.AMP_DECAY, 600],
      [P.AMP_SUSTAIN, 900],
      [P.AMP_RELEASE, 200],
      [P.PROGRAM_LEVEL, 92], // duo stack
    ]),
  )

  // VPM growl bass: Fat1 (1/4 sub mod, driven carrier) + saw, extra feedback.
  bank.push(
    patch('Growl Bass', [
      [P.MULTI_TYPE, M_VPM],
      [P.SELECT_VPM, V_FAT1],
      [P.SHAPE_VPM, 700],
      [P.MULTI_OCTAVE, OCT16],
      [P.MULTI_LEVEL, 1023],
      [P.VPM_FEEDBACK, 150], // +50%
      [P.VCO1_WAVE, SAW],
      [P.VCO1_OCTAVE, OCT16],
      [P.VCO1_LEVEL, 700],
      [P.VCO2_LEVEL, 0],
      [P.DRIVE, 2],
      [P.CUTOFF, 450],
      [P.RESONANCE, 300],
      [P.EG_DECAY, 400],
      [P.EG_INT, 720],
      [P.AMP_ATTACK, 0],
      [P.AMP_DECAY, 500],
      [P.AMP_SUSTAIN, 700],
      [P.AMP_RELEASE, 140],
      [P.PROGRAM_LEVEL, 90],
    ]),
  )

  // BPM-synced wobble: LFO in BPM mode at 1/8 (zone index 10) on the cutoff.
  bank.push(
    patch('Wobble Bass', [
      [P.VCO1_WAVE, SAW],
      [P.VCO1_OCTAVE, OCT16],
      [P.VCO2_WAVE, SQR],
      [P.VCO2_OCTAVE, OCT16],
      [P.VCO2_LEVEL, 800],
      [P.DRIVE, 1],
      [P.CUTOFF, 450],
      [P.RESONANCE, 350],
      [P.AMP_ATTACK, 0],
      [P.AMP_DECAY, 600],
      [P.AMP_SUSTAIN, 950],
      [P.AMP_RELEASE, 180],
      [P.LFO_WAVE, TRI],
      [P.LFO_MODE, LFO_BPM],
      [P.LFO_RATE, 660], // zone 10 = 1/8 note
      [P.LFO_INT, 750],
      [P.LFO_TARGET, LT_CUTOFF],
      [P.PROGRAM_LEVEL, 96],
    ], (seq) => {
      seq.bpm = 140
    }),
  )

  // ---------------------------------------------------------- PERC / NOISE
  // Noise percussion: Peak noise band, snappy amp EG, zero sustain.
  bank.push(
    patch('Noise Perc', [
      [P.MULTI_TYPE, M_NOISE],
      [P.SELECT_NOISE, N_PEAK],
      [P.SHAPE_NOISE, 620],
      [P.MULTI_LEVEL, 1023],
      [P.VCO1_LEVEL, 0],
      [P.VCO2_LEVEL, 0],
      [P.CUTOFF, 1023],
      [P.RESONANCE, 0],
      [P.AMP_ATTACK, 0],
      [P.AMP_DECAY, 180],
      [P.AMP_SUSTAIN, 0],
      [P.AMP_RELEASE, 120],
      [P.AMP_VELOCITY, 127],
      [P.REVERB_ON, ON],
      [P.REVERB_SUB, RV_ROOM],
      [P.REVERB_TIME, 300],
      [P.REVERB_DEPTH, 300],
      [P.REVERB_DRYWET, 350],
      [P.PROGRAM_LEVEL, 106],
    ]),
  )

  // ----------------------------------------------------------------- ARPS
  // RISE FALL 1 zone (469..546), latched, 16ths, dotted echoes.
  bank.push(
    patch('Dream Arp', [
      [P.VOICE_MODE, VM_ARP],
      [P.ARP_LATCH, ON],
      [P.VM_DEPTH, 500], // RISE FALL 1
      [P.ARP_RATE, 4], // 16th
      [P.ARP_GATE, 40],
      [P.VCO1_WAVE, SAW],
      [P.VCO2_WAVE, TRI],
      [P.VCO2_LEVEL, 500],
      [P.CUTOFF, 600],
      [P.RESONANCE, 200],
      [P.EG_DECAY, 420],
      [P.EG_INT, 700],
      [P.AMP_ATTACK, 0],
      [P.AMP_DECAY, 450],
      [P.AMP_SUSTAIN, 400],
      [P.AMP_RELEASE, 300],
      [P.DELAY_ON, ON],
      [P.DELAY_SUB, DLY_PINGPONG],
      [P.DELAY_TIME, 600],
      [P.DELAY_DEPTH, 480],
      [P.DELAY_DRYWET, 470],
      [P.REVERB_ON, ON],
      [P.REVERB_SUB, RV_HALL],
      [P.REVERB_TIME, 550],
      [P.REVERB_DEPTH, 400],
      [P.REVERB_DRYWET, 380],
      [P.PROGRAM_LEVEL, 100],
    ], (seq) => {
      seq.bpm = 120
    }),
  )

  // RISE 2 zone (235..312), 8ths, hollow squares, BPM-synced delay.
  bank.push(
    patch('Rise Arp', [
      [P.VOICE_MODE, VM_ARP],
      [P.ARP_LATCH, ON],
      [P.VM_DEPTH, 270], // RISE 2
      [P.ARP_RATE, 7], // 8th
      [P.ARP_GATE, 60],
      [P.VCO1_WAVE, SQR],
      [P.VCO1_SHAPE, 250],
      [P.VCO2_WAVE, SQR],
      [P.VCO2_OCTAVE, OCT4],
      [P.VCO2_LEVEL, 400],
      [P.CUTOFF, 520],
      [P.EG_DECAY, 350],
      [P.EG_INT, 680],
      [P.AMP_ATTACK, 0],
      [P.AMP_DECAY, 380],
      [P.AMP_SUSTAIN, 200],
      [P.AMP_RELEASE, 250],
      [P.DELAY_ON, ON],
      [P.DELAY_SUB, DLY_STEREO_BPM],
      [P.DELAY_TIME, 500],
      [P.DELAY_DEPTH, 420],
      [P.DELAY_DRYWET, 430],
      [P.PROGRAM_LEVEL, 100],
    ], (seq) => {
      seq.bpm = 100
    }),
  )

  // RANDOM 2 zone (859..936), fast 32nds, VPM Decay1 plucks, flanger.
  bank.push(
    patch('Chaos Arp', [
      [P.VOICE_MODE, VM_ARP],
      [P.ARP_LATCH, ON],
      [P.VM_DEPTH, 900], // RANDOM 2
      [P.ARP_RATE, 2], // 32nd
      [P.ARP_GATE, 30],
      [P.MULTI_TYPE, M_VPM],
      [P.SELECT_VPM, V_DECAY1],
      [P.SHAPE_VPM, 500],
      [P.MULTI_LEVEL, 800],
      [P.VCO1_WAVE, SAW],
      [P.VCO1_LEVEL, 600],
      [P.VCO2_LEVEL, 0],
      [P.CUTOFF, 650],
      [P.RESONANCE, 300],
      [P.AMP_ATTACK, 0],
      [P.AMP_DECAY, 300],
      [P.AMP_SUSTAIN, 0],
      [P.AMP_RELEASE, 200],
      [P.MODFX_ON, ON],
      [P.MODFX_TYPE, FX_FLANGER],
      [P.MODFX_TIME, 400],
      [P.MODFX_DEPTH, 400],
      [P.DELAY_ON, ON],
      [P.DELAY_SUB, DLY_HIPASS],
      [P.DELAY_TIME, 450],
      [P.DELAY_DEPTH, 400],
      [P.DELAY_DRYWET, 400],
      [P.PROGRAM_LEVEL, 102],
    ], (seq) => {
      seq.bpm = 128
    }),
  )

  // ------------------------------------------------------------ SEQUENCES
  // 16-step A minor bassline; motion lane 0 rides the cutoff up then down
  // across the bar (smooth, 5 points/step).
  bank.push(
    patch('Night Drive', [
      [P.VCO1_WAVE, SAW],
      [P.VCO1_OCTAVE, OCT16],
      [P.VCO2_WAVE, SQR],
      [P.VCO2_OCTAVE, OCT16],
      [P.VCO2_SHAPE, 300],
      [P.VCO2_LEVEL, 700],
      [P.CUTOFF, 340],
      [P.RESONANCE, 500],
      [P.DRIVE, 1],
      [P.KEYTRACK, 1],
      [P.EG_DECAY, 320],
      [P.EG_INT, 740],
      [P.EG_TARGET, EGT_CUTOFF],
      [P.AMP_ATTACK, 0],
      [P.AMP_DECAY, 420],
      [P.AMP_SUSTAIN, 350],
      [P.AMP_RELEASE, 120],
      [P.DELAY_ON, ON],
      [P.DELAY_SUB, DLY_HIPASS],
      [P.DELAY_TIME, 500],
      [P.DELAY_DEPTH, 350],
      [P.DELAY_DRYWET, 360],
      [P.PROGRAM_LEVEL, 98],
    ], (seq) => {
      seq.bpm = 124
      // A natural minor: A1 root with octave jumps and approach notes.
      const line = [33, 33, 45, 33, 36, 33, 31, 33, 29, 29, 41, 29, 31, 31, 43, 31]
      const gates = [40, 24, 30, 24, 40, 24, 30, 24, 40, 24, 30, 24, 40, 24, 50, 24]
      for (let i = 0; i < NUM_STEPS; i++) {
        st(seq, i, [line[i]], gates[i], i % 4 === 0 ? 127 : 96)
      }
      setMotion(seq, 0, P.CUTOFF, true, sweepLane(triangleBp(250, 700)))
    }),
  )

  // C minor VPM melody with a TIE into a rest step; motion lane sweeps the
  // MULTI shape (mod index) for evolving brightness.
  bank.push(
    patch('Frost Melody', [
      [P.MULTI_TYPE, M_VPM],
      [P.SELECT_VPM, V_SIN3],
      [P.SHAPE_VPM, 420],
      [P.MULTI_LEVEL, 1023],
      [P.VCO1_WAVE, TRI],
      [P.VCO1_LEVEL, 250],
      [P.VCO2_LEVEL, 0],
      [P.CUTOFF, 800],
      [P.AMP_ATTACK, 10],
      [P.AMP_DECAY, 700],
      [P.AMP_SUSTAIN, 300],
      [P.AMP_RELEASE, 500],
      [P.DELAY_ON, ON],
      [P.DELAY_SUB, DLY_TAPE_BPM],
      [P.DELAY_TIME, 400],
      [P.DELAY_DEPTH, 380],
      [P.DELAY_DRYWET, 380],
      [P.REVERB_ON, ON],
      [P.REVERB_SUB, RV_SMOOTH],
      [P.REVERB_TIME, 600],
      [P.REVERB_DEPTH, 480],
      [P.REVERB_DRYWET, 440],
      [P.PROGRAM_LEVEL, 102],
    ], (seq) => {
      seq.bpm = 100
      // C minor: step 7 TIEs Bb4 through the silent step 8.
      st(seq, 0, [60], 45, 110)
      st(seq, 2, [63], 40, 96)
      st(seq, 3, [65], 40, 90)
      st(seq, 4, [67], 60, 118)
      st(seq, 6, [63], 40, 92)
      st(seq, 7, [70], GATE_TIE, 108) // tie: holds through step 8 (off)
      st(seq, 9, [67], 40, 100)
      st(seq, 11, [65], 40, 94)
      st(seq, 12, [63], 60, 112)
      st(seq, 14, [58], 50, 100)
      setMotion(seq, 0, P.SHAPE_VPM, true, sweepLane(triangleBp(200, 800)))
    }),
  )

  // E minor line whose VCO1 wave is switched per step by a motion lane
  // (switch-type param, stepwise) while lane 1 opens the filter.
  bank.push(
    patch('Wave Walker', [
      [P.VCO1_WAVE, SAW],
      [P.VCO1_OCTAVE, OCT16],
      [P.VCO2_WAVE, SAW],
      [P.VCO2_OCTAVE, OCT16],
      [P.VCO2_PITCH, 540],
      [P.VCO2_LEVEL, 500],
      [P.CUTOFF, 480],
      [P.RESONANCE, 300],
      [P.KEYTRACK, 1],
      [P.EG_DECAY, 380],
      [P.EG_INT, 690],
      [P.AMP_ATTACK, 0],
      [P.AMP_DECAY, 500],
      [P.AMP_SUSTAIN, 500],
      [P.AMP_RELEASE, 160],
      [P.MODFX_ON, ON],
      [P.MODFX_TYPE, FX_PHASER],
      [P.MODFX_TIME, 350],
      [P.MODFX_DEPTH, 450],
      [P.PROGRAM_LEVEL, 100],
    ], (seq) => {
      seq.bpm = 110
      const line = [28, 28, 40, 28, 35, 28, 38, 28, 31, 31, 43, 31, 26, 26, 38, 26]
      const gates = [45, 24, 36, 24, 45, 24, 36, 24, 45, 24, 36, 24, 45, 24, 60, 24]
      for (let i = 0; i < NUM_STEPS; i++) {
        st(seq, i, [line[i]], gates[i], i % 4 === 0 ? 120 : 92)
      }
      // Lane 0: VCO1 WAVE stepped SAW -> SQR -> TRI -> SAW per beat group.
      const waves = [SAW, SAW, SAW, SAW, SQR, SQR, SQR, SQR, TRI, TRI, TRI, TRI, SAW, SAW, SQR, TRI]
      setMotion(seq, 0, P.VCO1_WAVE, false, waves.map((w) => flat5(w)))
      // Lane 1: slow cutoff rise across the bar.
      const bp: number[] = []
      for (let i = 0; i <= NUM_STEPS; i++) bp.push(Math.round(300 + ((850 - 300) * i) / NUM_STEPS))
      setMotion(seq, 1, P.CUTOFF, true, sweepLane(bp))
    }),
  )

  // ---------------------------------------------------------- FX / TEXTURE
  // Riser: one-shot saw LFO sweeps pitch upward into the Riser shimmer verb.
  bank.push(
    patch('Lift Off', [
      [P.VCO1_WAVE, SAW],
      [P.VCO2_WAVE, SAW],
      [P.VCO2_PITCH, 542],
      [P.VCO2_LEVEL, 800],
      [P.CUTOFF, 700],
      [P.RESONANCE, 300],
      [P.AMP_ATTACK, 500],
      [P.AMP_DECAY, 800],
      [P.AMP_SUSTAIN, 1023],
      [P.AMP_RELEASE, 900],
      [P.LFO_WAVE, SAW],
      [P.LFO_MODE, LFO_1SHOT],
      [P.LFO_RATE, 200], // slow half-cycle climb
      [P.LFO_INT, 800],
      [P.LFO_TARGET, LT_PITCH],
      [P.LFO_TARGET_OSC, TGT_ALL],
      [P.DELAY_ON, ON],
      [P.DELAY_SUB, DLY_PINGPONG],
      [P.DELAY_TIME, 600],
      [P.DELAY_DEPTH, 550],
      [P.DELAY_DRYWET, 450],
      [P.REVERB_ON, ON],
      [P.REVERB_SUB, RV_RISER],
      [P.REVERB_TIME, 800],
      [P.REVERB_DEPTH, 700],
      [P.REVERB_DRYWET, 550],
      [P.PROGRAM_LEVEL, 94],
    ]),
  )

  // VPM Creep drone through the unstable Horror reverb; slow LFO stirs the
  // filter.
  bank.push(
    patch('Haunted', [
      [P.MULTI_TYPE, M_VPM],
      [P.SELECT_VPM, V_CREEP],
      [P.SHAPE_VPM, 800],
      [P.MULTI_LEVEL, 1023],
      [P.VCO1_WAVE, TRI],
      [P.VCO1_OCTAVE, OCT16],
      [P.VCO1_LEVEL, 150],
      [P.VCO2_LEVEL, 0],
      [P.CUTOFF, 500],
      [P.RESONANCE, 400],
      [P.AMP_ATTACK, 700],
      [P.AMP_DECAY, 800],
      [P.AMP_SUSTAIN, 800],
      [P.AMP_RELEASE, 900],
      [P.LFO_WAVE, TRI],
      [P.LFO_RATE, 90], // ~0.09 Hz
      [P.LFO_INT, 620],
      [P.LFO_TARGET, LT_CUTOFF],
      [P.REVERB_ON, ON],
      [P.REVERB_SUB, RV_HORROR],
      [P.REVERB_TIME, 750],
      [P.REVERB_DEPTH, 600],
      [P.REVERB_DRYWET, 520],
      [P.PROGRAM_LEVEL, 94],
    ]),
  )

  // Atonal evolving VPM Throat texture, submarine-dark verb optional — kept
  // on Arena for space without mud; slow shape scan via LFO.
  bank.push(
    patch('Throat Talk', [
      [P.MULTI_TYPE, M_VPM],
      [P.SELECT_VPM, V_THROAT],
      [P.SHAPE_VPM, 600],
      [P.MULTI_LEVEL, 1023],
      [P.VCO1_LEVEL, 0],
      [P.VCO2_LEVEL, 0],
      [P.CUTOFF, 680],
      [P.RESONANCE, 250],
      [P.AMP_ATTACK, 600],
      [P.AMP_DECAY, 750],
      [P.AMP_SUSTAIN, 850],
      [P.AMP_RELEASE, 800],
      [P.LFO_WAVE, TRI],
      [P.LFO_RATE, 180],
      [P.LFO_INT, 680],
      [P.LFO_TARGET, LT_SHAPE],
      [P.LFO_TARGET_OSC, TGT_MULTI],
      [P.MODFX_ON, ON],
      [P.MODFX_TYPE, FX_FLANGER],
      [P.MODFX_SUB_FLANGER, 4], // Mid Sweep
      [P.MODFX_TIME, 300],
      [P.MODFX_DEPTH, 500],
      [P.REVERB_ON, ON],
      [P.REVERB_SUB, RV_ARENA],
      [P.REVERB_TIME, 700],
      [P.REVERB_DEPTH, 520],
      [P.REVERB_DRYWET, 480],
      [P.PROGRAM_LEVEL, 96],
    ]),
  )

  return bank
}

export const FACTORY_PRESETS: Program[] = buildPresets()
