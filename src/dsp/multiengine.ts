/*
 * Korg minilogue xd MULTI digital engine: NOISE, VPM and USER oscillators.
 *
 * Plain TypeScript DSP class — no DOM, no worklet globals. Sample rate is a
 * constructor argument. The audio path (tick) performs no allocation; all
 * tables and state buffers are preallocated at construction time.
 *
 * Click safety: type/subtype switches go through a short fade-out -> commit ->
 * fade-in state machine (~2 ms each way); SHAPE / SHIFT+SHAPE / pitch are
 * smoothed with one-pole ramps. noteOn() commits pending switches instantly
 * (the amp EG downstream gates the attack) and retriggers internal envelopes,
 * LFOs and phases.
 */

// NOISE shape -> physical maps (spec §5; the multi engine — and these curves —
// are shared by the prologue's identical engine).
function noiseHighHz(shape01: number): number {
  return 10 * Math.pow(2100, clamp(shape01, 0, 1))
}
function noiseLowHz(shape01: number): number {
  return 10 * Math.pow(2100, clamp(shape01, 0, 1))
}
function noisePeakBwHz(shape01: number): number {
  return 110 * Math.pow(8, clamp(shape01, 0, 1))
}
function noiseDecimHz(shape01: number): number {
  return 240 * Math.pow(200, clamp(shape01, 0, 1))
}

export const MULTI_TYPE = { NOISE: 0, VPM: 1, USER: 2 } as const

export const NOISE_TYPE = { HIGH: 0, LOW: 1, PEAK: 2, DECIM: 3 } as const

export const VPM_TYPE = {
  SIN1: 0,
  SIN2: 1,
  SIN3: 2,
  SIN4: 3,
  SAW1: 4,
  SAW2: 5,
  SQU1: 6,
  SQU2: 7,
  FAT1: 8,
  FAT2: 9,
  AIR1: 10,
  AIR2: 11,
  DECAY1: 12,
  DECAY2: 13,
  CREEP: 14,
  THROAT: 15,
} as const

export const USER_OSC_NAMES: readonly string[] = ['MORPH', 'SPRSAW', 'PWMCLS', 'ORGAN']

/**
 * VPM menu trims (spec §5.2), each -1..+1 with 0 = the type's baked default.
 * Applied only in VPM mode; NOISE/USER are unaffected.
 */
export interface VpmTrims {
  feedback: number
  noiseDepth: number
  shapeModInt: number
  modAttack: number
  modDecay: number
  keyTrack: number
}

const TWO_PI = Math.PI * 2
const HALF_PI = Math.PI * 0.5
const CENT = Math.LN2 / 1200 // exp(CENT * cents) = detune ratio
const DENORM = 1e-15

/** Flush denormals / non-finite feedback state to zero. */
function sane(x: number): number {
  if (!Number.isFinite(x)) return 0
  return x > -DENORM && x < DENORM ? 0 : x
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

/** Sanitize one trim field: clamp to -1..1, keep the previous value on junk. */
function trimVal(v: number, prev: number): number {
  return Number.isFinite(v) ? clamp(v, -1, 1) : prev
}

/** Stability cap on the trimmed modulator self-feedback. */
const VPM_FB_CAP = 4
/** Mod-index key-track pivot: middle C (C4). */
const INV_C4 = 1 / 261.625565
/** Mod Attack trim +100% introduces a ~180 ms mod-index attack. */
const VPM_ATK_REF = 0.06
/**
 * PEAK noise bandpass center = note freq * this fixed ratio. The hardware
 * manual only documents the BANDWIDTH range (110..880 Hz); the center is
 * UNCONFIRMED (spec §5: "model as keytracked"), so we keytrack it at ~4x
 * the note.
 */
const NOISE_PEAK_CENTER_RATIO = 4

/**
 * VPM SHIFT+SHAPE stepped RATIO OFFSET (spec §5: "1:4, 1:2, 1:1, 2:1, ...").
 * Knob zones (ss 0..1) -> modulator-ratio multiplier. The wide center zone
 * keeps the detent (stored 512 -> ss ~0.5) exactly neutral:
 *   [0.00, 0.15)  ->  x1/4
 *   [0.15, 0.38)  ->  x1/2
 *   [0.38, 0.62]  ->  x1
 *   (0.62, 0.85]  ->  x2
 *   (0.85, 1.00]  ->  x4
 */
function ssRatioStep(ss: number): number {
  if (ss < 0.15) return 0.25
  if (ss < 0.38) return 0.5
  if (ss <= 0.62) return 1
  if (ss <= 0.85) return 2
  return 4
}

/** Two-sample polynomial band-limited step residual (classic PolyBLEP). */
function polyblep(t: number, dt: number): number {
  if (dt <= 0) return 0
  if (t < dt) {
    const x = t / dt
    return x + x - x * x - 1
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt
    return x * x + x + x + 1
  }
  return 0
}

/* ------------------------------------------------------------------ VPM -- */

interface VpmVoice {
  /** carrier ratio */
  cr: number
  /** modulator ratio */
  mr: number
  /** modulator self-feedback */
  fb: number
  /** scale on the SHAPE-derived modulation index */
  idx: number
  /** internal mod-index decay envelope time constant, seconds (0 = none) */
  envTau: number
  /** slow drift LFO on the modulator ratio */
  driftRate: number
  driftAmt: number
  /**
   * SHIFT+SHAPE ratio-offset style, neutral at the center detent (ss = 0.5):
   * 0 = continuous bipolar ratio tilt x1/(1+ssRange)..x(1+ssRange),
   * 1 = stepped multiplier x1/4..x4 (ssRatioStep; ssRange unused).
   */
  ssMode: number
  ssRange: number
  /** carrier tanh drive (0 = clean sine carrier) */
  drive: number
}

function vv(
  cr: number, mr: number, fb: number, idx: number, envTau: number,
  driftRate: number, driftAmt: number, ssMode: number, ssRange: number, drive: number,
): VpmVoice {
  return { cr, mr, fb, idx, envTau, driftRate, driftAmt, ssMode, ssRange, drive }
}

const VPM_TABLE: readonly VpmVoice[] = [
  /* SIN1   */ vv(1, 1.0, 0.0, 1.0, 0, 0, 0, 1, 1.0, 0),
  /* SIN2   */ vv(1, 2.0, 0.0, 1.0, 0, 0, 0, 1, 1.0, 0),
  /* SIN3   */ vv(1, 3.007, 0.0, 0.95, 0, 0, 0, 1, 1.0, 0),
  /* SIN4   */ vv(1, 5.0, 0.0, 0.9, 0, 0, 0, 1, 1.0, 0),
  /* SAW1   */ vv(1, 1.0, 0.9, 1.3, 0, 0, 0, 1, 0.8, 0),
  /* SAW2   */ vv(1, 1.0, 1.4, 1.6, 0, 0, 0, 1, 0.8, 0.8),
  /* SQU1   */ vv(1, 2.0, 0.8, 1.1, 0, 0, 0, 1, 0.8, 0),
  /* SQU2   */ vv(1, 2.0, 1.25, 1.4, 0, 0, 0, 1, 0.8, 0.9),
  /* FAT1   */ vv(1, 0.5, 0.4, 1.4, 0, 0, 0, 0, 1.0, 0.4),
  /* FAT2   */ vv(1, 0.5, 1.0, 1.7, 0, 0, 0, 1, 1.0, 0.7),
  /* AIR1   */ vv(1, 7.07, 0.2, 0.35, 0, 0, 0, 0, 0.5, 0),
  /* AIR2   */ vv(1, 9.7, 1.9, 0.5, 0, 0, 0, 1, 1.0, 0),
  /* DECAY1 */ vv(1, 1.0, 0.3, 1.2, 0.15, 0, 0, 0, 3.0, 0),
  /* DECAY2 */ vv(1, 3.01, 0.4, 1.2, 0.5, 0, 0, 0, 1.0, 0),
  /* CREEP  */ vv(1, 1.003, 0.25, 1.0, 0, 0.31, 0.06, 0, 0.5, 0),
  /* THROAT */ vv(1, 1.0, 0.25, 1.0, 0, 0, 0, 0, 0.5, 0), // special-cased in tickVpm
]

/* ---------------------------------------------------------- USER: MORPH -- */

const MORPH_WAVES = 8
const MORPH_LEVELS = 6 // mip max-harmonic per level: 32 16 8 4 2 1
const MORPH_MAXH = 32
const MORPH_N = 2048
const MORPH_LEVEL_H: readonly number[] = [32, 16, 8, 4, 2, 1]

function morphSpecs(): number[][] {
  const specs: number[][] = []
  const blank = (): number[] => new Array<number>(MORPH_MAXH).fill(0)
  // 0: pure sine
  let s = blank(); s[0] = 1; specs.push(s)
  // 1: triangle-ish (odd harmonics, 1/k^2, alternating sign)
  s = blank()
  for (let k = 1; k <= 31; k += 2) s[k - 1] = (((k - 1) / 2) % 2 === 0 ? 1 : -1) / (k * k)
  specs.push(s)
  // 2: drawbar organ flavour (octaves + a whisper of 3rd)
  s = blank(); s[0] = 1; s[1] = 0.7; s[2] = 0.15; s[3] = 0.5; s[7] = 0.4; specs.push(s)
  // 3: formant-ish hump around the 4th harmonic
  s = blank(); s[0] = 0.3; s[1] = 0.5; s[2] = 0.9; s[3] = 1.0; s[4] = 0.7; s[5] = 0.35; s[6] = 0.15
  specs.push(s)
  // 4: metallic / bell-ish sparse spectrum
  s = blank(); s[0] = 0.8; s[4] = 0.9; s[8] = 0.7; s[12] = 0.6; s[16] = 0.45; s[22] = 0.3; s[28] = 0.2
  specs.push(s)
  // 5: bright odd stack (square-ish organ)
  s = blank()
  for (let k = 1; k <= 15; k += 2) s[k - 1] = 1 / k
  specs.push(s)
  // 6: saw-ish, harmonics capped at 32
  s = blank()
  for (let k = 1; k <= 32; k++) s[k - 1] = 1 / k
  specs.push(s)
  // 7: brighter saw (gentler roll-off)
  s = blank()
  for (let k = 1; k <= 32; k++) s[k - 1] = 1 / Math.pow(k, 0.75)
  specs.push(s)
  return specs
}

/**
 * Band-limited single-cycle tables, mip-mapped by max harmonic so playback
 * can cap content at sr*0.45/freq. Independent of sample rate, so they are
 * built once and shared between engine instances (per-voice construction
 * stays cheap).
 */
let MORPH_TABLES: Float32Array[] | null = null

function getMorphTables(): Float32Array[] {
  if (MORPH_TABLES) return MORPH_TABLES
  const specs = morphSpecs()
  const tables: Float32Array[] = []
  const tmp = new Float64Array(MORPH_N)
  for (let w = 0; w < MORPH_WAVES; w++) {
    const amps = specs[w]
    let norm = 1
    for (let l = 0; l < MORPH_LEVELS; l++) {
      const maxH = MORPH_LEVEL_H[l]
      tmp.fill(0)
      let peak = 0
      for (let k = 1; k <= maxH; k++) {
        const a = amps[k - 1]
        if (a === 0) continue
        const w0 = (TWO_PI * k) / MORPH_N
        for (let i = 0; i < MORPH_N; i++) tmp[i] += a * Math.sin(w0 * i)
      }
      for (let i = 0; i < MORPH_N; i++) {
        const v = Math.abs(tmp[i])
        if (v > peak) peak = v
      }
      if (l === 0) norm = peak > 0 ? 1 / peak : 1 // one gain per wave (levels stay consistent)
      const t = new Float32Array(MORPH_N + 1)
      for (let i = 0; i < MORPH_N; i++) t[i] = tmp[i] * norm
      t[MORPH_N] = t[0]
      tables.push(t)
    }
  }
  MORPH_TABLES = tables
  return tables
}

/* -------------------------------------------------------- USER: helpers -- */

const SPR_WEIGHTS: readonly number[] = [-1, -0.6396, -0.2716, 0, 0.2716, 0.6396, 1]
const PWM_LFO_RATES: readonly number[] = [0.4, 0.53, 0.71]
const PWM_DET_WEIGHTS: readonly number[] = [-1, 0, 1]
const ORGAN_H: readonly number[] = [1, 2, 3, 4, 6, 8]
const ORGAN_MELLOW_RAW: readonly number[] = [1, 0.5, 0.15, 0.1, 0.05, 0.03]
const ORGAN_BRIGHT_RAW: readonly number[] = [0.85, 0.9, 0.6, 0.7, 0.55, 0.65]

/* ---------------------------------------------------------------- class -- */

export class MultiEngine {
  private readonly sr: number
  private readonly nyq: number // usable band limit = sr * 0.45

  // parameters (targets + smoothed values)
  private shapeT = 0.5
  private shape = 0.5
  private shiftT = 0
  private shift = 0
  private freqT = 440
  private freq = 440
  private readonly pSmooth: number // ~5 ms one-pole for shape/shift
  private readonly fSmooth: number // ~2 ms one-pole for pitch

  // type state + click-free switch machine
  private curType: number = MULTI_TYPE.NOISE
  private curSub = 0
  private pendType: number = MULTI_TYPE.NOISE
  private pendSub = 0
  private pending = false
  private fadeGain = 1
  private readonly fadeStep: number // ~2 ms fade per direction

  // noise state
  private rngState = 0x1badcafe
  private svfIc1 = 0
  private svfIc2 = 0
  private decimPhase = 1
  private decimHold = 0

  // VPM state
  private vpmCarPhase = 0
  private vpmModPhase = 0
  private vpmMod2Phase = 0
  private vpmFb1 = 0
  private vpmFb2 = 0
  private vpmEnv = 1
  private vpmEnvCoef = 1
  private vpmDriftPhase = 0

  // VPM menu trims (-1..+1, 0 = neutral) + coefficients derived from them.
  // Derivation happens at parameter time (setVpmTrims / type commits), never
  // per sample; tick() only reads the vpm*Eff scalars.
  private trFb = 0
  private trNz = 0
  private trEg = 0
  private trAtk = 0
  private trDec = 0
  private trKt = 0
  private vpmFbEff = 0 // trimmed modulator self-feedback for the current sub
  private vpmNzEff = 0 // trimmed noise phase-mod amount into the modulator
  private vpmEgAmt = 1 // internal EG/drift contribution scale (0..2)
  private vpmDriftAmtEff = 0 // trimmed drift-LFO depth (Creep)
  private vpmAtkCoef = 1 // one-pole rise coef for the mod-index attack (1 = snap)
  private vpmAtk = 1 // mod-index attack state, 0..1

  // USER state
  private readonly morphTables: Float32Array[]
  private morphPhase = 0
  private readonly sprPhases = new Float64Array(7)
  private readonly pwmPhases = new Float64Array(3)
  private readonly pwmLfoPhases = new Float64Array(3)
  private organPhase = 0
  private organPerc = 0
  private readonly organPercCoef: number
  private readonly organMellow = new Float64Array(6)
  private readonly organBright = new Float64Array(6)

  constructor(sampleRate: number) {
    const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
    this.sr = sr
    this.nyq = sr * 0.45
    this.pSmooth = 1 - Math.exp(-1 / (0.005 * sr))
    this.fSmooth = 1 - Math.exp(-1 / (0.002 * sr))
    this.fadeStep = 1 / (0.002 * sr)
    this.organPercCoef = Math.exp(-1 / (0.045 * sr))

    this.morphTables = getMorphTables()

    // normalized drawbar registrations (equal power-ish loudness)
    let m2 = 0
    let b2 = 0
    for (let i = 0; i < 6; i++) {
      m2 += ORGAN_MELLOW_RAW[i] * ORGAN_MELLOW_RAW[i]
      b2 += ORGAN_BRIGHT_RAW[i] * ORGAN_BRIGHT_RAW[i]
    }
    const mg = 1 / Math.sqrt(m2)
    const bg = 1 / Math.sqrt(b2)
    for (let i = 0; i < 6; i++) {
      this.organMellow[i] = ORGAN_MELLOW_RAW[i] * mg
      this.organBright[i] = ORGAN_BRIGHT_RAW[i] * bg
    }

    this.refreshDerived()
    this.clearVoiceState()
  }

  /* ------------------------------------------------------- parameters -- */

  setType(t: number): void {
    if (!Number.isFinite(t)) return
    const v = clamp(Math.round(t), 0, 2)
    const effective = this.pending ? this.pendType : this.curType
    if (v === effective) return
    this.pendType = v
    this.pendSub = this.pending ? this.pendSub : this.curSub
    this.pending = true
  }

  /** Noise type / VPM type / user slot index — interpreted per current type. */
  setSubType(s: number): void {
    if (!Number.isFinite(s)) return
    const v = clamp(Math.round(s), 0, 15)
    const effective = this.pending ? this.pendSub : this.curSub
    if (v === effective) return
    if (!this.pending) this.pendType = this.curType
    this.pendSub = v
    this.pending = true
  }

  /** SHAPE knob, 0..1. */
  setShape(v: number): void {
    if (!Number.isFinite(v)) return
    this.shapeT = clamp(v, 0, 1)
  }

  /** SHIFT+SHAPE secondary knob, 0..1. */
  setShiftShape(v: number): void {
    if (!Number.isFinite(v)) return
    this.shiftT = clamp(v, 0, 1)
  }

  /** Note pitch in Hz. */
  setFreq(hz: number): void {
    if (!Number.isFinite(hz)) return
    this.freqT = clamp(hz, 0.01, this.nyq)
  }

  /**
   * VPM menu trims (spec §5.2), each -1..+1 (0 = neutral = the per-type baked
   * default; VPM mode only). Curves, with t = trim and `base` the per-type
   * table value:
   *
   * - feedback:   t>=0 -> base*(1+2t) + 0.4t (zero-feedback types gain some);
   *               t<0  -> base*(1+t) (0 at -100%); capped at VPM_FB_CAP.
   * - noiseDepth: same shape over the baked noise-mod amount (currently 0 for
   *               every type), so only t>0 injects noise: 0.5t rad into the
   *               modulator phase; t<=0 stays clean.
   * - shapeModInt:scales the internal mod-EG / drift-LFO contribution by
   *               (1+t) in 0..2. At -100% the EG's effect is fully disabled
   *               (constant index — the Decay1/Decay2/Creep manual note); at
   *               +100% the decaying part is doubled (floored at index 0).
   * - modAttack:  the internal EG has no baked attack; t>0 introduces one of
   *               VPM_ATK_REF*(4^t - 1) seconds (~0..180 ms), t<=0 none.
   * - modDecay:   scales the internal EG decay tau exponentially: tau * 4^t.
   * - keyTrack:   tilts the mod index around C4: index *= (f/C4)^(-0.5t),
   *               clamped to [0.25, 4] (+100% = darker up high, brighter low).
   *
   * Trims persist across type/subtype switches; derived coefficients are
   * recomputed here and on every type commit.
   */
  setVpmTrims(t: VpmTrims): void {
    this.trFb = trimVal(t.feedback, this.trFb)
    this.trNz = trimVal(t.noiseDepth, this.trNz)
    this.trEg = trimVal(t.shapeModInt, this.trEg)
    this.trAtk = trimVal(t.modAttack, this.trAtk)
    this.trDec = trimVal(t.modDecay, this.trDec)
    this.trKt = trimVal(t.keyTrack, this.trKt)
    this.refreshDerived()
  }

  /* ------------------------------------------------------------ events -- */

  /** Retrigger internal envelopes / LFOs / phases (note attack). */
  noteOn(): void {
    if (this.pending) {
      this.commitPending() // includes clearVoiceState()
    } else {
      this.clearVoiceState()
    }
    this.fadeGain = 1
    // snap parameter smoothers — a fresh note starts exactly where the panel is
    this.shape = this.shapeT
    this.shift = this.shiftT
    this.freq = this.freqT
  }

  reset(): void {
    if (this.pending) {
      this.curType = this.pendType
      this.curSub = this.pendSub
      this.pending = false
      this.refreshDerived()
    }
    this.rngState = 0x1badcafe
    this.clearVoiceState()
    this.fadeGain = 1
    this.shape = this.shapeT
    this.shift = this.shiftT
    this.freq = this.freqT
  }

  /* -------------------------------------------------------------- tick -- */

  tick(): number {
    // parameter smoothing
    this.shape += (this.shapeT - this.shape) * this.pSmooth
    this.shift += (this.shiftT - this.shift) * this.pSmooth
    this.freq += (this.freqT - this.freq) * this.fSmooth

    // click-free type/subtype switch: fade out, commit at silence, fade in
    if (this.pending) {
      this.fadeGain -= this.fadeStep
      if (this.fadeGain <= 0) {
        this.fadeGain = 0
        this.commitPending()
      }
    } else if (this.fadeGain < 1) {
      this.fadeGain += this.fadeStep
      if (this.fadeGain > 1) this.fadeGain = 1
    }

    let y: number
    switch (this.curType) {
      case MULTI_TYPE.NOISE:
        y = this.tickNoise()
        break
      case MULTI_TYPE.VPM:
        y = this.tickVpm()
        break
      default:
        y = this.tickUser()
        break
    }

    if (!Number.isFinite(y)) {
      y = 0
      this.clearVoiceState()
    }
    y *= this.fadeGain

    // transparent soft-knee guard: linear below |1|, hard-bounded below |2|
    if (y > 1) y = 1 + Math.tanh(y - 1)
    else if (y < -1) y = -1 - Math.tanh(-y - 1)
    return y
  }

  /* ------------------------------------------------------------- NOISE -- */

  private tickNoise(): number {
    const sub = this.curSub > 3 ? 3 : this.curSub
    const shape = this.shape

    if (sub === NOISE_TYPE.DECIM) {
      // S&H decimated noise. SHAPE sets an ABSOLUTE rate 240 Hz..48 kHz
      // (spec §5, clamped to sr); SHIFT+SHAPE is the keytrack amount 0..100%:
      // rate = decimHz * (noteFreq/C4)^shift, so at 0 the rate is fixed and
      // at 1 it tracks the keyboard chromatically (doubling per octave).
      let rate = noiseDecimHz(shape)
      if (rate > this.sr) rate = this.sr
      const kt = this.shift
      if (kt > 0) rate *= Math.pow(this.freq * INV_C4, kt)
      rate = clamp(rate, 1, this.sr)
      this.decimPhase += rate / this.sr
      if (this.decimPhase >= 1) {
        this.decimPhase -= Math.floor(this.decimPhase)
        this.decimHold = this.white()
      }
      return this.decimHold * 0.6
    }

    const x = this.white()
    let fc: number
    let q: number
    if (sub === NOISE_TYPE.HIGH) {
      fc = noiseHighHz(shape) // HPF cutoff 10 Hz .. 21 kHz (spec §5)
      q = 0.7071
    } else if (sub === NOISE_TYPE.LOW) {
      fc = noiseLowHz(shape) // LPF cutoff 10 Hz .. 21 kHz (spec §5)
      q = 0.7071
    } else {
      // PEAK: SHAPE sets the bandpass BANDWIDTH 110..880 Hz (spec §5); the
      // center keytracks the note at a fixed ratio (UNCONFIRMED, see
      // NOISE_PEAK_CENTER_RATIO). Q follows from center/bandwidth.
      const bw = noisePeakBwHz(shape)
      fc = clamp(this.freq * NOISE_PEAK_CENTER_RATIO, 20, this.nyq)
      q = clamp(fc / bw, 0.5, 50)
    }

    // TPT (Zavalishin) state-variable filter
    const g = Math.tan(Math.PI * clamp(fc, 1, this.nyq) / this.sr)
    const k = 1 / q
    const a1 = 1 / (1 + g * (g + k))
    const a2 = g * a1
    const a3 = g * a2
    const v3 = x - this.svfIc2
    const v1 = a1 * this.svfIc1 + a2 * v3
    const v2 = this.svfIc2 + a2 * this.svfIc1 + a3 * v3
    this.svfIc1 = sane(2 * v1 - this.svfIc1)
    this.svfIc2 = sane(2 * v2 - this.svfIc2)

    if (sub === NOISE_TYPE.HIGH) return (x - k * v1 - v2) * 0.7
    if (sub === NOISE_TYPE.LOW) return v2 * 0.8
    return k * v1 * 2.2 // unity-peak bandpass + makeup
  }

  /* --------------------------------------------------------------- VPM -- */

  private tickVpm(): number {
    const sub = this.curSub > 15 ? 15 : this.curSub
    const f = this.freq
    const sr = this.sr
    const ss = this.shift
    const fbIn = (this.vpmFb1 + this.vpmFb2) * 0.5 // 2-sample fb average (DX trick)
    // NOISE DEPTH trim: white-noise phase mod into the modulator. The rng is
    // only consumed when the trim is engaged (keeps neutral output and NOISE
    // mode's stream bit-identical to the untrimmed engine).
    const nzA = this.vpmNzEff
    const nz = nzA > 0 ? nzA * this.white() : 0
    let y: number

    if (sub === VPM_TYPE.THROAT) {
      // two cascaded modulators at formant-ish ratios; SHAPE morphs the vowel
      // (trims applied here: feedback + noise; vpmFbEff is 0.25 at neutral,
      // matching the THROAT table entry)
      const t = this.shape
      // formant ratio scale, bipolar around the center detent (neutral at
      // ss = 0.5, matching the SHIFT+SHAPE = ratio-offset semantics)
      const sc = Math.pow(1.5, 2 * (ss - 0.5))
      const mr2 = (3.5 + 2.0 * t) * sc
      const mr1 = (2.5 - 1.5 * t) * sc
      const i2 = 1.8 - 1.2 * t
      const i1 = 1.6 + 1.8 * t
      let p2 = this.vpmMod2Phase + (f * mr2) / sr
      p2 -= Math.floor(p2)
      this.vpmMod2Phase = p2
      const m2 = Math.sin(TWO_PI * p2)
      let p1 = this.vpmModPhase + (f * mr1) / sr
      p1 -= Math.floor(p1)
      this.vpmModPhase = p1
      const m1 = Math.sin(TWO_PI * p1 + i2 * m2 + this.vpmFbEff * fbIn + nz)
      this.vpmFb2 = this.vpmFb1
      this.vpmFb1 = sane(m1)
      let pc = this.vpmCarPhase + f / sr
      pc -= Math.floor(pc)
      this.vpmCarPhase = pc
      y = Math.sin(TWO_PI * pc + i1 * m1)
    } else {
      const c = VPM_TABLE[sub]
      // perceptually even index curve, 0..~6, scaled per type
      let index = 6 * Math.pow(this.shape, 1.8) * c.idx
      if (this.trKt !== 0) {
        // KEY TRACK trim: tilt the mod index around C4 (see setVpmTrims).
        let kt = Math.pow(f * INV_C4, -0.5 * this.trKt)
        if (kt < 0.25) kt = 0.25
        else if (kt > 4) kt = 4
        index *= kt
      }
      if (c.envTau > 0) {
        let env = this.vpmEnv
        if (this.vpmAtk < 1) {
          // MOD ATTACK trim: one-pole rise on the internal EG.
          let a = this.vpmAtk + (1 - this.vpmAtk) * this.vpmAtkCoef
          if (a > 0.9995) a = 1
          this.vpmAtk = a
          env *= a
        }
        const s = this.vpmEgAmt
        if (s === 1) {
          index *= env // neutral fast path: bit-identical to the old engine
        } else {
          // SHAPE MOD INT trim: scale the EG's *contribution* (departure from
          // the static index). s=0 pins the index (EG disabled), s=2 doubles
          // the decaying part, floored at 0.
          let e = 1 + s * (env - 1)
          if (e < 0) e = 0
          index *= e
        }
        this.vpmEnv = sane(this.vpmEnv * this.vpmEnvCoef)
      }
      let mr = c.mr
      const fb = this.vpmFbEff // FEEDBACK trim (== c.fb at neutral)
      // SHIFT+SHAPE = RATIO OFFSET (spec §5), neutral at the center detent.
      if (c.ssMode === 0) {
        // continuous bipolar tilt: x1/(1+range) at ss=0 .. x(1+range) at ss=1
        mr *= Math.pow(1 + c.ssRange, 2 * (ss - 0.5))
      } else {
        mr *= ssRatioStep(ss) // stepped x1/4 .. x4 (zone table above)
      }
      if (this.vpmDriftAmtEff > 0) {
        let dp = this.vpmDriftPhase + c.driftRate / sr
        if (dp >= 1) dp -= 1
        this.vpmDriftPhase = dp
        mr *= 1 + this.vpmDriftAmtEff * Math.sin(TWO_PI * dp)
      }
      let pm = this.vpmModPhase + (f * mr) / sr
      pm -= Math.floor(pm)
      this.vpmModPhase = pm
      const m = Math.sin(TWO_PI * pm + fb * fbIn + nz)
      this.vpmFb2 = this.vpmFb1
      this.vpmFb1 = sane(m)
      let pc = this.vpmCarPhase + (f * c.cr) / sr
      pc -= Math.floor(pc)
      this.vpmCarPhase = pc
      y = Math.sin(TWO_PI * pc + index * m)
      if (c.drive > 0) {
        const d = 1 + c.drive
        y = Math.tanh(d * y) / Math.tanh(d)
      }
    }
    return y * 0.85
  }

  /* -------------------------------------------------------------- USER -- */

  private tickUser(): number {
    const sub = this.curSub > 3 ? 3 : this.curSub
    switch (sub) {
      case 0:
        return this.tickMorph()
      case 1:
        return this.tickSprSaw()
      case 2:
        return this.tickPwmCls()
      default:
        return this.tickOrgan()
    }
  }

  private tickMorph(): number {
    const f = this.freq
    let p = this.morphPhase + f / this.sr
    if (p >= 1) p -= 1
    this.morphPhase = p

    // mip level: largest table whose top harmonic stays below sr*0.45
    const hLim = clamp(this.nyq / f, 1, MORPH_MAXH)
    const L = clamp(Math.log2(MORPH_MAXH / hLim), 0, MORPH_LEVELS - 1)
    const l0 = L | 0
    const l1 = l0 < MORPH_LEVELS - 1 ? l0 + 1 : l0
    const lf = L - l0

    // SHAPE scans linearly across the 8 waves
    const wPos = this.shape * (MORPH_WAVES - 1)
    let w0 = wPos | 0
    if (w0 > MORPH_WAVES - 2) w0 = MORPH_WAVES - 2
    const wf = wPos - w0

    const x = p * MORPH_N
    const i = x | 0
    const fr = x - i
    const tabs = this.morphTables
    const t00 = tabs[w0 * MORPH_LEVELS + l0]
    const t01 = tabs[w0 * MORPH_LEVELS + l1]
    const t10 = tabs[(w0 + 1) * MORPH_LEVELS + l0]
    const t11 = tabs[(w0 + 1) * MORPH_LEVELS + l1]
    const r00 = t00[i] + (t00[i + 1] - t00[i]) * fr
    const r01 = t01[i] + (t01[i + 1] - t01[i]) * fr
    const r10 = t10[i] + (t10[i + 1] - t10[i]) * fr
    const r11 = t11[i] + (t11[i + 1] - t11[i]) * fr
    const a = r00 + (r01 - r00) * lf
    const b = r10 + (r11 - r10) * lf
    let y = a + (b - a) * wf

    // SHIFT+SHAPE: soft sine wavefold
    const ss = this.shift
    if (ss > 0.0005) {
      const drive = 1 + 3 * ss
      const folded = Math.sin(HALF_PI * drive * y)
      const mix = ss * 4 > 1 ? 1 : ss * 4
      y += (folded - y) * mix
    }
    return y * 0.85
  }

  private tickSprSaw(): number {
    const f = this.freq
    const sr = this.sr
    const cents = 60 * Math.pow(this.shape, 1.3) // detune spread, 0..~60 cents
    const mix = this.shift // side-voice level
    const phases = this.sprPhases
    let sum = 0
    for (let i = 0; i < 7; i++) {
      const det = Math.exp(CENT * SPR_WEIGHTS[i] * cents)
      const dt = (f * det) / sr
      let p = phases[i] + dt
      if (p >= 1) p -= 1
      phases[i] = p
      const s = 2 * p - 1 - polyblep(p, dt)
      sum += i === 3 ? s : mix * s
    }
    return sum * (0.8 / Math.sqrt(1 + 6 * mix * mix))
  }

  private tickPwmCls(): number {
    const f = this.freq
    const sr = this.sr
    const pwBase = 0.1 + 0.8 * this.shape
    const detCents = 12 * this.shift // mutual detune
    let sum = 0
    for (let i = 0; i < 3; i++) {
      let lp = this.pwmLfoPhases[i] + PWM_LFO_RATES[i] / sr
      if (lp >= 1) lp -= 1
      this.pwmLfoPhases[i] = lp
      const pw = clamp(pwBase + 0.12 * Math.sin(TWO_PI * lp), 0.05, 0.95)

      const det = Math.exp(CENT * PWM_DET_WEIGHTS[i] * detCents)
      const dt = (f * det) / sr
      let p = this.pwmPhases[i] + dt
      if (p >= 1) p -= 1
      this.pwmPhases[i] = p

      let v = p < pw ? 1 : -1
      v += polyblep(p, dt)
      let tf = p - pw + 1
      if (tf >= 1) tf -= 1
      v -= polyblep(tf, dt)
      v -= 2 * pw - 1 // remove pulse-width DC
      sum += v
    }
    return sum * 0.3
  }

  private tickOrgan(): number {
    const f = this.freq
    let p = this.organPhase + f / this.sr
    if (p >= 1) p -= 1
    this.organPhase = p

    const m = this.shape // mellow -> bright registration crossfade
    let y = 0
    for (let j = 0; j < 6; j++) {
      const h = ORGAN_H[j]
      if (f * h >= this.nyq) break // harmonics are sorted: band-limit cap
      const a = this.organMellow[j] + (this.organBright[j] - this.organMellow[j]) * m
      y += a * Math.sin(TWO_PI * h * p)
    }
    // percussion click: short decay on the 4th harmonic, retriggered by noteOn
    const ss = this.shift
    if (ss > 0.001 && f * 4 < this.nyq) {
      y += ss * 1.1 * this.organPerc * Math.sin(TWO_PI * 4 * p + 1.3)
    }
    this.organPerc = sane(this.organPerc * this.organPercCoef)
    return y * 0.8
  }

  /* ---------------------------------------------------------- plumbing -- */

  private commitPending(): void {
    this.curType = this.pendType
    this.curSub = this.pendSub
    this.pending = false
    this.refreshDerived()
    this.clearVoiceState()
  }

  private refreshDerived(): void {
    const sub = clamp(this.curSub, 0, 15)
    const c = VPM_TABLE[sub]

    // FEEDBACK trim (curve documented on setVpmTrims). At 0 this is exactly
    // c.fb, so neutral trims reproduce the untrimmed engine bit-for-bit.
    const tf = this.trFb
    const fb = tf >= 0 ? c.fb * (1 + 2 * tf) + 0.4 * tf : c.fb * (1 + tf)
    this.vpmFbEff = fb > VPM_FB_CAP ? VPM_FB_CAP : fb

    // NOISE DEPTH trim over the baked noise-mod amount (0 for every type).
    const tn = this.trNz
    const nz = tn >= 0 ? 0.5 * tn : 0
    this.vpmNzEff = nz > 0 ? nz : 0

    // SHAPE MOD INT trim: internal EG / drift contribution scale, 0..2.
    this.vpmEgAmt = clamp(1 + this.trEg, 0, 2)
    this.vpmDriftAmtEff = c.driftAmt * this.vpmEgAmt

    // MOD ATTACK trim: introduces a mod-index attack (none baked in).
    const ta = this.trAtk
    const atkSec = ta > 0 ? VPM_ATK_REF * (Math.pow(4, ta) - 1) : 0
    this.vpmAtkCoef = atkSec > 0 ? 1 - Math.exp(-1 / (atkSec * this.sr)) : 1

    // MOD DECAY trim: tau * 4^t (Math.pow(4, 0) === 1, neutral is exact).
    let tau = 0
    if (this.curType === MULTI_TYPE.VPM) tau = c.envTau
    if (tau > 0 && this.trDec !== 0) tau *= Math.pow(4, this.trDec)
    this.vpmEnvCoef = tau > 0 ? Math.exp(-1 / (tau * this.sr)) : 1
  }

  /** Reset phases, filters, feedback and internal envelopes/LFOs. */
  private clearVoiceState(): void {
    this.svfIc1 = 0
    this.svfIc2 = 0
    this.decimPhase = 1 // force a fresh S&H sample on the first tick
    this.decimHold = 0

    this.vpmCarPhase = 0
    this.vpmModPhase = 0
    this.vpmMod2Phase = 0
    this.vpmFb1 = 0
    this.vpmFb2 = 0
    this.vpmEnv = 1
    this.vpmAtk = this.vpmAtkCoef >= 1 ? 1 : 0 // no attack trim = snap to 1
    this.vpmDriftPhase = 0

    this.morphPhase = 0
    for (let i = 0; i < 7; i++) this.sprPhases[i] = (i * 0.618034) % 1 // golden spread
    for (let i = 0; i < 3; i++) {
      this.pwmPhases[i] = i / 3
      this.pwmLfoPhases[i] = i / 3
    }
    this.organPhase = 0
    this.organPerc = 1
  }

  /** xorshift32 white noise in [-1, 1). */
  private white(): number {
    let x = this.rngState
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    this.rngState = x
    return x * (2 / 4294967296) - 1
  }
}
