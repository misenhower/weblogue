/*
 * Versioned calibration profiles for the minilogue xd replica.
 *
 * A profile freezes every tunable that was originally guessed (UNCONFIRMED in
 * docs/xd-spec.md): v0 is the pre-calibration snapshot, and each reviewed
 * hardware-calibration round lands as a NEW profile instead of overwriting
 * curves.ts — so any version can be A/B'd from the settings drawer at any
 * time. Each engine owns an explicit profile selection; the UI realm keeps a
 * separate selection for display curves. The shipped default advances only
 * after measurement and listening review (docs/hardware-calibration.md
 * 'Review gate').
 *
 * app.ts persists the choice and sends {t:'calibProfile'};
 * Engine.setCalibProfile changes only that engine and re-applies all params
 * so cached physical values re-derive.
 *
 * Two profiles ship: v0 (the pre-calibration guesses, kept for A/B and as
 * the lineage base) and v1 (the R1 re-baseline, DEFAULT since Matt's
 * listening review 2026-07-13). The transitional dev-era rounds v1-v4 —
 * measured while the rig, extractor and models were themselves moving
 * targets — were dropped the same day per the plan of record; git history
 * before commit 'xd V1: promote to default' keeps them.
 *
 * Filter voicing, drift constants, and portamento range are already schema
 * fields, ready for D4/D8/portamento evidence without new injection paths.
 */
import { clamp, lerp, expMap } from '../../shared/maps'
import { monotoneCubic } from '../../shared/monotone'
import type { SvfCfg } from '../../dsp/filter'
import { DEFAULT_DRIFT_CONFIG, type DriftConfig } from '../../dsp/drift'

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
  /** Measurement-method revision (tools/calib/lib/procedure.ts). v0
   *  predates procedure numbering and carries no tag; a profile measured
   *  under a numbered procedure declares it, which arms the lineage gate. */
  procedure?: { id: 'xd-hardware-calibration'; revision: number }
  /** Provenance for procedure-declaring profiles: the profile it builds on
   * and the accepted result that authorizes every changed emulation field. */
  lineage?: {
    baseProfile: string
    evidence: Partial<Record<XdCalibrationField, string>>
  }
  /** VCO PITCH knob -> cents as the ENGINE plays it (display stays documented). */
  vcoPitchCents: CurveSpec
  egAttackSec: CurveSpec
  egDecaySec: CurveSpec
  egReleaseSec: CurveSpec
  /**
   * EG fall-segment curve (D5, measured 2026-07-12): the xd runs decay/
   * release as a CONSTANT-RATE LINEAR phase raised to this power (measured
   * p = 3.00 across the knob range, 0.2 dB RMS), reaching true zero at the
   * table time. ABSENT = the legacy one-pole exponential with tables meaning
   * 3*tau "displayed time" (v0). When present, egDecaySec/egReleaseSec
   * are TIME-TO-ZERO seconds. Applied to the mod EG too (INFERRED: same
   * firmware generator; only the amp EG was measured).
   */
  egFallPower?: number
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
  /** Filter, drift, and glide are included now so future D4/D8/portamento
   * measurements can enter the same versioned provenance gate. */
  filterConfig: SvfCfg
  driftConfig: DriftConfig
  portamentoMaxSec: number
  /*
   * VCO SHAPE morph models, measured 2026-07-11 (D2; findings log + evidence
   * artifact). ALL OPTIONAL: absent = the original guessed morphs, so v0
   * and the other synths stay bit-identical. Injected into the shared Vco by
   * voice.ts (same pattern as sqrPwMin).
   */
  /** SQR: raw -> pulse duty (constant-swing pulse, real DC, no peak
   *  normalization). Presence switches the SQR path to the measured model. */
  sqrDuty?: CurveSpec
  /** TRI: raw -> single-fold drive g' (1 = no fold, 3 = exact x3 triple). */
  triFoldDrive?: CurveSpec
  /** TRI: raw -> output level at the fold ceiling (1 at raw 0). */
  triFoldLevel?: CurveSpec
  /** TRI: soft-fold knee radius (0 = hard reflection). */
  triFoldKnee?: number
  /** SAW: raw -> reversal-mirror half-width w (0 = plain saw; 0.5 = full
   *  alternate-tooth time-mirror = the measured octave-down morph). Over the
   *  doubled period the wave is saw(phi) except saw(2-phi) inside
   *  (1-w, 1+w) — a time-mirror window centered on the alternate tooth
   *  boundary (D2 dense-sweep finding, 2026-07-11). */
  sawMirrorW?: CurveSpec
}

/** Fields whose values affect the emulation and therefore need accepted
 * evidence when a procedure-declaring profile changes them. Metadata is
 * excluded. */
export const XD_CALIBRATION_FIELDS = [
  'vcoPitchCents',
  'egAttackSec',
  'egDecaySec',
  'egReleaseSec',
  'egFallPower',
  'cutoffHz',
  'sqrPwMin',
  'egMaxPitchCents',
  'egMaxCutoffOctaves',
  'lfoRateHz',
  'lfoMaxPitchCents',
  'lfoMaxCutoffOctaves',
  'lfoMaxShape',
  'filterConfig',
  'driftConfig',
  'portamentoMaxSec',
  'sqrDuty',
  'triFoldDrive',
  'triFoldLevel',
  'triFoldKnee',
  'sawMirrorW',
] as const satisfies readonly (keyof XdCalibProfile)[]

export type XdCalibrationField = (typeof XD_CALIBRATION_FIELDS)[number]

/** Structural field diff used by the provenance gate. Profile values are
 * JSON data, so stable JSON equality is the appropriate comparison here. */
export function profileChangedFields(
  base: XdCalibProfile,
  candidate: XdCalibProfile,
): XdCalibrationField[] {
  return XD_CALIBRATION_FIELDS.filter(
    (field) => JSON.stringify(base[field]) !== JSON.stringify(candidate[field]),
  )
}

/** v0 — the original guessed values, frozen exactly as first shipped. */
export const XD_DEFAULT_FILTER_CONFIG: SvfCfg = {
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
  filterConfig: XD_DEFAULT_FILTER_CONFIG,
  driftConfig: DEFAULT_DRIFT_CONFIG,
  portamentoMaxSec: 5,
}

/*
 * v1 — the first R1-procedure profile: full re-baseline measured on
 * xd-unit-1, sessions of 2026-07-13 (capture gen-2 at 48 kHz; --profile v0
 * baseline renders). Values are the sessions' final proposal tables
 * verbatim, except the four documented decisions:
 *   - vcoPitchCents recentered -2.003¢ so the 492–532 dead zone is
 *     exactly 0 (the unit's tuning state that night; detent-means-zero
 *     policy, Matt 2026-07-11) and the documented-flat end pairs pooled.
 *   - cutoffHz raw-1023 knot EXTRAPOLATED log-linearly through the last
 *     three measured knots: the max-raw point is the PSD-transfer reference
 *     (unmeasurable by construction) and both engine layers clamp fc, so
 *     the top knot just means "wide open". raw 960 was unusable in two
 *     independent captures; the raw-0 knot is LF-degenerate (the method
 *     cannot tell 15 from 25 Hz down there — either is fully closed).
 *   - sqrDuty [1023, 0] pinned by the SILENT capture (duty reaches true
 *     zero — the 2026-07-08 silence finding, reproduced twice at onset
 *     level; the quiet WAV is the evidence).
 *   - sawMirrorW [1023, 0.5] pinned by the measured EXACT half-wave
 *     antisymmetry (1.4% residual in this session's own SHAPE-max cycle;
 *     the w fit is degenerate near saturation).
 * egFallPower 3 (D5): fall segments are a constant-rate linear phase CUBED
 * reaching true zero at the table time — egDecaySec/egReleaseSec are
 * TIME-TO-ZERO seconds, not the legacy 3·tau convention. Free-fitted
 * exponent 2.85–3.01 across the whole range; decay and release T agree
 * within ~2% at every knob (one firmware generator). INFERRED: the mod EG
 * shares the law (only the amp EG was measured); sustain>0 decay tracks at
 * constant phase rate (only sustain 0 was measured).
 * Unmeasured domains inherit v0 (filter voicing, drift, portamento, mod
 * depths, LFO rate/depths) — future procedure revisions add them.
 *
 * KNOWN GAP (Matt's call, 2026-07-13): the TRI fold fields ship MEASURED but
 * UNACCEPTED — verification at the second octave (A3/220 Hz) improved every
 * point 2-10x over v0 yet missed the 1.5 dB bar (median 5.6 dB), because the
 * hardware triangle's harmonic content is itself frequency-dependent: the
 * analog core's corners round with frequency (hw H3 at 220 Hz reads -24.3 dB
 * vs an ideal triangle's -19.1; SAW/SQR verified frequency-invariant at the
 * same octave). A frequency-aware TRI core model is future work; until it
 * lands, validate-profile reports the three triFold* fields as the one
 * missing acceptance.
 */
const V1: XdCalibProfile = {
  ...V0,
  id: 'v1',
  name: 'v1 · R1 calibration 2026-07-13',
  date: '2026-07-13',
  procedure: { id: 'xd-hardware-calibration', revision: 1 },
  lineage: {
    baseProfile: 'v0',
    evidence: {
      vcoPitchCents: 'calib/results/v1/vco1-pitch-knob.json',
      egAttackSec: 'calib/results/v1/eg-attack.json',
      egDecaySec: 'calib/results/v1/eg-decay.json',
      egReleaseSec: 'calib/results/v1/eg-release.json',
      egFallPower: 'calib/results/v1/eg-release.json',
      cutoffHz: 'calib/results/v1/cutoff-sweep.json',
      sqrDuty: 'calib/results/v1/shape-sqr.json',
      triFoldDrive: 'calib/results/v1/shape-tri.json',
      triFoldLevel: 'calib/results/v1/shape-tri.json',
      triFoldKnee: 'calib/results/v1/shape-tri.json',
      sawMirrorW: 'calib/results/v1/shape-saw-dense.json',
    },
  },
  notes:
    'R1 re-baseline — the first procedure-produced profile: pitch law, EG T-times with the ' +
    'cubic fall, cutoff table, and all three SHAPE models measured in one night; unmeasured ' +
    'domains inherit the v0 guesses.',
  vcoPitchCents: {
    kind: 'pchip',
    knots: [
      [0, -1200.402],
      [4, -1200.402],
      [32, -1111.874],
      [64, -1012.582],
      [96, -912.4972],
      [100, -899.676],
      [128, -813.6353],
      [160, -712.2932],
      [192, -613.3645],
      [224, -513.3519],
      [256, -412.9141],
      [288, -313.2475],
      [320, -212.1114],
      [352, -112.4514],
      [356, -99.68166],
      [384, -79.27457],
      [400, -66.54445],
      [416, -53.65916],
      [448, -28.15413],
      [476, -6.452619],
      [480, -5.166128],
      [492, 0],
      [512, 0],
      [532, 0],
      [544, 3.948996],
      [548, 5.187605],
      [576, 26.72139],
      [608, 52.299],
      [640, 77.71545],
      [668, 100.6381],
      [672, 111.0207],
      [704, 212.1042],
      [736, 311.5013],
      [768, 410.9815],
      [800, 510.2446],
      [832, 610.9177],
      [864, 709.9708],
      [896, 811.5541],
      [928, 909.9599],
      [960, 1010.722],
      [992, 1110.462],
      [1020, 1199.842],
      [1023, 1199.842],
    ],
  },
  egAttackSec: {
    kind: 'logPchip',
    knots: [
      [0, 0.0037537],
      [85, 0.017925],
      [171, 0.067246],
      [256, 0.14813],
      [341, 0.26055],
      [426, 0.40581],
      [512, 0.58563],
      [597, 0.79193],
      [682, 1.0355],
      [767, 1.3162],
      [853, 1.629],
      [938, 1.962],
      [1023, 2.3355],
    ],
  },
  egDecaySec: {
    kind: 'logPchip',
    knots: [
      [0, 0.0062094],
      [85, 0.040949],
      [171, 0.15351],
      [256, 0.33931],
      [341, 0.60056],
      [426, 0.93263],
      [512, 1.3493],
      [597, 1.8548],
      [682, 2.4185],
      [767, 3.0602],
      [853, 3.7891],
      [896, 4.176],
      [938, 8.4415],
      [980, 14.19],
      [1023, 21.612],
    ],
  },
  egReleaseSec: {
    kind: 'logPchip',
    knots: [
      [0, 0.0074267],
      [85, 0.042817],
      [171, 0.15599],
      [256, 0.35006],
      [341, 0.60359],
      [426, 0.93853],
      [512, 1.3534],
      [597, 1.8616],
      [682, 2.4265],
      [767, 3.0289],
      [853, 3.7452],
      [896, 4.1831],
      [938, 8.4503],
      [980, 14.025],
      [1023, 21.371],
    ],
  },
  egFallPower: 3,
  cutoffHz: {
    kind: 'logPchip',
    knots: [
      [0, 15.5376],
      [64, 25.6917],
      [128, 41.3292],
      [192, 69.8935],
      [256, 107.903],
      [320, 172.133],
      [384, 273.793],
      [448, 416.443],
      [512, 636.306],
      [576, 1022.45],
      [640, 1557.34],
      [704, 2481.62],
      [768, 3872.15],
      [832, 6189.65],
      [896, 9474.91],
      [1023, 23189.8],
    ],
  },
  sqrDuty: {
    kind: 'pchip',
    knots: [
      [0, 0.505],
      [128, 0.4425],
      [256, 0.385],
      [384, 0.325],
      [512, 0.2675],
      [640, 0.205],
      [768, 0.145],
      [896, 0.085],
      [1023, 0],
    ],
  },
  triFoldDrive: {
    kind: 'pchip',
    knots: [
      [0, 1.01],
      [64, 1.04],
      [128, 1.07],
      [192, 1.11],
      [256, 1.18],
      [320, 1.25],
      [384, 1.34],
      [448, 1.43],
      [512, 1.53],
      [576, 1.64],
      [640, 1.75],
      [704, 1.89],
      [768, 2.04],
      [832, 2.22],
      [896, 2.41],
      [960, 2.63],
      [1023, 2.87],
    ],
  },
  triFoldLevel: {
    kind: 'pchip',
    knots: [
      [0, 1],
      [64, 0.9742],
      [128, 0.9469],
      [192, 0.9117],
      [256, 0.8639],
      [320, 0.821],
      [384, 0.7785],
      [448, 0.7397],
      [512, 0.7034],
      [576, 0.6928],
      [640, 0.6643],
      [704, 0.6349],
      [768, 0.6066],
      [832, 0.5838],
      [896, 0.5589],
      [960, 0.5393],
      [1023, 0.5168],
    ],
  },
  triFoldKnee: 0.3,
  sawMirrorW: {
    kind: 'pchip',
    knots: [
      [0, 0],
      [32, 0.025],
      [64, 0.04],
      [96, 0.055],
      [128, 0.0675],
      [160, 0.085],
      [192, 0.0975],
      [224, 0.115],
      [256, 0.13],
      [288, 0.145],
      [320, 0.16],
      [352, 0.1725],
      [384, 0.1875],
      [416, 0.2025],
      [448, 0.2175],
      [480, 0.2325],
      [512, 0.245],
      [544, 0.26],
      [576, 0.28],
      [608, 0.295],
      [640, 0.31],
      [672, 0.3275],
      [704, 0.3425],
      [736, 0.355],
      [768, 0.3675],
      [800, 0.385],
      [832, 0.395],
      [864, 0.455],
      [896, 0.4825],
      [928, 0.455],
      [960, 0.4525],
      [992, 0.48],
      [1023, 0.5],
    ],
  },
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

export const XD_PROFILES: readonly XdCalibProfile[] = [V0, V1].map(deepFreeze)

/** The shipped default. Promoting a measured profile is a reviewed change —
 *  v1 (the R1 re-baseline) promoted 2026-07-13 after Matt's listening
 *  review; the dev-era v2/v3/v4 were dropped in the same change. */
export const XD_DEFAULT_PROFILE = 'v1'

export function resolveXdProfile(id: string): XdCalibProfile | null {
  return XD_PROFILES.find((profile) => profile.id === id) ?? null
}

/** Mutable selection owned by one engine or UI realm. The profile value it
 * exposes is immutable configuration; selections no longer leak between
 * independent offline engines. */
export class XdCalibrationState {
  private current: XdCalibProfile

  constructor(id: string = XD_DEFAULT_PROFILE) {
    this.current = resolveXdProfile(id) ?? V1
  }

  get profile(): XdCalibProfile {
    return this.current
  }

  set(id: string): boolean {
    const profile = resolveXdProfile(id)
    if (!profile) return false
    this.current = profile
    return true
  }
}

const realmCalibration = new XdCalibrationState()

export function activeXdProfile(): XdCalibProfile {
  return realmCalibration.profile
}

/** Switch this realm's active profile; returns false for an unknown id. */
export function setXdProfile(id: string): boolean {
  return realmCalibration.set(id)
}
