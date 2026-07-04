/*
 * Korg monologue (2016) raw-value -> physical-unit curves, shared by the UI
 * (display) and the DSP (engine). Continuous panel knobs store hardware-style
 * raw values 0..1023. Tables reproduce the official monologue MIDI
 * Implementation Revision 1.00 (docs/monologue-spec.md), with the errata
 * resolutions from monologue-spec.md §15 applied. Provenance per
 * docs/hardware-calibration.md: DOCUMENTED(source) = straight from the docs,
 * UNCONFIRMED = best-effort inference and a calibration target (monologue
 * hardware is not owned; see monologue-spec.md §16).
 *
 * Deliberately imports nothing from src/synths/xd or src/synths/og — shared
 * shapes are transcribed, not linked, so per-synth calibration never crosses
 * definitions.
 */
import { clamp, lerp, expMap } from '../../shared/maps'
import type { SvfCfg } from '../../dsp/filter'
import type { DriveCfg } from '../../dsp/drive'

// Family microtuning presets (the monologue ships the same menu; spec §11).
export { MICRO_TUNINGS, microTuneCents } from '../../dsp/tuning'

// ---------------------------------------------------------------------------
// VCO PITCH knob: raw 0..1023 -> cents -1200..+1200
// DOCUMENTED(MIDIimp note P2, exact — the family piecewise table, same as the
// xd/OG; monologue-spec.md §3). Applies to VCO2 PITCH (panel knob) and to
// VCO1 PITCH (program data + CC34 only — no panel knob, spec §3).
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
// EG INT: stored 0..1023, bipolar around center 512 (knob positive, SHIFT+turn
// negative; OLED shows -511..+511). UNCONFIRMED encoding: center-512 is the
// community reading [decoder] — the official doc gives no mapping
// (monologue-spec.md §5, §16).
// ---------------------------------------------------------------------------
export function egIntTo01(raw: number): number {
  return clamp((clamp(raw, 0, 1023) - 512) / 511, -1, 1)
}

/** EG->pitch depth at full INT, in cents. UNCONFIRMED (family value — the
 *  OG's PITCH EG INT table spans ±4800¢; spec §16 depth scalings). */
export const EG_MAX_PITCH_CENTS = 4800
/** EG->cutoff depth at full INT, in octaves. UNCONFIRMED (family value). */
export const EG_MAX_CUTOFF_OCTAVES = 10

export function egIntToCents(raw: number): number {
  return egIntTo01(raw) * EG_MAX_PITCH_CENTS
}

// ---------------------------------------------------------------------------
// Envelope times. UNCONFIRMED: hardware seconds are undocumented; transcribed
// from the family (xd/OG replica) curves — same digital-EG lineage.
// ---------------------------------------------------------------------------
export function attackToSec(raw: number): number {
  return expMap(raw, 0.0006, 3.0)
}
export function decayToSec(raw: number): number {
  return expMap(raw, 0.002, 12.0)
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------
/** UNCONFIRMED: cutoff span unpublished; family exp taper (~16 Hz–21 kHz). */
export function cutoffToHz(raw: number): number {
  return expMap(raw, 16, 21000)
}
/** UNCONFIRMED: knob->resonance taper; linear (hotter than the OG's 1.1 pow —
 *  the MS-20-ish bite arrives earlier). Calibration target (spec §16). */
export function resonanceTo01(raw: number): number {
  return clamp(raw, 0, 1023) / 1023
}
/** Cutoff Velocity / Cutoff Key Track menu zones [0/50/100%] (spec §11). */
export const CUTOFF_VELOCITY_AMOUNT = [0, 0.5, 1] as const
export const CUTOFF_KEYTRACK_AMOUNT = [0, 0.5, 1] as const

/**
 * monologue filter voicing (monologue-spec.md §4, §14): 2-pole (12 dB/oct)
 * LP, "much more aggressive... reminiscent of the Korg MS-20" [MR], and — the
 * key difference from the OG — it KEEPS its bass at high resonance [SoS
 * "bite doesn't come at the expense of the bass end"], so resLoss is 0 and a
 * little bassComp holds the low end up instead.
 *   DOCUMENTED: 2-pole, self-oscillates at max resonance [MR], bass retained
 *   at high resonance [SoS].
 *   UNCONFIRMED (replica judgment, calibration-class — spec §16): resCurve
 *   1.7 (hotter taper than the xd's 1.4 — resonance ramps in earlier and
 *   harder), satLevel 1.0 (lower than the family's 1.25 so the feedback
 *   limiter screams earlier), bassComp 0.2 amount.
 */
export const MONO_FILTER_CFG: SvfCfg = {
  kMax: 2.0, // r = 0: critically damped, no resonant hump
  kMin: 0, // r = 1: self-oscillates (spec §4 — a playable third oscillator)
  resCurve: 1.7, // UNCONFIRMED taper (hotter than xd)
  driveGains: null, // DRIVE is a separate post-VCA stage (dsp/drive.ts), not in-filter
  driveMakeups: null,
  satLevel: 1.0, // UNCONFIRMED: earlier feedback saturation = earlier scream
  bassComp: 0.2, // UNCONFIRMED amount: keeps bass at high res (unlike the OG)
  resLoss: 0, // the OG's res-vs-bass tradeoff does NOT apply here (spec §4)
  poles: 2,
}

// ---------------------------------------------------------------------------
// LFO (spec §6): MODE picks the rate range. Program-data mode order is
// 0=1-SHOT, 1=SLOW, 2=FAST (byte 36 b2-3).
// ---------------------------------------------------------------------------
/** SLOW: 0.05–28 Hz. DOCUMENTED endpoints [OM/spec §6]; exponential shape
 *  UNCONFIRMED (assumed per family). Also the 1-SHOT range. */
export function lfoSlowHz(raw: number): number {
  return expMap(raw, 0.05, 28)
}
/** FAST: 0.5 Hz – 2.8 kHz, true audio rate. DOCUMENTED endpoints [OM/spec
 *  §6]; exponential shape UNCONFIRMED. */
export function lfoFastHz(raw: number): number {
  return expMap(raw, 0.5, 2800)
}
/** RATE in Hz for a mode (param enum: 0=1-SHOT, 1=SLOW, 2=FAST). 1-SHOT uses
 *  the slow curve — it is the slow range stopped after a half-cycle (spec §6). */
export function lfoRateToHz(raw: number, mode: number): number {
  return mode >= 2 ? lfoFastHz(raw) : lfoSlowHz(raw)
}

/** LFO INT: stored 0..1023, bipolar around center 512 (SHIFT+turn negative).
 *  UNCONFIRMED community encoding, like EG INT (spec §6, §16). */
export function lfoIntTo01(raw: number): number {
  return clamp((clamp(raw, 0, 1023) - 512) / 511, -1, 1)
}

/** LFO INT scaling per target at full depth. UNCONFIRMED (family values). */
export const LFO_MAX_PITCH_CENTS = 1200
export const LFO_MAX_CUTOFF_OCTAVES = 7
export const LFO_MAX_SHAPE = 1

/** BPM-sync divisions in 64-wide zones, values = whole-note fractions.
 *  DOCUMENTED(MIDIimp note P3 — the standard family 16-zone table). NOTE the
 *  spec §15.5 conflict: the owner's manual instead prints per-mode lists
 *  (FAST 1/8..1/2048, SLOW & 1-SHOT 4..1/64); we trust the MIDIimp for the
 *  stored zones — the per-mode display is UNCONFIRMED. */
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

// ---------------------------------------------------------------------------
// DRIVE (spec §7): continuous 0..1023 knob into the post-VCA overdrive stage
// (dsp/drive.ts). Raw->gain/makeup curve UNCONFIRMED (spec §16) — the docs
// only give character: "rougher, darker", never excessive, never a volume
// boost [SoS].
// ---------------------------------------------------------------------------
export function driveAmount01(raw: number): number {
  return clamp(raw, 0, 1023) / 1023
}

/** monologue drive voicing. UNCONFIRMED: ~1..8x input gain with a slightly
 *  slow taper (most of the dirt in the upper half — "even fully cranked,
 *  drive never becomes too much" [SoS]). Calibration target. */
export const MONO_DRIVE_CFG: DriveCfg = {
  gainMax: 8,
  gainCurve: 1.6,
}

// ---------------------------------------------------------------------------
// Mixer / levels
// ---------------------------------------------------------------------------
/** UNCONFIRMED taper (transcribed from the family replicas). */
export function levelTo01(raw: number): number {
  return Math.pow(clamp(raw, 0, 1023) / 1023, 1.2)
}

/** Program Level: stored 77..127 = -25..+25, 102 = center (spec §9/§11).
 *  DOCUMENTED(MIDIimp) storage; UNCONFIRMED units — likely 0.5 dB steps
 *  (same reading as the OG's byte 71). */
export function programLevelToDb(stored: number): number {
  return (clamp(stored, 77, 127) - 102) * 0.5
}

// ---------------------------------------------------------------------------
// Portamento: stored 0,1..129 = OFF,0..128 (spec §9 byte 41 — the same quirk
// as the OG's byte 61). UNCONFIRMED curve: family exponential over the
// 0..128 panel range (~3 ms .. ~5 s).
// ---------------------------------------------------------------------------
export function portamentoToSec(stored: number): number {
  if (stored <= 0) return 0
  return 0.003 * Math.pow(5000 / 3, (clamp(stored, 1, 129) - 1) / 128)
}

// ---------------------------------------------------------------------------
// SLIDE Time: stored 0..72 = 0..100% (spec §8/§9 byte 40) — how far a
// slide-flagged step glides into the next step's note. UNCONFIRMED seconds:
// the docs give only a percentage; 100% -> ~0.5 s linear is a musical guess
// (a full-length glide at moderate tempos). Calibration target (spec §16 —
// glide curve linear-vs-exponential also unresolved).
// ---------------------------------------------------------------------------
export function slideTimeToSec(stored: number): number {
  return (clamp(stored, 0, 72) / 72) * 0.5
}

// ---------------------------------------------------------------------------
// SLIDER assign (spec §11) — 16 destinations, default PITCH BEND. The set is
// DOCUMENTED (spec §11: GATE TIME, VCO pitches/shapes/levels, CUTOFF,
// RESONANCE, EG/LFO params, DRIVE); the index order of the hardware's byte-44
// stored values is UNCONFIRMED — this list is the replica's own stable enum,
// arranged like the OG's (virtual destinations first, then signal-path order).
// ---------------------------------------------------------------------------
export const SLIDER_ASSIGN_DESTS = [
  'PITCH BEND',
  'GATE TIME',
  'VCO1 PITCH',
  'VCO1 SHAPE',
  'VCO2 PITCH',
  'VCO2 SHAPE',
  'VCO1 LEVEL',
  'VCO2 LEVEL',
  'CUTOFF',
  'RESONANCE',
  'ATTACK',
  'DECAY',
  'EG INT',
  'LFO RATE',
  'LFO INT',
  'DRIVE',
] as const

// NOTE: the dest-index -> param-id mapping (sliderDestParam) lives in
// ./params.ts, not here: it needs the P id table, and params.ts already
// imports this module for labels/formatters — mapping ids here would create
// a params <-> curves cycle (the OG/xd curves are import-free of params too).

// ---------------------------------------------------------------------------
// Display formatting for monologue-curve-based values (OLED-style)
// ---------------------------------------------------------------------------
export function fmtCents(raw: number): string {
  const c = Math.round(pitchToCents(raw))
  return (c > 0 ? '+' : '') + c + 'C'
}
/** Center-512 bipolar knobs display -511..+511 with a sign (spec §5/§6). */
export function fmtEgIntBipolar(raw: number): string {
  const v = clamp(Math.round(raw) - 512, -511, 511)
  return (v > 0 ? '+' : '') + v
}
export function fmtLfoIntBipolar(raw: number): string {
  return fmtEgIntBipolar(raw)
}
