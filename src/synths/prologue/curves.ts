/*
 * Korg prologue (2018) raw-value -> physical-unit curves, shared by the UI
 * (display) and the DSP (engine). Continuous panel knobs store hardware-style
 * raw values 0..1023. Piecewise tables reproduce the official prologue MIDI
 * Implementation Revision 1.01 (docs/prologue-spec.md; local copy in
 * docs/hardware/prologue_MIDIImp.txt), with the errata resolutions from
 * prologue-spec.md §16 applied. Provenance per docs/hardware-calibration.md:
 * DOCUMENTED(source) = straight from the docs, UNCONFIRMED = best-effort
 * inference and a calibration target (prologue hardware is not owned; see
 * prologue-spec.md §17).
 *
 * Deliberately imports nothing from the other synth definitions — shared
 * shapes are transcribed, not linked, so per-synth calibration never crosses
 * definitions.
 */
import { clamp, lerp, expMap } from '../../shared/maps'
import type { SvfCfg } from '../../dsp/filter'

// Family microtuning presets (the prologue ships the same menu; spec §12 —
// hardware stores 0..139 incl. user scales/octaves, we ship the preset
// subset like the other definitions).
export { MICRO_TUNINGS, microTuneCents } from '../../dsp/tuning'

// ---------------------------------------------------------------------------
// VCO PITCH knob: raw 0..1023 -> cents -1200..+1200
// DOCUMENTED(MIDIimp note P16, exact — the family piecewise table).
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
// PITCH EG INT knob: raw 0..1023 -> cents -4800..+4800 (the EG -> pitch depth
// behind the PITCH EG TARGET switch).
// DOCUMENTED(MIDIimp note P17, exact — unlike the OG's doc, the prologue's
// prints the corrected positive rows 1024..4800).
// ---------------------------------------------------------------------------
const PITCH_EG_SEGS: Array<[number, number, number, number]> = [
  [0, 4, -4800, -4800],
  [4, 356, -4800, -1024],
  [356, 476, -1024, -64],
  [476, 492, -64, 0],
  [492, 532, 0, 0],
  [532, 548, 0, 64],
  [548, 668, 64, 1024],
  [668, 1020, 1024, 4800],
  [1020, 1023, 4800, 4800],
]

export function pitchEgIntToCents(raw: number): number {
  const r = clamp(raw, 0, 1023)
  for (const [rl, rh, cl, ch] of PITCH_EG_SEGS) {
    if (r <= rh) return rh === rl ? cl : lerp(cl, ch, (r - rl) / (rh - rl))
  }
  return 4800
}

// ---------------------------------------------------------------------------
// CUTOFF EG INT: raw 0..1023 -> percent -100..+100
// DOCUMENTED(MIDIimp note P20, exact formula — the family quadratic).
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
// Envelope times. UNCONFIRMED for the prologue: hardware seconds are
// undocumented; transcribed from the family replica curves (same digital-EG
// lineage; attack max ~3 s per [SoS], spec §5).
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
/** UNCONFIRMED: cutoff span unpublished; family exp taper (~16 Hz–21 kHz). */
export function cutoffToHz(raw: number): number {
  return expMap(raw, 16, 21000)
}
/** UNCONFIRMED: resonance taper transcribed from the xd replica. */
export function resonanceTo01(raw: number): number {
  return Math.pow(clamp(raw, 0, 1023) / 1023, 1.1)
}
/** DRIVE / KEYTRACK 3-position zones [0/50/100%] (MIDIimp note P21). */
export const KEYTRACK_AMOUNT = [0, 0.5, 1] as const

/**
 * prologue filter voicing (prologue-spec.md §15): 2-pole VCF, xd-adjacent but
 * "smoother/warmer ... less aggressive" [KVR/SoS], so resonance ramps in
 * later and gentler than the xd's.
 *   DOCUMENTED: 2-pole, 3-position drive, LOW CUT switch (spec §3).
 *   UNCONFIRMED (calibration targets, spec §17): resCurve 1.25 — gentler
 *   taper than the xd's 1.4 (higher resCurve = resonance arrives earlier);
 *   everything else transcribed from the xd voicing, including the DRIVE
 *   stage gains/makeups (spec §17 "DRIVE stage gains").
 */
export const PROLOGUE_FILTER_CFG: SvfCfg = {
  kMax: 2.0, // r = 0: critically damped, no resonant hump
  kMin: 0.025, // UNCONFIRMED: xd value (Q = 40 at r = 1, shy of self-oscillation)
  resCurve: 1.25, // UNCONFIRMED: gentler than the xd's 1.4 ("less aggressive")
  driveGains: [1.0, 2.6, 6.0], // UNCONFIRMED: xd values reused (OFF / 50% / 100%)
  driveMakeups: [1.0, 0.7, 0.45], // UNCONFIRMED: xd values reused
  satLevel: 1.25, // UNCONFIRMED: xd value
  bassComp: 0.15, // UNCONFIRMED: xd value ("mellow darkness" keeps its low end)
  resLoss: 0,
  poles: 2,
}

/** LOW CUT (gentle non-resonant HPF, spec §3) corner frequency.
 *  UNCONFIRMED: ~120 Hz is a musical guess (spec §17); the voice's HPF uses
 *  this constant so calibration is a one-line change. */
export const LOW_CUT_HZ = 120

// ---------------------------------------------------------------------------
// LFO (spec §8): MODE picks the rate range. Program-data mode order is
// 0=BPM, 1=SLOW, 2=FAST (timbre byte +71) — no 1-shot on the prologue.
// ---------------------------------------------------------------------------
/** SLOW: 0.05–28 Hz. DOCUMENTED endpoints [OM/spec §8]; exponential shape
 *  UNCONFIRMED (assumed per family). */
export function lfoSlowHz(raw: number): number {
  return expMap(raw, 0.05, 28)
}
/** FAST: 0.5 Hz – 2.8 kHz, true audio rate. DOCUMENTED endpoints [OM/spec
 *  §8]; exponential shape UNCONFIRMED. */
export function lfoFastHz(raw: number): number {
  return expMap(raw, 0.5, 2800)
}

/** BPM-sync divisions in 64-wide zones, values = whole-note fractions.
 *  DOCUMENTED(MIDIimp note P22 — the family 16-zone table). */
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

/** RATE in Hz for a mode (param enum: 0=BPM, 1=SLOW, 2=FAST). */
export function lfoRateToHz(raw: number, mode: number, bpm: number): number {
  if (mode <= 0) return lfoBpmToHz(raw, bpm)
  return mode >= 2 ? lfoFastHz(raw) : lfoSlowHz(raw)
}

/** LFO INT: stored 0..1023, bipolar around center 512 — panel INT 0..511
 *  with SHIFT = invert (spec §8; xd-style encoding). */
export function lfoIntTo01(raw: number): number {
  return clamp((clamp(raw, 0, 1023) - 512) / 511, -1, 1)
}

/** LFO INT scaling per target at full depth. UNCONFIRMED (family values). */
export const LFO_MAX_PITCH_CENTS = 1200
export const LFO_MAX_CUTOFF_OCTAVES = 7
export const LFO_MAX_SHAPE = 1

// ---------------------------------------------------------------------------
// Mixer / levels
// ---------------------------------------------------------------------------
/** UNCONFIRMED taper (transcribed from the family replicas). */
export function levelTo01(raw: number): number {
  return Math.pow(clamp(raw, 0, 1023) / 1023, 1.2)
}

/** Program Level: stored 12..132 -> -18.0..+6.0 dB (0.2 dB steps), 102 = 0 dB.
 *  DOCUMENTED(MIDIimp byte 40 — same encoding as the xd). */
export function programLevelToDb(stored: number): number {
  return (clamp(stored, 12, 132) - 102) * 0.2
}

// ---------------------------------------------------------------------------
// Portamento: raw 0..127, 0 = off (per-timbre byte +0; panel [Off, 0..127]).
// UNCONFIRMED curve: family exponential (~3 ms .. ~5 s).
// ---------------------------------------------------------------------------
export function portamentoToSec(raw: number): number {
  if (raw <= 0) return 0
  return 0.003 * Math.pow(5000 / 3, clamp(raw, 0, 127) / 127)
}

// ---------------------------------------------------------------------------
// Voice-mode depth semantics (per timbre; MIDIimp note P13, exact zones)
// ---------------------------------------------------------------------------

/** POLY: 0..255 plain poly; 256..1023 DUO with rising stack level+detune.
 *  DOCUMENTED zones (note P13); the stacked level/detune curves inside the
 *  DUO span are UNCONFIRMED (spec §17). */
export function polyDuo(raw: number): { duo: boolean; amount: number } {
  const r = clamp(raw, 0, 1023)
  if (r < 256) return { duo: false, amount: 0 }
  return { duo: true, amount: (r - 256) / 767 }
}

/** UNISON: detune across ALL of the timbre's voices, 0..50 cents linear.
 *  DOCUMENTED endpoints (note P13). */
export function unisonDetuneCents(raw: number): number {
  return (clamp(raw, 0, 1023) / 1023) * 50
}

/**
 * MONO: sub-oscillator mix (the OG MONO model, spec §4). Depth first brings
 * in voices at -1 octave (sub1), further right adds -2 octaves (sub2).
 * UNCONFIRMED placeholder crossfade (spec §17 "MONO sub crossfade"): sub1
 * ramps 0..1 over the lower half, sub2 ramps 0..1 over the upper half.
 */
export function monoSubMix(raw: number): { sub1: number; sub2: number } {
  const r = clamp(raw, 0, 1023) / 1023
  return {
    sub1: Math.min(1, r * 2),
    sub2: Math.max(0, r * 2 - 1),
  }
}

/** CHORD zone table — DOCUMENTED(MIDIimp note P13; the family 14 chords). */
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

// ---------------------------------------------------------------------------
// VOICE SPREAD: per-timbre 0..127 pans voices statically across the stereo
// field (spec §13). UNCONFIRMED pan law (spec §17): symmetric linear spread —
// voice 0 leans hardest left, the last voice hardest right, scaled by the
// spread amount. With round-robin allocation successive notes walk across
// the field, which matches how voice-spread synths are described.
// ---------------------------------------------------------------------------
export function voiceSpreadPan(spread01: number, voiceIndex: number, numVoices: number): number {
  if (numVoices <= 1) return 0
  const s = clamp(spread01, 0, 1)
  const i = clamp(voiceIndex, 0, numVoices - 1)
  return s * ((2 * i) / (numVoices - 1) - 1)
}

// ---------------------------------------------------------------------------
// Arpeggiator (program-global; spec §10)
// ---------------------------------------------------------------------------
/** Six types — DOCUMENTED(MIDIimp note P12). The stored byte 75 spans 0..15
 *  (raw), its mapping onto the six names is UNCONFIRMED (spec §17); our param
 *  stores the semantic 0..5 directly. POLY RANDOM = 2 random notes at once. */
export const ARP_TYPES = ['MANUAL', 'RISE', 'FALL', 'RISE FALL', 'RANDOM', 'POLY RANDOM'] as const

/** Arp Rate menu values (MIDIimp note P9, 11 entries), in beats (quarter
 *  note = 1 beat). NOTE spec §16.4: the doc's range column says 1~12, note P9
 *  lists 11 values and the manual 10 (omits 32th) — we ship the P9 list; the
 *  '16.th' label spelling follows the family UI (the doc prints '16.t'). */
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

/** RANGE 1..4 octaves — DOCUMENTED span [OM]; the stored byte 74 spans 0..15
 *  (raw) with an UNCONFIRMED mapping (spec §10/§17); our param stores 1..4. */
export const ARP_RANGE_MIN = 1
export const ARP_RANGE_MAX = 4

// ---------------------------------------------------------------------------
// Effects (program-global; spec §7) — subtype label lists. DOCUMENTED
// (MIDIimp notes P2-P6, P10, P11; identical internal lists to the xd).
// USER slots: the replica ships the xd's two built-in user mod FX; delay/
// reverb USER1-8 slots are out of scope (implementation-notes.md).
// ---------------------------------------------------------------------------
export const MODFX_TYPES = ['CHORUS', 'ENSEMBLE', 'PHASER', 'FLANGER', 'USER'] as const
export const CHORUS_SUBS = ['Stereo', 'Light', 'Deep', 'Triphase', 'Harmonic', 'Mono', 'Feedback', 'Vibrato'] as const
export const ENSEMBLE_SUBS = ['Stereo', 'Light', 'Mono'] as const
export const PHASER_SUBS = ['Stereo', 'Fast', 'Orange', 'Small', 'Small Reso', 'Black', 'Formant', 'Twinkle'] as const
export const FLANGER_SUBS = ['Stereo', 'Light', 'Mono', 'High Sweep', 'Mid Sweep', 'Pan Sweep', 'Mono Sweep', 'Triphase'] as const
export const USER_MODFX_SUBS = ['Rotary', 'Trem'] as const

/** DELAY: 12 internal types (MIDIimp note P11; + USER1-8, out of scope). */
export const DELAY_SUBS = [
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

/** REVERB: 10 internal types (MIDIimp note P10; + USER1-8, out of scope). */
export const REVERB_SUBS = [
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

// ---------------------------------------------------------------------------
// SPLIT POINT: stored 0..127 = C-1..G9 (program byte 23) — plain MIDI note
// numbers in Korg's C-1-based octave naming.
// ---------------------------------------------------------------------------
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

/** MIDI note -> Korg display name (0 = C-1, 60 = C4, 127 = G9). */
export function noteName(midi: number): string {
  const n = clamp(Math.round(midi), 0, 127)
  return NOTE_NAMES[n % 12] + String(Math.floor(n / 12) - 1)
}

// ---------------------------------------------------------------------------
// M.WHEEL / aftertouch assign destinations — DOCUMENTED(MIDIimp note P23,
// exact 32-entry order; per-timbre assign, spec §9). The dest-index ->
// param-id resolver (wheelDestParam) lives in ./params.ts: it needs the id
// tables, and params.ts imports this module — mapping ids here would create
// a params <-> curves cycle (family precedent: og/mono sliderDestParam).
// ---------------------------------------------------------------------------
export const WHEEL_ASSIGN_DESTS = [
  'BALANCE',
  'PORTAMENTO',
  'V.SPREAD',
  'V.M DEPTH',
  'VCO1 PITCH',
  'VCO1 SHAPE',
  'VCO2 PITCH',
  'VCO2 SHAPE',
  'CROSS MOD',
  'PITCH EG INT',
  'MULTI SHAPE',
  'VCO1 LEVEL',
  'VCO2 LEVEL',
  'MULTI LEVEL',
  'CUTOFF',
  'RESONANCE',
  'CUTOFF EG INT',
  'A.EG ATTACK',
  'A.EG DECAY',
  'A.EG SUSTAIN',
  'A.EG RELEASE',
  'EG ATTACK',
  'EG DECAY',
  'EG SUSTAIN',
  'EG RELEASE',
  'LFO RATE',
  'LFO INT',
  'MOD FX SPEED',
  'MOD FX DEPTH',
  'DL/RV TIME',
  'DL/RV DEPTH',
  'GATE TIME',
] as const

// ---------------------------------------------------------------------------
// Display formatting for prologue-curve-based values (OLED-style)
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
/** Center-512 bipolar store displays -512..+511 with a sign (spec §8). */
export function fmtLfoInt(raw: number): string {
  const v = Math.round(clamp(raw, 0, 1023)) - 512
  return (v > 0 ? '+' : '') + v
}
