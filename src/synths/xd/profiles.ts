/*
 * Versioned calibration profiles for the minilogue xd replica.
 *
 * A profile freezes every tunable that was originally guessed (UNCONFIRMED in
 * docs/xd-spec.md): v0 is the pre-calibration snapshot, and each reviewed
 * hardware-calibration round lands as a NEW profile instead of overwriting
 * curves.ts — so any version can be A/B'd from the settings drawer at any
 * time. Each engine owns an explicit profile selection; the UI realm keeps a
 * separate selection for display curves. The shipped default advances only
 * after measurement and listening review (currently v3;
 * docs/hardware-calibration.md 'Review gate').
 *
 * app.ts persists the choice and sends {t:'calibProfile'};
 * Engine.setCalibProfile changes only that engine and re-applies all params
 * so cached physical values re-derive.
 *
 * v1-v4 are legacy PARTIAL rounds retained for listening A/B while a future
 * complete generation is designed. They predate the canonical evidence +
 * independent verification gate and must not be treated as accepted
 * provenance or as the template for v5+.
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
  /** Measurement-method revision. v1-v4 are attributed to legacy R1;
   *  future complete profiles must declare their actual revision. */
  procedure?: { id: 'xd-hardware-calibration'; revision: number }
  /** R2+ provenance: the profile it builds on and the accepted result that
   * authorizes every changed emulation field. */
  lineage?: {
    baseProfile: string
    evidence: Partial<Record<XdCalibrationField, string>>
  }
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
  /** Filter, drift, and glide are included now so future D4/D8/portamento
   * measurements can enter the same versioned provenance gate. */
  filterConfig: SvfCfg
  driftConfig: DriftConfig
  portamentoMaxSec: number
  /*
   * VCO SHAPE morph models, measured 2026-07-11 (D2; findings log + evidence
   * artifact). ALL OPTIONAL: absent = the original guessed morphs, so v0-v3
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
 * evidence when a procedure-R2+ profile changes them. Metadata is excluded. */
export const XD_CALIBRATION_FIELDS = [
  'vcoPitchCents',
  'egAttackSec',
  'egDecaySec',
  'egReleaseSec',
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
  kMax: 2.0,
  kMin: 0.025,
  resCurve: 1.4,
  driveGains: [1.0, 2.6, 6.0],
  driveMakeups: [1.0, 0.7, 0.45],
  satLevel: 1.25,
  bassComp: 0.15,
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
  name: 'v1 · partial calibration 2026-07-10',
  date: '2026-07-10',
  procedure: { id: 'xd-hardware-calibration', revision: 1 },
  notes:
    'First hardware round — PARTIAL: only VCO pitch law, EG time tables, cutoff span and the ' +
    'SQR PW endpoint are measured; everything else (mod depths, LFO, filter voicing, drift) ' +
    'inherits the v0 guesses.',
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

/*
 * v2 — second independent hardware round (batch 2, 2026-07-10 late), sessions
 * 2026-07-10T07-4x/5x + 23-28 in calib/sessions/. Improvements over v1's
 * round: the pitch sweep medians ALL FOUR voices per point (was a voice pair)
 * and the cutoff sweep medians all four analog VCFs per point via per-strike
 * PSD transfers (was one rotating voice; measured per-voice VCF spread
 * ~3-6% mid-band). Repeatability vs the v1 round: EG tables within a few %,
 * pitch deltas within 0.2 cents. Sources:
 *   cutoffHz       2026-07-10T23-28-cutoff-sweep   (expMap fit, held-out 12.2%)
 *   egAttackSec    2026-07-10T07-49-eg-attack      (log-PCHIP, held-out 0.38%)
 *   egDecaySec     2026-07-10T07-50-eg-decay       (log-PCHIP, held-out 11.9%)
 *   egReleaseSec   2026-07-10T07-54-eg-release     (log-PCHIP, held-out 10.7%;
 *                  raw-0 knot carried from the v1 round — batch 2 measured
 *                  null there: ~4 ms sits at the ~3 ms follower floor)
 *   vcoPitchCents  2026-07-10T07-59-vco1-pitch-knob (4-voice medians)
 * Pitch table recentered by -2.221 cents (the unit's tuning state during the
 * sweep: dead zone read +2.02/+2.05/+2.60); dead-zone knots pooled to 0 and
 * the documented-flat end pairs (0/4, 1020/1023) pooled to their means.
 */
const V2: XdCalibProfile = {
  ...V0,
  id: 'v2',
  name: 'v2 · partial calibration, batch 2',
  date: '2026-07-10',
  procedure: { id: 'xd-hardware-calibration', revision: 1 },
  notes:
    'Second hardware round — PARTIAL like v1 (same fields measured, others inherit v0): ' +
    'all-4-voice medians for pitch AND cutoff; EG tables re-measured independently.',
  vcoPitchCents: {
    kind: 'pchip',
    knots: [
      [0, -1200.09],
      [4, -1200.09],
      [100, -898.75],
      [256, -412.86],
      [356, -99.74],
      [400, -66.41],
      [476, -6.61],
      [492, 0],
      [512, 0],
      [532, 0],
      [548, 5.51],
      [668, 100.32],
      [800, 509.08],
      [1020, 1199.54],
      [1023, 1199.54],
    ],
  },
  egAttackSec: {
    kind: 'logPchip',
    knots: [
      [0, 0.0042336],
      [85, 0.018047],
      [171, 0.068106],
      [256, 0.14808],
      [341, 0.26223],
      [426, 0.40743],
      [512, 0.59287],
      [597, 0.79645],
      [682, 1.0444],
      [767, 1.3229],
      [853, 1.6307],
      [938, 1.9746],
      [1023, 2.342],
    ],
  },
  egDecaySec: {
    kind: 'logPchip',
    knots: [
      [0, 0.0033878],
      [85, 0.014721],
      [171, 0.077378],
      [256, 0.18099],
      [341, 0.32505],
      [426, 0.5087],
      [512, 0.73578],
      [597, 1.0067],
      [682, 1.3386],
      [767, 1.6814],
      [853, 2.0726],
      [896, 2.3393],
      [938, 4.658],
      [980, 8.4385],
      [1023, 16.412],
    ],
  },
  egReleaseSec: {
    kind: 'logPchip',
    knots: [
      [0, 0.0041341], // carried from the v1 round (see header note)
      [85, 0.015611],
      [171, 0.077795],
      [256, 0.18277],
      [341, 0.32977],
      [426, 0.51792],
      [512, 0.75802],
      [597, 1.0055],
      [682, 1.3453],
      [767, 1.6918],
      [853, 2.0912],
      [896, 2.2909],
      [938, 4.6846],
      [980, 8.5318],
      [1023, 16.548],
    ],
  },
  cutoffHz: { kind: 'expMap', lo: 25.1, hi: 17800 },
  sqrPwMin: 0,
}

/*
 * v3 — v2 with the CUTOFF curve switched from expMap to a measured monotone
 * table (Matt's call, 2026-07-10: every cutoff session showed a systematic
 * taper deviation the expMap family cannot express). Knots are the
 * 2026-07-10T23-28 sweep's per-point corners (4-strike all-VCF medians),
 * BIAS-CORRECTED through the replica inversion (tools/calib/lib/domains.ts
 * biasCorrectCorners): the corner extractor reads a known 16 Hz replica
 * corner as 27 Hz and 1.4 kHz as 1.26 kHz, so raw measured corners must not
 * be transplanted into a profile directly. Corrected tables from the three
 * independent sessions agree within a few % per knot; held-out residual ~4%.
 * The raw-1023 knot is EXTRAPOLATED (log-linear through the last three
 * knots): the max-raw point is the PSD-transfer reference, so its own corner
 * is unmeasurable by construction — and ~23 kHz is at the rig's 48 kHz
 * Nyquist anyway. Both engine layers clamp fc to 0.45*fs, so the top knot
 * just means "wide open".
 */
const V3: XdCalibProfile = {
  ...V2,
  id: 'v3',
  name: 'v3 · partial calibration, cutoff table',
  date: '2026-07-10',
  notes:
    'v2 with cutoff as a measured monotone table instead of an expMap — captures the ' +
    'VCF taper the exponential could not, with corners bias-corrected via replica inversion.',
  cutoffHz: {
    kind: 'logPchip',
    knots: [
      [0, 24.667],
      [64, 33.21],
      [128, 43.319],
      [192, 71.46],
      [256, 111.72],
      [320, 178.77],
      [384, 281.97],
      [448, 417.69],
      [512, 658.35],
      [576, 1012.5],
      [640, 1571.5],
      [704, 2461.6],
      [768, 3872.9],
      [832, 6249.8],
      [896, 9517],
      [1023, 23223], // extrapolated (see header note)
    ],
  },
}

/*
 * v4 — v3 + the measured VCO SHAPE morph models (Matt approved the model
 * decisions 2026-07-11; findings log entries + the evidence artifact carry
 * the data). Sessions: shape-saw 2026-07-10T08-03, shape-sqr 08-06,
 * shape-tri 2026-07-11T05-35, all A2 mean cycles with the capture chain's
 * AC-coupling inverted.
 *   SQR  constant-swing PWM: measured duty table (~linear 50.8% -> 0), real
 *        DC carried to the VCF, no peak normalization (hardware keeps a
 *        constant +-swing; the level ratio measured 1.00 -> 0.91).
 *   TRI  single soft fold: drive g' + output-level tables fitted jointly
 *        with the knee (r = 0.30; flat basin 0.3-0.4 — weakly identified,
 *        picked with its coherent drive table). SHAPE max renders the
 *        measured pure x3 triple; the fold ceiling tapers ~2x.
 *   SAW  reversal mirror: one parameter w — the wave time-mirrors through a
 *        window +-w*T centered on the alternate tooth boundary. Fitted on
 *        the 33-point dense sweep (2026-07-11T07-09): w ~ shape/2 linear
 *        within +-0.011, saturating at 0.5 by raw ~992; mid-morph waveform
 *        residuals 17-24% = the rig's edge-smear floor (the chopper's 47-70%
 *        mid-range gap is gone). w=0 is exactly the plain saw; w=0.5 is the
 *        measured half-wave-antisymmetric octave-down endpoint.
 */
const V4: XdCalibProfile = {
  ...V3,
  id: 'v4',
  name: 'v4 · + measured SHAPE morphs',
  date: '2026-07-11',
  notes:
    'v3 plus the measured VCO SHAPE models: SAW half-rate chopper (octave-down morph), ' +
    'TRI single soft fold ending at an exact x3, SQR constant-swing PWM with the measured ' +
    'duty table and real DC. Legacy morphs remain in v0-v3.',
  // All SHAPE tables below: D2 pipeline fits (measure-shape.ts) over the
  // sessions named in the header, 2026-07-11.
  sqrDuty: {
    kind: 'pchip',
    knots: [
      [0, 0.5075],
      [128, 0.44],
      [256, 0.38],
      [384, 0.3225],
      [512, 0.2625],
      [640, 0.2025],
      [768, 0.14],
      [896, 0.08],
      [1023, 0], // measured silence
    ],
  },
  triFoldDrive: {
    // coherent with triFoldKnee = 0.30 (drive and knee trade off; the knee
    // basin is flat 0.3-0.4, so the pair was fitted together)
    kind: 'pchip',
    knots: [
      [0, 1.03],
      [64, 1.04],
      [128, 1.07],
      [192, 1.11],
      [256, 1.17],
      [320, 1.25],
      [384, 1.33],
      [448, 1.42],
      [512, 1.55],
      [576, 1.66],
      [640, 1.79],
      [704, 1.93],
      [768, 2.09],
      [832, 2.27],
      [896, 2.47],
      [960, 2.69],
      [1023, 2.94], // the fitted exact-x3 endpoint under the soft knee
    ],
  },
  triFoldLevel: {
    kind: 'pchip',
    knots: [
      [0, 1.0],
      [64, 0.9887],
      [128, 0.9625],
      [192, 0.9277],
      [256, 0.8844],
      [320, 0.8379],
      [384, 0.7968],
      [448, 0.7585],
      [512, 0.7251],
      [576, 0.6927],
      [640, 0.6615],
      [704, 0.632],
      [768, 0.6054],
      [832, 0.5813],
      [896, 0.5596],
      [960, 0.5378],
      [1023, 0.5125],
    ],
  },
  triFoldKnee: 0.3,
  sawMirrorW: {
    // dense-sweep fit (33 points; raw 544's capture was weak — re-measure
    // someday); endpoints pinned by structure: 0 = plain saw, 0.5 = the
    // measured exact half-wave antisymmetry at SHAPE max
    kind: 'pchip',
    knots: [
      [0, 0],
      [32, 0.025],
      [64, 0.0375],
      [96, 0.055],
      [128, 0.0675],
      [160, 0.0875],
      [192, 0.1025],
      [224, 0.1125],
      [256, 0.13],
      [288, 0.145],
      [320, 0.16],
      [352, 0.1725],
      [384, 0.1875],
      [416, 0.2075],
      [448, 0.2225],
      [480, 0.2375],
      [512, 0.2525],
      [544, 0.265],
      [576, 0.28],
      [608, 0.295],
      [640, 0.31],
      [672, 0.325],
      [704, 0.3375],
      [736, 0.3575],
      [768, 0.3725],
      [800, 0.385],
      [832, 0.4],
      [864, 0.4175],
      [896, 0.43],
      [928, 0.445],
      [960, 0.47],
      [992, 0.5],
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

export const XD_PROFILES: readonly XdCalibProfile[] = [V0, V1, V2, V3, V4].map(deepFreeze)

/** The shipped default. Promoting a measured profile is a reviewed change —
 *  v2 promoted 2026-07-10 after Matt's listening A/B; v3 (cutoff table)
 *  promoted the same day on Matt's standing call; v4 (SHAPE models) stays
 *  NON-default until the D2 fits land and Matt A/Bs it. */
export const XD_DEFAULT_PROFILE = 'v3'

export function resolveXdProfile(id: string): XdCalibProfile | null {
  return XD_PROFILES.find((profile) => profile.id === id) ?? null
}

/** Mutable selection owned by one engine or UI realm. The profile value it
 * exposes is immutable configuration; selections no longer leak between
 * independent offline engines. */
export class XdCalibrationState {
  private current: XdCalibProfile

  constructor(id: string = XD_DEFAULT_PROFILE) {
    this.current = resolveXdProfile(id) ?? V3
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
