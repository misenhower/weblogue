/*
 * Original minilogue (OG) factory preset bank — 10 programs showcasing what
 * the OG has that the xd doesn't: the 2/4-pole self-oscillating filter with
 * its resonance-vs-bass tradeoff, a NOISE mixer channel, full-ADSR mod EG
 * with the EG MOD -> LFO trick (RATE / INT), PITCH EG INT (+/-4800c on VCO2),
 * the MONO / CHORD / DELAY / SIDE CHAIN voice modes, and the HPF + delay
 * block with PRE/POST wet routing.
 *
 * Values are chosen against the mapping curves in ./curves.ts:
 *   - CUTOFF is exponential 16 Hz..21 kHz: ~400 = 265 Hz, ~520 = 620 Hz,
 *     ~600 = 1.1 kHz, ~700 = 2.2 kHz, ~820 = 5 kHz.
 *   - EG_INT stores 512 = zero and is quadratic: ~700 = +12%, ~750 = +20%,
 *     ~810 = +33%.
 *   - PITCH_EG_INT stores 512 = zero, +/-4800 cents full scale: ~800 = +2.4k
 *     cents (the classic two-octave sync sweep).
 *   - LFO_INT is UNIPOLAR 0..1023 (og-spec.md §8): vibrato depths live down
 *     around 50..80 raw (~60..95 cents at full EG).
 *   - PROGRAM_LEVEL stores 77..127 = -12.5..+12.5 dB, 102 = unity.
 *   - VM_DEPTH zone tables (chordIndex / delayModeDivision / arpTypeIndex)
 *     decide chord type and DELAY-mode echo spacing.
 *   - Envelope times are exponential; decay raw ~520 = 0.17 s, ~700 = 0.8 s.
 */
import { P, clampParam } from './params'
import { initProgram } from './program'
import {
  NUM_STEPS,
  MOTION_POINTS,
  GATE_TIE,
  type Program,
  type SeqData,
} from '../../shared/program'

// --- readable enum values (indices into the switch label tables) -------------
const SQR = 0
const TRI = 1
const SAW = 2
const OCT16 = 0
const OCT8 = 1
const OCT4 = 2
const ON = 1
const FT_2POLE = 0
const FT_4POLE = 1
const KT_HALF = 1 // KEYTRACK / CUTOFF VELOCITY: 0/50/100%
const KT_FULL = 2
const EGM_RATE = 1 // LFO EG MOD switch: OFF / RATE / INT
const EGM_INT = 2
const LT_CUTOFF = 0
const LT_PITCH = 2
const RT_PRE = 1 // delay OUTPUT ROUTING: BYPASS / PRE FILTER / POST FILTER
const RT_POST = 2
const VM_UNISON = 2
const VM_MONO = 3
const VM_CHORD = 4
const VM_DELAY = 5
const VM_SIDECHAIN = 7

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

/** Linear breakpoint curve lo -> hi across the bar (17 points). */
function riseBp(lo: number, hi: number): number[] {
  const bp: number[] = []
  for (let i = 0; i <= NUM_STEPS; i++) bp.push(Math.round(lo + ((hi - lo) * i) / NUM_STEPS))
  return bp
}

// =============================================================================
// The bank
// =============================================================================

function buildPresets(): Program[] {
  const bank: Program[] = []

  // ------------------------------------------------------------- SEQ / ACID
  // 4-POLE filter pushed into self-oscillation territory (RES ~92%: the OG
  // filter whistles AND loses low end — the signature tradeoff). 16-step
  // A-minor acid line; lane 0 rides the cutoff up and back down (smooth),
  // lane 1 flips the motion-recordable FILTER TYPE switch 4-pole/2-pole per
  // beat group. Post-routed HPF delay thins the echo tail.
  bank.push(
    patch('Acid Squelch', [
      [P.VCO1_WAVE, SAW],
      [P.VCO1_OCTAVE, OCT16],
      [P.VCO2_LEVEL, 0],
      [P.FILTER_TYPE, FT_4POLE],
      [P.CUTOFF, 320], // ~150 Hz floor
      [P.RESONANCE, 940], // self-osc territory
      [P.KEYTRACK, KT_HALF],
      [P.EG_INT, 810], // +33% squelch sweep
      [P.EG_ATTACK, 0],
      [P.EG_DECAY, 520], // ~0.17 s
      [P.EG_SUSTAIN, 0],
      [P.EG_RELEASE, 0],
      [P.AMP_ATTACK, 0],
      [P.AMP_DECAY, 480],
      [P.AMP_SUSTAIN, 350],
      [P.AMP_RELEASE, 120],
      [P.AMP_VELOCITY, 90],
      [P.DELAY_ROUTING, RT_POST],
      [P.DELAY_TIME, 760], // ~215 ms
      [P.DELAY_FEEDBACK, 450], // 0.46 loop gain
      [P.DELAY_HIPASS, 600], // ~220 Hz — keeps repeats out of the bass
      [P.PROGRAM_LEVEL, 100],
    ], (seq) => {
      seq.bpm = 126
      // A natural minor 303-ism: octave jumps and chromatic approaches.
      const line = [33, 33, 45, 33, 36, 33, 31, 45, 29, 41, 29, 33, 31, 31, 43, 36]
      const gates = [40, 24, 30, 24, 40, 24, 30, 50, 40, 24, 30, 24, 40, 24, 55, 30]
      for (let i = 0; i < NUM_STEPS; i++) {
        st(seq, i, [line[i]], gates[i], i % 4 === 0 ? 127 : 96)
      }
      // Lane 0: cutoff climbs to the squelch point mid-bar, then back down.
      setMotion(seq, 0, P.CUTOFF, true, sweepLane(triangleBp(260, 640)))
      // Lane 1: FILTER TYPE flipped per beat group (motion records switches
      // on the OG — og-spec.md §10) — 24 dB bite vs 12 dB rasp.
      const poles = [1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1]
      setMotion(seq, 1, P.FILTER_TYPE, false, poles.map((v) => flat5(v)))
    }),
  )

  // ------------------------------------------------------------ PERC / NOISE
  // The OG's third mixer channel: white noise snare. A quiet triangle an
  // octave up gives the shell a pitch; the 2-pole keeps the top airy, a
  // short EG blip snaps the transient, and a ~80 ms slap widens the hit.
  bank.push(
    patch('OG Snare', [
      [P.NOISE_LEVEL, 1023],
      [P.VCO1_WAVE, TRI],
      [P.VCO1_OCTAVE, OCT8],
      [P.VCO1_LEVEL, 250],
      [P.VCO2_LEVEL, 0],
      [P.FILTER_TYPE, FT_2POLE],
      [P.CUTOFF, 820], // ~5 kHz
      [P.RESONANCE, 260],
      [P.CUTOFF_VELOCITY, KT_HALF],
      [P.EG_INT, 700], // +12% transient blip
      [P.EG_ATTACK, 0],
      [P.EG_DECAY, 300],
      [P.EG_SUSTAIN, 0],
      [P.AMP_ATTACK, 0],
      [P.AMP_DECAY, 500], // ~0.14 s body
      [P.AMP_SUSTAIN, 0],
      [P.AMP_RELEASE, 380],
      [P.AMP_VELOCITY, 120],
      [P.DELAY_ROUTING, RT_POST],
      [P.DELAY_TIME, 620], // ~80 ms slapback
      [P.DELAY_FEEDBACK, 200],
      [P.DELAY_HIPASS, 500],
      [P.PROGRAM_LEVEL, 104],
    ]),
  )

  // ----------------------------------------------------------------- LEADS
  // The classic '80s sync scream, OG style: VCO2 slaved to VCO1 (SYNC), the
  // mod EG sweeping VCO2 pitch down from ~+2 octaves via PITCH EG INT, and
  // CROSS MOD grinding the sweep on the way. EG INT stays centered so the
  // whole envelope budget goes to the pitch sweep.
  bank.push(
    patch('Sync Hero', [
      [P.SYNC, ON],
      [P.CROSS_MOD, 380],
      [P.PITCH_EG_INT, 800], // ~+2440 cents of sweep on VCO2
      [P.VCO1_WAVE, SAW],
      [P.VCO1_LEVEL, 350],
      [P.VCO2_WAVE, SAW],
      [P.VCO2_PITCH, 620], // +160 cents start offset
      [P.VCO2_LEVEL, 1023],
      [P.CUTOFF, 780], // ~4 kHz
      [P.RESONANCE, 140],
      [P.EG_INT, 512], // no cutoff mod — EG is the pitch sweeper
      [P.EG_ATTACK, 0],
      [P.EG_DECAY, 620], // ~0.4 s settle
      [P.EG_SUSTAIN, 0],
      [P.EG_RELEASE, 0],
      [P.AMP_ATTACK, 10],
      [P.AMP_DECAY, 600],
      [P.AMP_SUSTAIN, 850],
      [P.AMP_RELEASE, 250],
      [P.DELAY_ROUTING, RT_POST],
      [P.DELAY_TIME, 780], // ~250 ms
      [P.DELAY_FEEDBACK, 420],
      [P.DELAY_HIPASS, 550],
      [P.PROGRAM_LEVEL, 100],
    ]),
  )

  // RING mod metal: square ring-modulates square, VCO2 a 4th-ish sharp at 4'
  // for inharmonic clang; bell envelope, full keytrack, long dark echoes.
  bank.push(
    patch('Ring Anvil', [
      [P.RING, ON],
      [P.VCO1_WAVE, SQR],
      [P.VCO1_LEVEL, 220],
      [P.VCO2_WAVE, SQR],
      [P.VCO2_OCTAVE, OCT4],
      [P.VCO2_PITCH, 690], // ~+315 cents = inharmonic sum/difference partials
      [P.VCO2_LEVEL, 1023],
      [P.CUTOFF, 830], // ~5 kHz
      [P.RESONANCE, 200],
      [P.KEYTRACK, KT_FULL],
      [P.AMP_ATTACK, 0],
      [P.AMP_DECAY, 800], // ~1.8 s ring-out
      [P.AMP_SUSTAIN, 0],
      [P.AMP_RELEASE, 780],
      [P.AMP_VELOCITY, 100],
      [P.DELAY_ROUTING, RT_POST],
      [P.DELAY_TIME, 850], // ~410 ms
      [P.DELAY_FEEDBACK, 480],
      [P.DELAY_HIPASS, 620],
      [P.PROGRAM_LEVEL, 100],
    ]),
  )

  // --------------------------------------------------------------- BASSES
  // MONO mode with the depth knob past the halfway point: voices 2+3 come in
  // a full octave down and voice 4 starts blending in two octaves down —
  // three-layer sub stack from one key. Dry, tight, 4-pole.
  bank.push(
    patch('Sub Stack', [
      [P.VOICE_MODE, VM_MONO],
      [P.VM_DEPTH, 760], // sub1 full, sub2 ~half blended
      [P.VCO1_WAVE, SAW],
      [P.VCO1_OCTAVE, OCT8],
      [P.VCO2_WAVE, SQR],
      [P.VCO2_OCTAVE, OCT8],
      [P.VCO2_SHAPE, 200],
      [P.VCO2_PITCH, 540], // +8 cents rub
      [P.VCO2_LEVEL, 850],
      [P.FILTER_TYPE, FT_4POLE],
      [P.CUTOFF, 430], // ~330 Hz
      [P.RESONANCE, 220],
      [P.KEYTRACK, KT_HALF],
      [P.EG_INT, 720], // +16% snap
      [P.EG_ATTACK, 0],
      [P.EG_DECAY, 460],
      [P.EG_SUSTAIN, 0],
      [P.AMP_ATTACK, 0],
      [P.AMP_DECAY, 560],
      [P.AMP_SUSTAIN, 800],
      [P.AMP_RELEASE, 140],
      [P.PROGRAM_LEVEL, 98], // sub voices stacked under every note
    ]),
  )

  // ---------------------------------------------------------------- CHORDS
  // CHORD mode in the m7 zone (366..438): one-finger dub stabs. The delay is
  // PRE-routed — its HPF sits on the WET path only, so every repeat comes
  // back thinner than the last (og-spec.md §9), the classic dub tail.
  bank.push(
    patch('Dub Stab', [
      [P.VOICE_MODE, VM_CHORD],
      [P.VM_DEPTH, 400], // m7
      [P.VCO1_WAVE, SAW],
      [P.VCO2_WAVE, SQR],
      [P.VCO2_SHAPE, 350],
      [P.VCO2_PITCH, 538], // +6 cents
      [P.VCO2_LEVEL, 650],
      [P.CUTOFF, 600], // ~1.1 kHz
      [P.RESONANCE, 300],
      [P.EG_INT, 690], // +11% bite
      [P.EG_ATTACK, 0],
      [P.EG_DECAY, 480],
      [P.EG_SUSTAIN, 0],
      [P.AMP_ATTACK, 0],
      [P.AMP_DECAY, 520],
      [P.AMP_SUSTAIN, 0],
      [P.AMP_RELEASE, 300],
      [P.DELAY_ROUTING, RT_PRE], // HPF on the wet only: repeats thin out
      [P.DELAY_TIME, 820], // ~330 ms
      [P.DELAY_FEEDBACK, 620], // 0.64 — long dub tail, still convergent
      [P.DELAY_HIPASS, 680], // ~340 Hz per pass
      [P.PROGRAM_LEVEL, 96], // 4 voices per key
    ]),
  )

  // ------------------------------------------------------------- SEQ / ECHO
  // DELAY voice mode: voices 2-4 replay each note in tempo-synced sequence,
  // depth parked in the 3/16 zone (854..938) — dotted-eighth echoes without
  // touching the delay FX (routing stays BYPASS so only the voice-mode
  // echoes speak). Sparse 16-step E-minor motif with a TIE, lane 0 opens the
  // filter across the bar.
  bank.push(
    patch('Cascade', [
      [P.VOICE_MODE, VM_DELAY],
      [P.VM_DEPTH, 896], // 3/16 — dotted-eighth echo spacing
      [P.VCO1_WAVE, SAW],
      [P.VCO2_WAVE, SAW],
      [P.VCO2_OCTAVE, OCT4],
      [P.VCO2_PITCH, 544], // +12 cents shimmer an octave up
      [P.VCO2_LEVEL, 450],
      [P.CUTOFF, 520], // ~620 Hz
      [P.RESONANCE, 350],
      [P.KEYTRACK, KT_FULL],
      [P.EG_INT, 740], // +19% pluck sweep
      [P.EG_ATTACK, 0],
      [P.EG_DECAY, 420],
      [P.EG_SUSTAIN, 0],
      [P.AMP_ATTACK, 0],
      [P.AMP_DECAY, 440],
      [P.AMP_SUSTAIN, 0],
      [P.AMP_RELEASE, 260],
      [P.LFO_KEY_SYNC, 1],
      [P.PROGRAM_LEVEL, 100],
    ], (seq) => {
      seq.bpm = 112
      // Sparse E minor motif — space for the voice-mode echoes to answer.
      st(seq, 0, [52], 45, 112) // E3
      st(seq, 3, [55], 40, 96) // G3
      st(seq, 6, [59], 40, 104) // B3
      st(seq, 10, [62], 40, 100) // D4
      st(seq, 12, [64], GATE_TIE, 118) // E4 ties through the silent step 13
      st(seq, 14, [59], 40, 92) // B3
      // Lane 0: filter opens steadily across the bar, echoes brighten.
      setMotion(seq, 0, P.CUTOFF, true, sweepLane(riseBp(360, 780)))
    }),
  )

  // ----------------------------------------------------------------- PADS
  // SIDE CHAIN pump: hold a pad chord, and every new note ducks the held
  // voices hard (depth ~80%) — play bass stabs over it for the pump. Slow
  // LFO stirs the cutoff underneath.
  bank.push(
    patch('Pump Pad', [
      [P.VOICE_MODE, VM_SIDECHAIN],
      [P.VM_DEPTH, 820], // deep duck
      [P.VCO1_WAVE, SAW],
      [P.VCO2_WAVE, SAW],
      [P.VCO2_PITCH, 541], // +9 cents
      [P.VCO2_LEVEL, 900],
      [P.CUTOFF, 660], // ~1.7 kHz
      [P.RESONANCE, 120],
      [P.AMP_ATTACK, 600], // ~90 ms swell
      [P.AMP_DECAY, 600],
      [P.AMP_SUSTAIN, 1023],
      [P.AMP_RELEASE, 550],
      [P.LFO_WAVE, TRI],
      [P.LFO_RATE, 300], // ~0.3 Hz drift
      [P.LFO_INT, 130], // ~0.9 octave of cutoff motion
      [P.LFO_TARGET, LT_CUTOFF],
      [P.DELAY_ROUTING, RT_POST],
      [P.DELAY_TIME, 800], // ~290 ms
      [P.DELAY_FEEDBACK, 380],
      [P.DELAY_HIPASS, 640],
      [P.PROGRAM_LEVEL, 98],
    ]),
  )

  // ----------------------------------------------------- EG MOD SHOWPIECES
  // EG MOD = RATE: the mod EG (slow attack, full sustain) pushes the LFO
  // speed up while the note develops — vibrato that starts as a lazy wobble
  // and accelerates into a shimmer. Unison detune for width; EG INT and
  // PITCH EG INT stay centered so the EG only drives the LFO.
  bank.push(
    patch('Accelerator', [
      [P.VOICE_MODE, VM_UNISON],
      [P.VM_DEPTH, 300], // ~15 cents stack detune
      [P.LFO_EG_MOD, EGM_RATE],
      [P.LFO_WAVE, TRI],
      [P.LFO_RATE, 380], // ~0.55 Hz at rest, EG winds it up
      [P.LFO_INT, 70], // ~80 cents of vibrato
      [P.LFO_TARGET, LT_PITCH],
      [P.EG_ATTACK, 780], // ~0.4 s wind-up
      [P.EG_DECAY, 700],
      [P.EG_SUSTAIN, 1023], // hold the fast rate while the key is down
      [P.EG_RELEASE, 300],
      [P.EG_INT, 512], // EG budget goes to the LFO, not the filter
      [P.PITCH_EG_INT, 512],
      [P.VCO1_WAVE, SAW],
      [P.VCO2_WAVE, SAW],
      [P.VCO2_PITCH, 543], // +11 cents
      [P.VCO2_LEVEL, 800],
      [P.CUTOFF, 720], // ~2.6 kHz
      [P.RESONANCE, 180],
      [P.AMP_ATTACK, 20],
      [P.AMP_DECAY, 500],
      [P.AMP_SUSTAIN, 880],
      [P.AMP_RELEASE, 240],
      [P.DELAY_ROUTING, RT_POST],
      [P.DELAY_TIME, 750], // ~200 ms
      [P.DELAY_FEEDBACK, 430],
      [P.DELAY_HIPASS, 560],
      [P.PROGRAM_LEVEL, 96], // 4-voice unison stack
    ]),
  )

  // EG MOD = INT: the singer's trick — the note lands dead straight, then
  // the EG's slow attack fades the LFO depth in and ~4.5 Hz vibrato blooms
  // half a second later. A touch of auto-portamento between phrases.
  bank.push(
    patch('Diva Lead', [
      [P.LFO_EG_MOD, EGM_INT],
      [P.LFO_WAVE, TRI],
      [P.LFO_RATE, 720], // ~4.4 Hz vibrato
      [P.LFO_INT, 60], // ~70 cents at full bloom
      [P.LFO_TARGET, LT_PITCH],
      [P.EG_ATTACK, 800], // ~0.5 s vibrato fade-in
      [P.EG_DECAY, 700],
      [P.EG_SUSTAIN, 1023],
      [P.EG_RELEASE, 200],
      [P.EG_INT, 512], // EG dedicated to the LFO depth
      [P.PITCH_EG_INT, 512],
      [P.PORTAMENTO, 45], // gentle auto-glide
      [P.PORTAMENTO_MODE, 0], // Auto
      [P.VCO1_WAVE, SAW],
      [P.VCO2_WAVE, TRI],
      [P.VCO2_OCTAVE, OCT8],
      [P.VCO2_PITCH, 537], // +5 cents
      [P.VCO2_LEVEL, 550],
      [P.CUTOFF, 700], // ~2.2 kHz
      [P.RESONANCE, 160],
      [P.AMP_ATTACK, 30],
      [P.AMP_DECAY, 550],
      [P.AMP_SUSTAIN, 900],
      [P.AMP_RELEASE, 320],
      [P.DELAY_ROUTING, RT_POST],
      [P.DELAY_TIME, 830], // ~350 ms
      [P.DELAY_FEEDBACK, 400],
      [P.DELAY_HIPASS, 600],
      [P.PROGRAM_LEVEL, 100],
    ]),
  )

  return bank
}

export const FACTORY_PRESETS: Program[] = buildPresets()
