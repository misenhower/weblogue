/*
 * minilogue xd raw-value -> physical-unit curves, shared by the UI (display)
 * and the DSP (engine). Continuous panel knobs store hardware-style raw
 * values 0..1023. Piecewise tables reproduce the official minilogue xd MIDI
 * implementation (see docs/xd-spec.md); values that had to be guessed are
 * marked UNCONFIRMED and are calibration targets
 * (docs/hardware-calibration.md).
 */
import { clamp, lerp, expMap } from '../../shared/maps'
import type { SvfCfg } from '../../dsp/filter'

// ---------------------------------------------------------------------------
// VCO PITCH knob: raw 0..1023 -> cents -1200..+1200 [MIDIimp note P5, exact]
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
// EG INT: raw 0..1023 -> percent -100..+100 [MIDIimp note P10, exact formula]
// ---------------------------------------------------------------------------
export function egIntToPercent(raw: number): number {
  const v = clamp(Math.round(raw), 0, 1023)
  if (v <= 11) return -100
  if (v < 492) return -((492 - v) * (492 - v) * 4641 * 100) / 0x40000000
  if (v <= 532) return 0
  if (v < 1013) return ((v - 532) * (v - 532) * 4641 * 100) / 0x40000000
  return 100
}

/** EG->pitch depth at 100% (cents). UNCONFIRMED on hardware; musical choice. */
export const EG_MAX_PITCH_CENTS = 4800

/** EG->cutoff depth expressed in octaves at 100%. UNCONFIRMED on hardware. */
export const EG_MAX_CUTOFF_OCTAVES = 10

// ---------------------------------------------------------------------------
// Envelope times. Hardware seconds are undocumented; SoS: slowest attack ~3s.
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
export function cutoffToHz(raw: number): number {
  return expMap(raw, 16, 21000)
}
export function resonanceTo01(raw: number): number {
  return Math.pow(clamp(raw, 0, 1023) / 1023, 1.1)
}
export const KEYTRACK_AMOUNT = [0, 0.5, 1] as const

/** xd filter voicing (fixed 2-pole + 3-position drive; spec §6-7). */
export const XD_FILTER_CFG: SvfCfg = {
  kMax: 2.0, // r = 0: critically damped, no resonant hump
  kMin: 0.025, // r = 1: Q = 40 — rings hard, just shy of self-oscillation
  resCurve: 1.4, // musical taper: resonance ramps in over the upper half
  driveGains: [1.0, 2.6, 6.0], // OFF / 50% / 100%
  driveMakeups: [1.0, 0.7, 0.45],
  satLevel: 1.25,
  bassComp: 0.15, // xd keeps its low end at high resonance
  resLoss: 0,
  poles: 2,
}

// ---------------------------------------------------------------------------
// LFO [MIDIimp note P11]
// ---------------------------------------------------------------------------
export function lfoRateToHz(raw: number): number {
  return expMap(raw, 0.05, 28)
}

/** BPM-sync divisions in 64-wide zones, values = whole-note fractions. */
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

/** LFO INT: stored 0..1023, 512 = 0; panel shows -511..+511. */
export function lfoIntTo01(raw: number): number {
  return clamp((clamp(raw, 0, 1023) - 512) / 511, -1, 1)
}

/** LFO INT scaling per target at full depth. UNCONFIRMED on hardware; musical choices. */
export const LFO_MAX_PITCH_CENTS = 1200
export const LFO_MAX_CUTOFF_OCTAVES = 7
export const LFO_MAX_SHAPE = 1

// ---------------------------------------------------------------------------
// Mixer / levels
// ---------------------------------------------------------------------------
export function levelTo01(raw: number): number {
  return Math.pow(clamp(raw, 0, 1023) / 1023, 1.2)
}

/** Program Level: stored 12..132 -> -18.0..+6.0 dB (0.2 dB steps), 102 = 0 dB. */
export function programLevelToDb(stored: number): number {
  return (clamp(stored, 12, 132) - 102) * 0.2
}

// ---------------------------------------------------------------------------
// Portamento: raw 0..127, 0 = off.
// ---------------------------------------------------------------------------
export function portamentoToSec(raw: number): number {
  if (raw <= 0) return 0
  return 0.003 * Math.pow(5000 / 3, clamp(raw, 0, 127) / 127) // ~3ms .. ~5s
}

// ---------------------------------------------------------------------------
// Voice-mode depth semantics [MIDIimp note P2, exact zone tables]
// ---------------------------------------------------------------------------

/** POLY: 0..255 plain poly; 256..1023 DUO with rising stack level+detune. */
export function polyDuo(raw: number): { duo: boolean; amount: number } {
  const r = clamp(raw, 0, 1023)
  if (r < 256) return { duo: false, amount: 0 }
  return { duo: true, amount: (r - 256) / 767 }
}

export function unisonDetuneCents(raw: number): number {
  return (clamp(raw, 0, 1023) / 1023) * 50
}

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
const ARP_HI = [78, 156, 234, 312, 390, 468, 546, 624, 702, 780, 858, 936, 1023]

export function arpTypeIndex(raw: number): number {
  const r = clamp(raw, 0, 1023)
  for (let i = 0; i < ARP_HI.length; i++) if (r <= ARP_HI[i]) return i
  return ARP_HI.length - 1
}

/** Arp Rate menu values [OM p.40], in beats (quarter note = 1 beat). */
export const ARP_RATES: ReadonlyArray<{ label: string; beats: number }> = [
  { label: '64th', beats: 4 / 64 },
  { label: '48th', beats: 4 / 48 },
  { label: '32th', beats: 4 / 32 },
  { label: '24th', beats: 4 / 24 },
  { label: '16th', beats: 4 / 16 },
  { label: '16.th', beats: (4 / 16) * 1.5 },
  { label: '12th', beats: 4 / 12 },
  { label: '8th', beats: 4 / 8 },
  { label: '8.th', beats: (4 / 8) * 1.5 },
  { label: '6th', beats: 4 / 6 },
  { label: '4th', beats: 1 },
]

// ---------------------------------------------------------------------------
// Micro tuning: family-shared data, hoisted to dsp/tuning.ts; re-exported so
// existing importers (engine, params labels, tests) keep working unchanged.
// ---------------------------------------------------------------------------
export { MICRO_TUNINGS, microTuneCents } from '../../dsp/tuning'

// ---------------------------------------------------------------------------
// Display formatting for xd-curve-based values (OLED-style)
// ---------------------------------------------------------------------------
export function fmtCents(raw: number): string {
  const c = Math.round(pitchToCents(raw))
  return (c > 0 ? '+' : '') + c + 'C'
}
export function fmtEgInt(raw: number): string {
  const p = egIntToPercent(raw)
  const r = Math.abs(p) < 10 ? p.toFixed(1) : p.toFixed(0)
  return (p > 0 ? '+' : '') + r + '%'
}
export function fmtLfoInt(raw: number): string {
  const v = Math.round(clamp(raw, 0, 1023)) - 512
  return (v > 0 ? '+' : '') + v
}
