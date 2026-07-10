/*
 * Versioned calibration profiles for the minilogue xd replica.
 *
 * A profile freezes every tunable that was originally guessed (UNCONFIRMED in
 * docs/xd-spec.md): v0 is the pre-calibration snapshot, and each reviewed
 * hardware-calibration round lands as a NEW profile instead of overwriting
 * curves.ts — so any version can be A/B'd from the settings drawer at any
 * time. curves.ts, voice.ts and the SQR pulse-width law all read the ACTIVE
 * profile; the default stays v0 until a measured profile is promoted after
 * review (docs/hardware-calibration.md 'Review gate').
 *
 * The active profile is per JS realm: the UI thread and the AudioWorklet each
 * hold their own module instance, and both are switched on a change (app.ts
 * persists the choice and sends {t:'calibProfile'}; Engine.setCalibProfile
 * re-applies all params so cached physical values re-derive).
 *
 * Not yet in the schema (join when their domains are measured): filter
 * voicing XD_FILTER_CFG (protocol D4), drift constants in src/dsp/drift.ts
 * (D8 — constructed per voice, needs its own injection path), portamento.
 */
import { clamp, lerp, expMap } from '../../shared/maps'
import { monotoneCubic } from '../../shared/monotone'

/** A raw(0..1023) -> physical-value curve, in one of the fitted families. */
export type CurveSpec =
  | { kind: 'expMap'; lo: number; hi: number }
  /** PCHIP through [raw, value] knots (linear domain, e.g. cents). */
  | { kind: 'pchip'; knots: ReadonlyArray<readonly [number, number]> }
  /** PCHIP in ln(value) through [raw, value] knots — for positive units
   *  spanning decades (seconds, Hz); matches the calib fits' log-PCHIP. */
  | { kind: 'logPchip'; knots: ReadonlyArray<readonly [number, number]> }
  /** Piecewise-linear [rawLo, rawHi, valueLo, valueHi] segments. */
  | { kind: 'segments'; segs: ReadonlyArray<readonly [number, number, number, number]> }

const compiled = new WeakMap<CurveSpec, (raw: number) => number>()

function compile(spec: CurveSpec): (raw: number) => number {
  switch (spec.kind) {
    case 'expMap':
      return (raw) => expMap(raw, spec.lo, spec.hi)
    case 'pchip': {
      const at = monotoneCubic(
        spec.knots.map((k) => k[0]),
        spec.knots.map((k) => k[1]),
      )
      return (raw) => at(raw)
    }
    case 'logPchip': {
      const at = monotoneCubic(
        spec.knots.map((k) => k[0]),
        spec.knots.map((k) => Math.log(k[1])),
      )
      return (raw) => Math.exp(at(raw))
    }
    case 'segments':
      return (raw) => {
        const r = clamp(raw, 0, 1023)
        for (const [rl, rh, vl, vh] of spec.segs) {
          if (r <= rh) return rh === rl ? vl : lerp(vl, vh, (r - rl) / (rh - rl))
        }
        return spec.segs[spec.segs.length - 1][3]
      }
  }
}

export function curveAt(spec: CurveSpec, raw: number): number {
  let f = compiled.get(spec)
  if (!f) {
    f = compile(spec)
    compiled.set(spec, f)
  }
  return f(raw)
}

/**
 * VCO PITCH knob raw -> cents from the official MIDI implementation (note P5).
 * The DISPLAY always uses this table (the hardware OLED shows these numbers);
 * profiles carry what the analog pitch actually does (measured ~0.39x
 * shallower mid-range, 2026-07-08 finding).
 */
export const DOCUMENTED_PITCH_SEGS: ReadonlyArray<readonly [number, number, number, number]> = [
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

export interface XdCalibProfile {
  id: string
  name: string
  /** ISO date the values were established. */
  date: string
  notes?: string
  /** VCO PITCH knob -> cents as the ENGINE plays it (display stays documented). */
  vcoPitchCents: CurveSpec
  egAttackSec: CurveSpec
  egDecaySec: CurveSpec
  egReleaseSec: CurveSpec
  cutoffHz: CurveSpec
  /** SQR minimum pulse width at SHAPE max (0..0.5). Hardware reaches 0 = silence. */
  sqrPwMin: number
  /** EG INT -> pitch depth at 100%, cents. */
  egMaxPitchCents: number
  /** EG INT -> cutoff depth at 100%, octaves. */
  egMaxCutoffOctaves: number
  lfoRateHz: CurveSpec
  lfoMaxPitchCents: number
  lfoMaxCutoffOctaves: number
  lfoMaxShape: number
}

/** v0 — the original guessed values, frozen exactly as first shipped. */
const V0: XdCalibProfile = {
  id: 'v0',
  name: 'v0 · original guesses',
  date: '2026-07-02',
  notes: 'Pre-calibration values as first shipped; UNCONFIRMED guesses in docs/xd-spec.md.',
  vcoPitchCents: { kind: 'segments', segs: DOCUMENTED_PITCH_SEGS },
  egAttackSec: { kind: 'expMap', lo: 0.0006, hi: 3.0 },
  egDecaySec: { kind: 'expMap', lo: 0.002, hi: 12.0 },
  egReleaseSec: { kind: 'expMap', lo: 0.002, hi: 15.0 },
  cutoffHz: { kind: 'expMap', lo: 16, hi: 21000 },
  sqrPwMin: 0.05,
  egMaxPitchCents: 4800,
  egMaxCutoffOctaves: 10,
  lfoRateHz: { kind: 'expMap', lo: 0.05, hi: 28 },
  lfoMaxPitchCents: 1200,
  lfoMaxCutoffOctaves: 7,
  lfoMaxShape: 1,
}

/*
 * v1 — hardware-measured on Matt's minilogue xd, capture generation 2
 * (CoreAudio helper), sessions of 2026-07-10 in calib/sessions/. Tables use
 * ALL measured points (including the fits' held-out points — those exist to
 * validate the curve family, not to be discarded from the final table).
 * Unmeasured fields inherit v0. Sources:
 *   cutoffHz       2026-07-10T05-03-cutoff-sweep  (expMap fit, held-out 13.1%)
 *   egAttackSec    2026-07-10T05-05-eg-attack     (log-PCHIP, held-out 0.8%)
 *   egDecaySec     2026-07-10T05-43-eg-decay      (log-PCHIP, held-out 13.5%)
 *   egReleaseSec   2026-07-10T05-39-eg-release    (log-PCHIP, held-out 13.1%)
 *   vcoPitchCents  2026-07-10T05-09-vco1-pitch-knob (each point ±0.1-0.4 cents)
 *   sqrPwMin       SQR-silence-at-SHAPE-max finding, 2026-07-08 (confirmed 4x)
 * The pitch table is recentered by -2.80 cents (the unit's tuning state at
 * measurement: the 492-532 dead zone read +2.87/+2.81/+2.73) so the center
 * detent is exactly 0; the three dead-zone knots are pooled to 0.
 */
const V1: XdCalibProfile = {
  ...V0,
  id: 'v1',
  name: 'v1 · measured 2026-07-10',
  date: '2026-07-10',
  notes: 'First hardware round: VCO pitch law, EG time tables, cutoff span, SQR PW endpoint.',
  vcoPitchCents: {
    kind: 'pchip',
    knots: [
      [0, -1201.02],
      [4, -1201.02],
      [100, -899.99],
      [256, -413.65],
      [356, -98.91],
      [400, -66.37],
      [476, -7.58],
      [492, 0],
      [512, 0],
      [532, 0],
      [548, 5.09],
      [668, 99.67],
      [800, 509.46],
      [1020, 1198.02],
      [1023, 1198.0],
    ],
  },
  egAttackSec: {
    kind: 'logPchip',
    knots: [
      [0, 0.0042356],
      [85, 0.018059],
      [171, 0.067554],
      [256, 0.1482],
      [341, 0.26066],
      [426, 0.40851],
      [512, 0.58858],
      [597, 0.79486],
      [682, 1.0501],
      [767, 1.3245],
      [853, 1.6344],
      [938, 1.9763],
      [1023, 2.3418],
    ],
  },
  egDecaySec: {
    kind: 'logPchip',
    knots: [
      [0, 0.0029728],
      [85, 0.015764],
      [171, 0.076724],
      [256, 0.17966],
      [341, 0.33258],
      [426, 0.52851],
      [512, 0.76237],
      [597, 1.0341],
      [682, 1.3488],
      [767, 1.7009],
      [853, 2.1258],
      [896, 2.3216],
      [938, 4.7104],
      [980, 8.6852],
      [1023, 16.68],
    ],
  },
  egReleaseSec: {
    kind: 'logPchip',
    knots: [
      [0, 0.0041341],
      [85, 0.017059],
      [171, 0.080339],
      [256, 0.18696],
      [341, 0.32818],
      [426, 0.52334],
      [512, 0.74954],
      [597, 1.0318],
      [682, 1.3485],
      [767, 1.7066],
      [853, 2.1172],
      [896, 2.3351],
      [938, 4.7078],
      [980, 8.6006],
      [1023, 16.597],
    ],
  },
  cutoffHz: { kind: 'expMap', lo: 24.7, hi: 16900 },
  sqrPwMin: 0,
}

export const XD_PROFILES: readonly XdCalibProfile[] = [V0, V1]

/** The shipped default. Promoting a measured profile is a reviewed change. */
export const XD_DEFAULT_PROFILE = 'v0'

let active: XdCalibProfile = V0

export function activeXdProfile(): XdCalibProfile {
  return active
}

/** Switch this realm's active profile; returns false for an unknown id. */
export function setXdProfile(id: string): boolean {
  const p = XD_PROFILES.find((p) => p.id === id)
  if (!p) return false
  active = p
  return true
}
