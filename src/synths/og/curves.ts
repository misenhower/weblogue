/*
 * Original Korg minilogue (OG, 2016) raw-value -> physical-unit curves, shared
 * by the UI (display) and the DSP (engine). Continuous panel knobs store
 * hardware-style raw values 0..1023. Piecewise tables reproduce the official
 * minilogue MIDI implementation rev 1.10 (see docs/og-spec.md), with the
 * errata corrections from og-spec.md §15 applied. Provenance per
 * docs/hardware-calibration.md: DOCUMENTED(source) = straight from the docs,
 * UNCONFIRMED = best-effort inference and a calibration target (OG hardware
 * is not owned; see og-spec.md §16).
 *
 * Deliberately imports nothing from src/synths/xd — shared shapes are
 * transcribed, not linked, so per-synth calibration never crosses definitions.
 */
import { clamp, lerp, expMap } from '../../shared/maps'
import type { SvfCfg } from '../../dsp/filter'

// ---------------------------------------------------------------------------
// VCO PITCH knob: raw 0..1023 -> cents -1200..+1200
// DOCUMENTED(MIDIimp note P2, exact — same table as the xd; og-spec.md §4)
// ---------------------------------------------------------------------------
const PITCH_SEGS: Array<[number, number, number, number]> = [
  [0, 4, -1200, -1200],
  [4, 356, -1200, -256],
  [356, 476, -256, -16],
  [476, 492, -16, 0],
  [492, 532, 0, 0],
  [532, 548, 0, 16],
  [548, 668, 16, 256],
  [668, 1020, 256, 1200],
  [1020, 1023, 1200, 1200],
]

export function pitchToCents(raw: number): number {
  const r = clamp(raw, 0, 1023)
  for (const [rl, rh, cl, ch] of PITCH_SEGS) {
    if (r <= rh) return rh === rl ? cl : lerp(cl, ch, (r - rl) / (rh - rl))
  }
  return 1200
}

// ---------------------------------------------------------------------------
// VCO2 PITCH EG INT knob: raw 0..1023 -> cents -4800..+4800 (EG -> VCO2 pitch)
// DOCUMENTED(MIDIimp note P3) with the og-spec.md §15.1 erratum applied: the
// official doc copy-pasted P2's positive rows (256..1200); corrected by
// symmetry to 1024..4800 / 4800. Verify on hardware.
// ---------------------------------------------------------------------------
const PITCH_EG_SEGS: Array<[number, number, number, number]> = [
  [0, 4, -4800, -4800],
  [4, 356, -4800, -1024],
  [356, 476, -1024, -64],
  [476, 492, -64, 0],
  [492, 532, 0, 0],
  [532, 548, 0, 64],
  [548, 668, 64, 1024],
  [668, 1020, 1024, 4800], // corrected (doc misprints 256..1200)
  [1020, 1023, 4800, 4800], // corrected (doc misprints 1200)
]

export function pitchEgIntToCents(raw: number): number {
  const r = clamp(raw, 0, 1023)
  for (const [rl, rh, cl, ch] of PITCH_EG_SEGS) {
    if (r <= rh) return rh === rl ? cl : lerp(cl, ch, (r - rl) / (rh - rl))
  }
  return 4800
}

// ---------------------------------------------------------------------------
// FILTER EG INT: raw 0..1023 -> percent -100..+100
// DOCUMENTED(MIDIimp note P4, exact formula — same quadratic as the xd)
// ---------------------------------------------------------------------------
export function egIntToPercent(raw: number): number {
  const v = clamp(Math.round(raw), 0, 1023)
  if (v <= 11) return -100
  if (v < 492) return -((492 - v) * (492 - v) * 4641 * 100) / 0x40000000
  if (v <= 532) return 0
  if (v < 1013) return ((v - 532) * (v - 532) * 4641 * 100) / 0x40000000
  return 100
}

/** EG->cutoff depth expressed in octaves at 100%. UNCONFIRMED (family value). */
export const EG_MAX_CUTOFF_OCTAVES = 10

// ---------------------------------------------------------------------------
// Envelope times. UNCONFIRMED for the OG: hardware seconds are undocumented;
// transcribed from the xd replica's curves (same digital-EG family).
// ---------------------------------------------------------------------------
export function attackToSec(raw: number): number {
  return expMap(raw, 0.0006, 3.0)
}
export function decayToSec(raw: number): number {
  return expMap(raw, 0.002, 12.0)
}
export function releaseToSec(raw: number): number {
  return expMap(raw, 0.002, 15.0)
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------
/** UNCONFIRMED: ~20 Hz–20 kHz per [SoS]; span/taper transcribed from the xd. */
export function cutoffToHz(raw: number): number {
  return expMap(raw, 16, 21000)
}
/** UNCONFIRMED: resonance taper guessed (pow); OG taper is a calibration target. */
export function resonanceTo01(raw: number): number {
  return Math.pow(clamp(raw, 0, 1023) / 1023, 1.1)
}
export const KEYTRACK_AMOUNT = [0, 0.5, 1] as const
export const CUTOFF_VELOCITY_AMOUNT = [0, 0.5, 1] as const

/**
 * OG filter voicing (og-spec.md §6, §14): switchable 2/4-pole low-pass, NO
 * drive stage, self-oscillates at high resonance (kMin 0), and — the OG's
 * signature — level/low-end LOSS as resonance rises (resLoss; the xd
 * revoicing removed this, so no bassComp here).
 *   DOCUMENTED: no drive, 2/4-pole switch, self-oscillation [SoS/MR].
 *   UNCONFIRMED: resLoss 0.35 amount, resCurve 1.3 taper (calibration targets).
 */
export const OG_FILTER_CFG: SvfCfg = {
  kMax: 2.0, // r = 0: critically damped, no resonant hump
  kMin: 0, // r = 1: self-oscillates (og-spec.md §6)
  resCurve: 1.3, // UNCONFIRMED taper
  driveGains: null, // the OG has no drive switch
  driveMakeups: null,
  satLevel: 1.25,
  bassComp: 0, // no low-end compensation — the loss is the character
  resLoss: 0.35, // UNCONFIRMED: output level loss at full resonance
  poles: 2,
}

// ---------------------------------------------------------------------------
// LFO
// ---------------------------------------------------------------------------
/** UNCONFIRMED for the OG: Hz range unpublished; family reference 0.05–28 Hz
 *  from the xd manual (og-spec.md §8). */
export function lfoRateToHz(raw: number): number {
  return expMap(raw, 0.05, 28)
}

/** BPM-sync divisions in 64-wide zones, values = whole-note fractions.
 *  DOCUMENTED(MIDIimp note P5 — same 16 zones as the xd; og-spec.md §8.
 *  The manual prints "…1/64" but the MIDIimp table ends at 1/36). */
export const LFO_BPM_DIVISIONS: ReadonlyArray<{ label: string; wholeNotes: number }> = [
  { label: '4', wholeNotes: 4 },
  { label: '2', wholeNotes: 2 },
  { label: '1', wholeNotes: 1 },
  { label: '3/4', wholeNotes: 3 / 4 },
  { label: '1/2', wholeNotes: 1 / 2 },
  { label: '3/8', wholeNotes: 3 / 8 },
  { label: '1/3', wholeNotes: 1 / 3 },
  { label: '1/4', wholeNotes: 1 / 4 },
  { label: '3/16', wholeNotes: 3 / 16 },
  { label: '1/6', wholeNotes: 1 / 6 },
  { label: '1/8', wholeNotes: 1 / 8 },
  { label: '1/12', wholeNotes: 1 / 12 },
  { label: '1/16', wholeNotes: 1 / 16 },
  { label: '1/24', wholeNotes: 1 / 24 },
  { label: '1/32', wholeNotes: 1 / 32 },
  { label: '1/36', wholeNotes: 1 / 36 },
]

export function lfoBpmDivIndex(raw: number): number {
  return Math.min(15, Math.floor(clamp(raw, 0, 1023) / 64))
}

export function lfoBpmToHz(raw: number, bpm: number): number {
  const div = LFO_BPM_DIVISIONS[lfoBpmDivIndex(raw)]
  // one whole note = 4 beats
  return bpm / 60 / (div.wholeNotes * 4)
}

/** LFO INT: UNIPOLAR raw 0..1023 -> 0..1 (og-spec.md §8 — the xd's
 *  512-centered bipolar store came later; do not transcribe it here). */
export function lfoIntTo01(raw: number): number {
  return clamp(raw, 0, 1023) / 1023
}

/** LFO INT scaling per target at full depth. UNCONFIRMED (family values). */
export const LFO_MAX_PITCH_CENTS = 1200
export const LFO_MAX_CUTOFF_OCTAVES = 7
export const LFO_MAX_SHAPE = 1

// ---------------------------------------------------------------------------
// Mixer / levels
// ---------------------------------------------------------------------------
/** UNCONFIRMED taper (transcribed from the xd replica). */
export function levelTo01(raw: number): number {
  return Math.pow(clamp(raw, 0, 1023) / 1023, 1.2)
}

/** Program Level: stored 77..127 = -25..+25, 102 = center (og-spec.md §11).
 *  DOCUMENTED(MIDIimp byte 71) storage; UNCONFIRMED units — likely 0.5 dB
 *  steps, so -25..+25 dB overall. */
export function programLevelToDb(stored: number): number {
  return (clamp(stored, 77, 127) - 102) * 0.5
}

// ---------------------------------------------------------------------------
// Portamento: stored 0,1..129 = OFF,0..128 (og-spec.md §11, byte 61).
// UNCONFIRMED curve: xd-style exponential over the 0..128 panel range.
// ---------------------------------------------------------------------------
export function portamentoToSec(stored: number): number {
  if (stored <= 0) return 0
  return 0.003 * Math.pow(5000 / 3, (clamp(stored, 1, 129) - 1) / 128) // ~3ms .. ~5s
}

// ---------------------------------------------------------------------------
// Voice-mode depth semantics (og-spec.md §3)
// ---------------------------------------------------------------------------

/** POLY: depth = chord Invert 0..8. DOCUMENTED range [OM p.24]; zone layout
 *  (nine equal zones) and voicing behavior UNCONFIRMED. */
export function polyInvert(raw: number): number {
  return Math.min(8, Math.floor((clamp(raw, 0, 1023) * 9) / 1024))
}

/** DUO: unison-pair detune, 0..50 cents linear. DOCUMENTED [OM p.24]. */
export function duoDetuneCents(raw: number): number {
  return (clamp(raw, 0, 1023) / 1023) * 50
}

/** UNISON: 4-voice stack detune, 0..50 cents linear. DOCUMENTED [OM p.24]. */
export function unisonDetuneCents(raw: number): number {
  return (clamp(raw, 0, 1023) / 1023) * 50
}

/**
 * MONO: sub-oscillator mix. Depth first brings in voices 2+3 at -1 octave
 * (sub1), further right adds voice 4 at -2 octaves (sub2) [OM p.24].
 * UNCONFIRMED placeholder crossfade: sub1 ramps 0..1 over the lower half,
 * sub2 ramps 0..1 over the upper half.
 */
export function monoSubMix(raw: number): { sub1: number; sub2: number } {
  const r = clamp(raw, 0, 1023) / 1023
  return {
    sub1: Math.min(1, r * 2),
    sub2: Math.max(0, r * 2 - 1),
  }
}

/** SIDE CHAIN: depth = duck amount 0..1 (max ~mutes held notes [MR]).
 *  Linear scaling UNCONFIRMED; duck curve/recovery are engine concerns. */
export function sideChainDepth01(raw: number): number {
  return clamp(raw, 0, 1023) / 1023
}

/** CHORD zone table — DOCUMENTED(MIDIimp note P12; same 14 chords as the xd). */
export const CHORDS: ReadonlyArray<{ name: string; notes: readonly number[] }> = [
  { name: '5th', notes: [0, 7] },
  { name: 'sus2', notes: [0, 2, 7] },
  { name: 'm', notes: [0, 3, 7] },
  { name: 'Maj', notes: [0, 4, 7] },
  { name: 'sus4', notes: [0, 5, 7] },
  { name: 'm7', notes: [0, 3, 7, 10] },
  { name: '7', notes: [0, 4, 7, 10] },
  { name: '7sus4', notes: [0, 5, 7, 10] },
  { name: 'Maj7', notes: [0, 4, 7, 11] },
  { name: 'aug', notes: [0, 4, 8] },
  { name: 'dim', notes: [0, 3, 6] },
  { name: 'm7b5', notes: [0, 3, 6, 10] },
  { name: 'mMaj7', notes: [0, 3, 7, 11] },
  { name: 'Maj7b5', notes: [0, 4, 6, 11] },
]
const CHORD_HI = [73, 146, 219, 292, 365, 438, 511, 585, 658, 731, 804, 877, 950, 1023]

export function chordIndex(raw: number): number {
  const r = clamp(raw, 0, 1023)
  for (let i = 0; i < CHORD_HI.length; i++) if (r <= CHORD_HI[i]) return i
  return CHORD_HI.length - 1
}

/** ARP types — same 13 names as the xd, but the OG's OWN zone boundaries
 *  (DOCUMENTED(MIDIimp note P12); og-spec.md §3 — these differ from the xd's). */
export const ARP_TYPES = [
  'MANUAL 1',
  'MANUAL 2',
  'RISE 1',
  'RISE 2',
  'FALL 1',
  'FALL 2',
  'RISE FALL 1',
  'RISE FALL 2',
  'POLY 1',
  'POLY 2',
  'RANDOM 1',
  'RANDOM 2',
  'RANDOM 3',
] as const
const ARP_HI = [78, 157, 236, 315, 393, 472, 551, 630, 708, 787, 866, 945, 1023]

export function arpTypeIndex(raw: number): number {
  const r = clamp(raw, 0, 1023)
  for (let i = 0; i < ARP_HI.length; i++) if (r <= ARP_HI[i]) return i
  return ARP_HI.length - 1
}

/**
 * DELAY voice mode: tempo-synced echo spacing, 12 zones. Values in beats
 * (one whole note = 4 beats, so a 1/192 note = 4/192 beats).
 * DOCUMENTED(MIDIimp note P12) with the og-spec.md §15.2 erratum applied:
 * the 1/16 zone starts at 512 (doc misprints 521).
 */
export const DELAY_MODE_DIVISIONS: ReadonlyArray<{ label: string; beats: number }> = [
  { label: '1/192', beats: 4 / 192 },
  { label: '1/128', beats: 4 / 128 },
  { label: '1/64', beats: 4 / 64 },
  { label: '1/48', beats: 4 / 48 },
  { label: '1/32', beats: 4 / 32 },
  { label: '1/24', beats: 4 / 24 },
  { label: '1/16', beats: 4 / 16 },
  { label: '1/12', beats: 4 / 12 },
  { label: '1/8', beats: 4 / 8 },
  { label: '1/6', beats: 4 / 6 },
  { label: '3/16', beats: (4 * 3) / 16 },
  { label: '1/4', beats: 4 / 4 },
]
const DELAY_MODE_HI = [85, 170, 255, 341, 426, 511, 597, 682, 767, 853, 938, 1023]

export function delayModeDivision(raw: number): { label: string; beats: number } {
  const r = clamp(raw, 0, 1023)
  for (let i = 0; i < DELAY_MODE_HI.length; i++) {
    if (r <= DELAY_MODE_HI[i]) return DELAY_MODE_DIVISIONS[i]
  }
  return DELAY_MODE_DIVISIONS[DELAY_MODE_DIVISIONS.length - 1]
}

// ---------------------------------------------------------------------------
// DELAY (the OG's only effect; og-spec.md §9)
// ---------------------------------------------------------------------------
/** UNCONFIRMED: ms range unpublished; xd-free-delay-style exponential span. */
export function delayTimeToSec(raw: number): number {
  return expMap(raw, 0.001, 1.4)
}

/** Feedback loop gain 0..1.05 — max "a tad greater than unity", runs away
 *  into self-oscillation. DOCUMENTED character [SoS]; scaling UNCONFIRMED. */
export function delayFeedback01(raw: number): number {
  return (clamp(raw, 0, 1023) / 1023) * 1.05
}

/** UNCONFIRMED: HPF corner range guessed ~10..2000 Hz. */
export function delayHipassHz(raw: number): number {
  return expMap(raw, 10, 2000)
}

// ---------------------------------------------------------------------------
// SLIDER assign (og-spec.md §11) — 29 destinations, exact MIDIimp P13 order.
// ---------------------------------------------------------------------------
export const SLIDER_ASSIGN_DESTS = [
  'PITCH BEND',
  'GATE TIME',
  'VCO1 PITCH',
  'VCO1 SHAPE',
  'VCO2 PITCH',
  'VCO2 SHAPE',
  'CROSS MOD DEPTH',
  'VCO2 PITCH EG INT',
  'VCO1 LEVEL',
  'VCO2 LEVEL',
  'NOISE LEVEL',
  'CUTOFF',
  'RESONANCE',
  'FILTER EG INT',
  'AMP EG ATTACK',
  'AMP EG DECAY',
  'AMP EG SUSTAIN',
  'AMP EG RELEASE',
  'EG ATTACK',
  'EG DECAY',
  'EG SUSTAIN',
  'EG RELEASE',
  'LFO RATE',
  'LFO INT',
  'DELAY HI PASS CUTOFF',
  'DELAY TIME',
  'DELAY FEEDBACK',
  'PORTAMENTO',
  'VOICE MODE DEPTH',
] as const

// NOTE: the dest-index -> param-id mapping (sliderDestParam) lives in
// ./params.ts, not here: it needs the P id table, and params.ts already
// imports this module for labels/formatters — mapping ids here would create
// a params <-> curves cycle (the xd's curves are import-free of params too).

// ---------------------------------------------------------------------------
// Display formatting for OG-curve-based values (OLED-style)
// ---------------------------------------------------------------------------
export function fmtCents(raw: number): string {
  const c = Math.round(pitchToCents(raw))
  return (c > 0 ? '+' : '') + c + 'C'
}
export function fmtPitchEgInt(raw: number): string {
  const c = Math.round(pitchEgIntToCents(raw))
  return (c > 0 ? '+' : '') + c + 'C'
}
export function fmtEgInt(raw: number): string {
  const p = egIntToPercent(raw)
  const r = Math.abs(p) < 10 ? p.toFixed(1) : p.toFixed(0)
  return (p > 0 ? '+' : '') + r + '%'
}
