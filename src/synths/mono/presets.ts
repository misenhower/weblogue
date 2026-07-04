/*
 * Korg monologue factory preset bank — 10 programs showcasing what makes the
 * monologue the monologue (docs/monologue-spec.md): the aggressive bass-
 * retaining 2-pole filter under a post-VCA DRIVE, the SYNC/RING exclusive
 * switch, NOISE living on VCO2's wave selector, the 3-type EG (A/D, A/G/D,
 * GATE with the A/D envelope freed for the target), the FAST audio-rate LFO
 * standing in for cross mod, the 1-SHOT LFO as a second envelope, per-step
 * sequencer SLIDE, and the microtuning menu. These are the replica's own
 * patches, NOT reproductions of the hardware's 80 factory programs.
 *
 * Values are chosen against the mapping curves in ./curves.ts:
 *   - CUTOFF is exponential 16 Hz..21 kHz: ~350 = 190 Hz, ~440 = 350 Hz,
 *     ~500 = 535 Hz, ~560 = 815 Hz, ~700 = 2.2 kHz, ~800 = 4.4 kHz.
 *   - EG_INT / LFO_INT store 512 = zero (bipolar center-512). At full throw
 *     the EG spans +/-4800 cents on pitch (~768 = +2.4k cents) and +/-10
 *     octaves on cutoff (~665 = +3 oct); the LFO spans +/-1200 cents on
 *     pitch (~900 = +900c) and +/-7 octaves on cutoff.
 *   - LFO RATE: SLOW/1-SHOT 0.05..28 Hz (~750 = 5 Hz); FAST 0.5 Hz..2.8 kHz
 *     (~700 = 180 Hz, ~780 = 360 Hz) — true audio rate (spec §6).
 *   - Envelope times are exponential: decay ~520 = 0.17 s, ~700 = 0.8 s.
 *   - DRIVE is the continuous post-VCA overdrive 0..1023 (spec §7).
 *   - PROGRAM_LEVEL stores 77..127 = -12.5..+12.5 dB, 102 = unity.
 *
 * Sequences: the monologue's step events store note + gate only — no per-step
 * velocity (spec §8) — so every step here keeps the constant velocity 100.
 * SLIDE is the program-level per-step flag: a flagged step glides INTO the
 * next step's note by SLIDE_TIME (spec §8).
 */
import { P, clampParam } from './params'
import { initProgram } from './program'
import { MICRO_TUNINGS } from './curves'
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
const NOISE = 0 // VCO2 WAVE: NOISE replaces SQR (spec §2/§10)
const OCT16 = 0
const OCT8 = 1
const OCT2 = 3
const SR_RING = 0 // SYNC/RING 3-pos, byte 32 b0-1 order (spec §3)
const SR_SYNC = 2
const EG_GATE = 0 // EG TYPE, byte 34 b0-1 order (spec §5)
const EG_AGD = 1
const EG_AD = 2
const ET_CUTOFF = 0 // EG TARGET (spec §5)
const ET_PITCH2 = 1
const LM_1SHOT = 0 // LFO MODE, byte 36 b2-3 order (spec §6)
const LM_SLOW = 1
const LM_FAST = 2
const LT_CUTOFF = 0 // LFO TARGET (spec §6)
const LT_SHAPE = 1
const LT_PITCH = 2
const KT_FULL = 2 // CUTOFF KEY TRACK / VELOCITY zones 0/50/100%
const PM_ON = 1 // PORTAMENTO MODE: Auto / On
const PELOG = MICRO_TUNINGS.findIndex((t) => t.name === 'Pelog')

type Edit = readonly [number, number]

function patch(name: string, edits: readonly Edit[], seqEdit?: (seq: SeqData) => void): Program {
  const prog = initProgram(name)
  for (const [id, v] of edits) prog.params[id] = clampParam(id, v)
  if (seqEdit) seqEdit(prog.seq)
  return prog
}

/** Write one MONOPHONIC sequencer step (spec §8: 1 note + gate, no per-step
 *  velocity — constant 100). slide = glide INTO the next step's note. */
function st(seq: SeqData, i: number, note: number, gate: number, slide = false): void {
  seq.steps[i] = { on: true, notes: [note], vels: [100], gates: [gate] }
  // Key only present when set, so slide-less steps round-trip byte-identically.
  if (slide) seq.steps[i].slide = true
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

  // --------------------------------------------------------------- BASSES
  // Fat sub: square + triangle both at 16', A/G/D holds the note at full VCA
  // while held (DECAY doubles as the release, spec §5), a small EG blip snaps
  // the filter, and the post-VCA DRIVE is pushed hard — "rougher, darker",
  // never a volume boost (spec §7), so the sub stays a sub but gets teeth.
  bank.push(
    patch('Sub Driver', [
      [P.VCO1_WAVE, SQR],
      [P.VCO1_SHAPE, 0], // full square = strongest fundamental
      [P.VCO1_OCTAVE, OCT16],
      [P.VCO1_LEVEL, 1023],
      [P.VCO2_WAVE, TRI],
      [P.VCO2_OCTAVE, OCT16],
      [P.VCO2_LEVEL, 900],
      [P.CUTOFF, 440], // ~350 Hz
      [P.RESONANCE, 180],
      [P.EG_TYPE, EG_AGD],
      [P.EG_TARGET, ET_CUTOFF],
      [P.EG_INT, 600], // +1.7 oct snap
      [P.EG_ATTACK, 0],
      [P.EG_DECAY, 620], // ~0.39 s release from note-off
      [P.DRIVE, 820], // pushed — the monologue signature grit
      [P.PROGRAM_LEVEL, 98], // trimmed under the drive
    ]),
  )

  // ------------------------------------------------------------- SEQ / ACID
  // The signature move: a 16-step E-minor acid line with SLIDE flagged on 3
  // steps (each glides INTO the next step's note by SLIDE_TIME, spec §8), the
  // A/D EG squelching the MS-20-ish filter — which KEEPS its bass at high
  // resonance (spec §4), so the low E stays fat under RES ~83%. Lane 0 rides
  // the cutoff up to the squelch point mid-bar and back down.
  bank.push(
    patch('Slide Acid', [
      [P.VCO1_WAVE, SAW],
      [P.VCO1_OCTAVE, OCT16],
      [P.VCO1_LEVEL, 1023],
      [P.VCO2_LEVEL, 0],
      [P.CUTOFF, 350], // ~190 Hz floor
      [P.RESONANCE, 850], // near-scream, bass intact (unlike the OG)
      [P.EG_TYPE, EG_AD], // percussive: decays to 0 even while held
      [P.EG_TARGET, ET_CUTOFF],
      [P.EG_INT, 700], // +3.7 oct squelch sweep
      [P.EG_ATTACK, 0],
      [P.EG_DECAY, 550], // ~0.21 s
      [P.DRIVE, 320], // acid loves a little dirt
      [P.SLIDE_TIME, 48], // 67% glide
      [P.PROGRAM_LEVEL, 100],
    ], (seq) => {
      seq.bpm = 128
      // E1-rooted 303-ism: octave jumps, a chromatic approach, 3 slides.
      st(seq, 0, 28, 40) // E1
      st(seq, 1, 28, 24)
      st(seq, 2, 40, 30, true) // E2 — slides down into the low E
      st(seq, 3, 28, 24)
      st(seq, 4, 31, 40) // G1
      st(seq, 5, 28, 24)
      st(seq, 6, 26, 30) // D1
      st(seq, 7, 40, 50, true) // E2 — slides into the downbeat E1
      st(seq, 8, 28, 40)
      st(seq, 9, 38, 24) // D2
      st(seq, 10, 28, 30)
      st(seq, 11, 31, 24)
      st(seq, 12, 26, 40, true) // D1 — slides up toward the approach note
      st(seq, 13, 29, 24) // F1 chromatic approach
      st(seq, 14, 40, 55)
      st(seq, 15, 31, 30)
      // Lane 0: cutoff climbs to the squelch point mid-bar, then back down.
      setMotion(seq, 0, P.CUTOFF, true, sweepLane(triangleBp(300, 620)))
    }),
  )

  // ----------------------------------------------------------------- LEADS
  // Hard sync scream: VCO2 slaved to VCO1 (SYNC), and the EG aimed at
  // PITCH 2 only (spec §5) sweeps the slave ~+2.7k cents down onto a +160c
  // offset — the classic tearing sync lead from one A/D envelope while the
  // A/G/D VCA holds the note.
  bank.push(
    patch('Sync Razor', [
      [P.SYNC_RING, SR_SYNC],
      [P.VCO1_WAVE, SAW],
      [P.VCO1_LEVEL, 400],
      [P.VCO2_WAVE, SAW],
      [P.VCO2_OCTAVE, OCT8],
      [P.VCO2_PITCH, 620], // +160 cents landing offset
      [P.VCO2_LEVEL, 1023],
      [P.CUTOFF, 800], // ~4.4 kHz — let the sync buzz through
      [P.RESONANCE, 120],
      [P.EG_TYPE, EG_AGD],
      [P.EG_TARGET, ET_PITCH2], // the whole EG budget on the slave's pitch
      [P.EG_INT, 800], // ~+2.7k cents of sweep
      [P.EG_ATTACK, 0],
      [P.EG_DECAY, 660], // ~0.55 s settle
      [P.DRIVE, 180],
      [P.PROGRAM_LEVEL, 100],
    ]),
  )

  // ------------------------------------------------------------ PERCUSSION
  // RING metal: VCO1 square ring-modulates VCO2 (the product REPLACES VCO2's
  // output, spec §3), VCO2 a sharp 4th-ish up at 2' for inharmonic clang, a
  // short A/D on both VCA and cutoff — and the monologue's hard-reset
  // retrigger (spec §5) keeps every hit snapping from zero.
  bank.push(
    patch('Ring Clang', [
      [P.SYNC_RING, SR_RING],
      [P.VCO1_WAVE, SQR],
      [P.VCO1_LEVEL, 220], // a little carrier bleed under the product
      [P.VCO2_WAVE, SAW],
      [P.VCO2_OCTAVE, OCT2],
      [P.VCO2_PITCH, 690], // ~+315 cents = inharmonic sum/difference partials
      [P.VCO2_LEVEL, 1023],
      [P.CUTOFF, 800], // ~4.4 kHz
      [P.RESONANCE, 260],
      [P.CUTOFF_KEYTRACK, KT_FULL], // clang follows the key
      [P.EG_TYPE, EG_AD], // short A/D percussion
      [P.EG_TARGET, ET_CUTOFF],
      [P.EG_INT, 680], // +3.3 oct transient
      [P.EG_ATTACK, 0],
      [P.EG_DECAY, 520], // ~0.17 s clang
      [P.PROGRAM_LEVEL, 102],
    ]),
  )

  // NOISE kit: the white noise generator on VCO2's wave selector (spec §3),
  // GATE-type VCA (flat rectangular gate — the sequencer's per-step gate
  // times ARE the amp envelope) with the A/D envelope freed to blip the
  // cutoff (spec §5). Hats on short gates, snares on longer ones; lane 0
  // steps the EG decay long on the backbeats; step 13 is masked out of the
  // active steps for a 15-step lurch.
  bank.push(
    patch('Noise Kit', [
      [P.VCO1_LEVEL, 0],
      [P.VCO2_WAVE, NOISE], // SHAPE is inert on NOISE (spec §3)
      [P.VCO2_LEVEL, 1023],
      [P.CUTOFF, 560], // ~815 Hz base — the EG blip opens it per hit
      [P.RESONANCE, 300],
      [P.EG_TYPE, EG_GATE], // VCA = gate; the A/D belongs to the cutoff
      [P.EG_TARGET, ET_CUTOFF],
      [P.EG_INT, 720], // +4.1 oct snap
      [P.EG_ATTACK, 0],
      [P.EG_DECAY, 380], // hat-length blip (lane 0 lengthens the snares)
      [P.PROGRAM_LEVEL, 102],
    ], (seq) => {
      seq.bpm = 118
      st(seq, 0, 40, 10) // hats: short gates
      st(seq, 2, 40, 8)
      st(seq, 4, 40, 30) // snare: longer gate on the backbeat
      st(seq, 6, 40, 8)
      st(seq, 8, 40, 10)
      st(seq, 9, 40, 6) // off-beat chatter
      st(seq, 10, 40, 8)
      st(seq, 12, 40, 30) // snare
      st(seq, 14, 40, 10)
      st(seq, 15, 40, 6) // ghost
      // Skip a (silent) step entirely: 15 active steps = lurching bar.
      seq.activeSteps[13] = false
      // Lane 0 (stepped): EG DECAY jumps long on the snare steps only.
      const decays = [380, 380, 380, 380, 620, 380, 380, 380, 380, 380, 380, 380, 620, 380, 380, 380]
      setMotion(seq, 0, P.EG_DECAY, false, decays.map((v) => flat5(v)))
    }),
  )

  // ------------------------------------------------- FAST-LFO SHOWPIECES
  // Audio-rate FM growl: the FAST LFO (0.5 Hz..2.8 kHz, spec §6) runs a
  // triangle at ~180 Hz into PITCH — the pseudo-cross-mod that "greatly
  // offsets the absence" of a real cross mod knob [SoS]. The LFO does not
  // keytrack, so the clang gets more inharmonic away from the sweet spot.
  bank.push(
    patch('Growl FM', [
      [P.VCO1_WAVE, SAW],
      [P.VCO1_OCTAVE, OCT16],
      [P.VCO1_LEVEL, 1023],
      [P.VCO2_LEVEL, 0],
      [P.LFO_WAVE, TRI],
      [P.LFO_MODE, LM_FAST],
      [P.LFO_RATE, 700], // ~180 Hz — audio-rate
      [P.LFO_INT, 900], // ~+900 cents of pitch mod = FM growl
      [P.LFO_TARGET, LT_PITCH],
      [P.CUTOFF, 560],
      [P.RESONANCE, 350],
      [P.EG_TYPE, EG_AGD],
      [P.EG_TARGET, ET_CUTOFF],
      [P.EG_INT, 620], // +2.1 oct bite on the attack
      [P.EG_ATTACK, 0],
      [P.EG_DECAY, 640],
      [P.DRIVE, 480], // saturate the sidebands together
      [P.PROGRAM_LEVEL, 100],
    ]),
  )

  // Pseudo-ring texture: a FAST square LFO chopping the CUTOFF at ~360 Hz.
  // Audio-rate filter modulation imposes AM sidebands on the plain triangle
  // carrier — ring-mod-flavored metal without touching the SYNC/RING switch.
  // The authentic "noticeable parameter stepping" at fast rates (spec §6)
  // is part of the charm.
  bank.push(
    patch('Pseudo Ring', [
      [P.VCO1_WAVE, TRI], // pure-ish carrier = clearest sidebands
      [P.VCO1_LEVEL, 1023],
      [P.VCO2_LEVEL, 0],
      [P.LFO_WAVE, SQR],
      [P.LFO_MODE, LM_FAST],
      [P.LFO_RATE, 780], // ~360 Hz chop
      [P.LFO_INT, 940], // ~+5.9 oct of cutoff swing
      [P.LFO_TARGET, LT_CUTOFF],
      [P.CUTOFF, 500], // ~535 Hz center — the square slams it both ways
      [P.RESONANCE, 620], // band emphasis rings the chop
      [P.EG_TYPE, EG_AGD],
      [P.EG_ATTACK, 650], // ~0.13 s soft edge into the texture
      [P.EG_DECAY, 700],
      [P.EG_INT, 512], // EG stays out of it — the LFO owns the filter
      [P.PROGRAM_LEVEL, 100],
    ]),
  )

  // 1-SHOT pluck: the LFO as a second envelope (spec §6 — saw = decay
  // envelope, stops one half-cycle after note-on). The saw one-shot sweeps
  // the cutoff for ~150 ms while the A/D EG shapes the VCA, giving the
  // two-envelope pluck a single-EG synth shouldn't have.
  bank.push(
    patch('Pluck Shot', [
      [P.VCO1_WAVE, SQR],
      [P.VCO1_SHAPE, 380], // narrowed pulse
      [P.VCO1_LEVEL, 1023],
      [P.VCO2_WAVE, TRI],
      [P.VCO2_OCTAVE, OCT8],
      [P.VCO2_LEVEL, 400],
      [P.LFO_WAVE, SAW],
      [P.LFO_MODE, LM_1SHOT],
      [P.LFO_RATE, 680], // ~3.4 Hz -> half-cycle ~150 ms decay
      [P.LFO_INT, 820], // +4.2 oct filter pluck
      [P.LFO_TARGET, LT_CUTOFF],
      [P.CUTOFF, 420], // ~300 Hz floor the one-shot lifts from
      [P.RESONANCE, 520],
      [P.EG_TYPE, EG_AD], // VCA pluck from the real EG
      [P.EG_TARGET, ET_CUTOFF],
      [P.EG_INT, 512], // centered: the 1-SHOT is the filter envelope
      [P.EG_ATTACK, 0],
      [P.EG_DECAY, 560], // ~0.23 s body
      [P.PROGRAM_LEVEL, 102],
    ]),
  )

  // ------------------------------------------------------------ MICROTUNED
  // Pelog bells: the microtuning menu (spec §11) re-roots the Pelog table on
  // E (SCALE_KEY +4) under an inharmonic two-VCO bell (VCO2 at 2', ~+475
  // cents), long A/D ring-outs, a slow LFO stirring the triangle fold. The
  // 1/8-resolution sequence drifts through two bars; lane 0 slowly opens the
  // filter; one TIE lets a bell ring through its silent neighbor.
  bank.push(
    patch('Pelog Bells', [
      [P.MICRO_TUNING, PELOG],
      [P.SCALE_KEY, 16], // +4 = rooted on E (the monologue's E-to-E keys)
      [P.VCO1_WAVE, TRI],
      [P.VCO1_SHAPE, 300], // some fold for the LFO to stir
      [P.VCO1_OCTAVE, OCT8],
      [P.VCO1_LEVEL, 1023],
      [P.VCO2_WAVE, SAW],
      [P.VCO2_OCTAVE, OCT2],
      [P.VCO2_PITCH, 750], // ~+475 cents = inharmonic bell partial
      [P.VCO2_LEVEL, 480],
      [P.CUTOFF, 560], // lane 0 opens it across the phrase
      [P.RESONANCE, 380],
      [P.CUTOFF_KEYTRACK, KT_FULL],
      [P.EG_TYPE, EG_AD],
      [P.EG_TARGET, ET_CUTOFF],
      [P.EG_INT, 580], // +1.3 oct strike brightness
      [P.EG_ATTACK, 0],
      [P.EG_DECAY, 780], // ~1.5 s ring-out
      [P.LFO_WAVE, TRI],
      [P.LFO_MODE, LM_SLOW],
      [P.LFO_RATE, 400], // ~0.6 Hz shimmer
      [P.LFO_INT, 620], // gentle fold stir
      [P.LFO_TARGET, LT_SHAPE],
      [P.PROGRAM_LEVEL, 102],
    ], (seq) => {
      seq.bpm = 100
      seq.stepResolution = 1 // 1/8 — a two-bar phrase
      st(seq, 0, 40, 60) // E2
      st(seq, 2, 43, 50) // G2
      st(seq, 3, 45, 40) // A2
      st(seq, 4, 47, GATE_TIE) // B2 — ties through the silent step 5
      st(seq, 6, 45, 40)
      st(seq, 8, 50, 60) // D3
      st(seq, 10, 52, 50) // E3
      st(seq, 11, 50, 40)
      st(seq, 12, 47, GATE_TIE) // ties through step 13
      st(seq, 14, 45, 45)
      st(seq, 15, 43, 40)
      // Lane 0: the phrase slowly brightens.
      setMotion(seq, 0, P.CUTOFF, true, sweepLane(riseBp(380, 720)))
    }),
  )

  // ----------------------------------------------------------- CLASSIC LEAD
  // Portamento lead: two saws with an +8-cent rub, always-on glide — which
  // on the monologue also flips the EG to single-trigger legato (spec §5),
  // so held lines glide without re-snapping — slow triangle vibrato, and a
  // touch of drive to keep it vocal.
  bank.push(
    patch('Porta Lead', [
      [P.VCO1_WAVE, SAW],
      [P.VCO1_OCTAVE, OCT8],
      [P.VCO1_LEVEL, 1023],
      [P.VCO2_WAVE, SAW],
      [P.VCO2_OCTAVE, OCT8],
      [P.VCO2_PITCH, 540], // +8 cents rub
      [P.VCO2_LEVEL, 800],
      [P.CUTOFF, 680], // ~1.9 kHz
      [P.RESONANCE, 160],
      [P.EG_TYPE, EG_AGD],
      [P.EG_TARGET, ET_CUTOFF],
      [P.EG_INT, 640], // +2.5 oct
      [P.EG_ATTACK, 250], // ~5 ms soft edge
      [P.EG_DECAY, 700], // ~0.77 s release
      [P.LFO_WAVE, TRI],
      [P.LFO_MODE, LM_SLOW],
      [P.LFO_RATE, 750], // ~5.2 Hz vibrato
      [P.LFO_INT, 530], // ~+42 cents
      [P.LFO_TARGET, LT_PITCH],
      [P.DRIVE, 140], // warmth, not fuzz
      [P.PORTAMENTO, 56], // panel 55 (stored 0,1..129 = OFF,0..128 quirk)
      [P.PORTAMENTO_MODE, PM_ON], // glide always, not just legato
      [P.PROGRAM_LEVEL, 100],
    ]),
  )

  return bank
}

export const FACTORY_PRESETS: Program[] = buildPresets()
