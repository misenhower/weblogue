/*
 * LfComp — the prologue-16's analog L.F. COMP (low-frequency compressor/
 * booster), last in the output chain (prologue-spec.md §7): one GAIN knob +
 * ON/OFF + a gain-reduction VU. Stereo, in-place block processing; plain TS
 * class (no DOM / worklet globals), preallocated state, no audio-thread
 * allocation.
 *
 * UNCONFIRMED model (no prologue hardware owned — spec §17 lists "L.F. COMP
 * character (threshold/ratio/makeup vs pure boost — one GAIN knob)" as a
 * calibration target). Our voicing, chosen so the knob "thickens without
 * runaway":
 *   - one-pole crossover ~150 Hz splits the low band (complementary
 *     low + high = input, so the neutral state is exact);
 *   - the GAIN knob applies upward low-band gain 0..+12 dB INTO a soft-knee
 *     compressor (threshold -6 dBFS on the boosted lows, ratio 4:1, 6 dB
 *     knee, peak envelope follower ~10 ms attack / ~100 ms release) — hot
 *     signals at high gain compress instead of clipping;
 *   - bands recombine after the low-band gain stage; ON/OFF crossfades
 *     (~20 ms) with an exact bypass once fully off.
 * Every constant above is UNCONFIRMED voicing.
 *
 * `grLevel` exposes the current gain reduction 0..1 (0 = none, 1 = full
 * ~12 dB scale deflection) for the panel VU.
 */

const TWO_PI = Math.PI * 2

/** Crossover corner (UNCONFIRMED). */
const XOVER_HZ = 150
/** Max low-band boost at GAIN = 1, in dB (UNCONFIRMED). */
const MAX_BOOST_DB = 12
/** Compressor threshold on the boosted low band, dBFS (UNCONFIRMED). */
const THRESH_DB = -6
/** Compression ratio (UNCONFIRMED). */
const RATIO = 4
/** Soft-knee width in dB (UNCONFIRMED). */
const KNEE_DB = 6
/** Envelope follower time constants (UNCONFIRMED). */
const ATTACK_SEC = 0.01
const RELEASE_SEC = 0.1
/** VU full-scale gain reduction in dB. */
const GR_FULL_DB = 12

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0
}

export class LfComp {
  // crossover state
  private lpL = 0
  private lpR = 0
  private readonly lpCoef: number

  // envelope follower (peak, on the boosted low band)
  private env = 0
  private readonly attCoef: number
  private readonly relCoef: number

  // knob (smoothed linear boost)
  private boostT = 1
  private boostC = 1
  private readonly smooth: number

  // on/off crossfade
  private on = false
  private onF = 0
  private readonly onStep: number

  /** Current gain reduction 0..1 (VU): 0 = none, 1 = GR_FULL_DB. */
  grLevel = 0

  constructor(sampleRate: number) {
    const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
    this.lpCoef = 1 - Math.exp((-TWO_PI * XOVER_HZ) / sr)
    this.attCoef = 1 - Math.exp(-1 / (ATTACK_SEC * sr))
    this.relCoef = 1 - Math.exp(-1 / (RELEASE_SEC * sr))
    this.smooth = 1 - Math.exp(-1 / (0.008 * sr))
    this.onStep = 1 / (0.02 * sr)
  }

  /** GAIN knob 0..1 -> low-band upward gain 0..MAX_BOOST_DB. */
  setGain(amount01: number): void {
    const a = clamp01(amount01)
    this.boostT = Math.pow(10, (a * MAX_BOOST_DB) / 20)
  }

  setOn(on: boolean): void {
    this.on = on === true
  }

  reset(): void {
    this.lpL = 0
    this.lpR = 0
    this.env = 0
    this.boostC = this.boostT
    this.onF = this.on ? 1 : 0
    this.grLevel = 0
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    const onTgt = this.on ? 1 : 0
    if (!this.on && this.onF <= 0) {
      this.grLevel = 0
      return // exact bypass
    }

    const kLp = this.lpCoef
    const sm = this.smooth
    let grDb = 0

    for (let i = 0; i < n; i++) {
      let inL = l[i]
      let inR = r[i]
      // NaN/Inf guard: a bad sample hard-clears the filter/env state.
      if (!(inL > -1e12 && inL < 1e12) || !(inR > -1e12 && inR < 1e12)) {
        inL = 0
        inR = 0
        this.lpL = 0
        this.lpR = 0
        this.env = 0
      }

      // ---- fades / smoothing -------------------------------------------
      if (this.onF !== onTgt) {
        this.onF += this.onF < onTgt ? this.onStep : -this.onStep
        if (this.onF > 1) this.onF = 1
        else if (this.onF < 0) this.onF = 0
      }
      this.boostC += sm * (this.boostT - this.boostC)

      // ---- complementary one-pole crossover ------------------------------
      this.lpL += kLp * (inL - this.lpL)
      this.lpR += kLp * (inR - this.lpR)
      const highL = inL - this.lpL
      const highR = inR - this.lpR
      const bstL = this.lpL * this.boostC
      const bstR = this.lpR * this.boostC

      // ---- peak envelope on the boosted lows -----------------------------
      const aL = bstL < 0 ? -bstL : bstL
      const aR = bstR < 0 ? -bstR : bstR
      const det = aL > aR ? aL : aR
      this.env += (det > this.env ? this.attCoef : this.relCoef) * (det - this.env)
      if (this.env < 1e-20) this.env = 0

      // ---- soft-knee downward compression (dB domain) --------------------
      const envDb = 20 * Math.log10(this.env + 1e-12)
      const over = envDb - THRESH_DB
      if (over <= -KNEE_DB / 2) {
        grDb = 0
      } else if (over < KNEE_DB / 2) {
        const t = over + KNEE_DB / 2
        grDb = ((t * t) / (2 * KNEE_DB)) * (1 - 1 / RATIO)
      } else {
        grDb = over * (1 - 1 / RATIO)
      }
      const g = grDb > 0 ? Math.pow(10, -grDb / 20) : 1

      // ---- recombine + on/off crossfade ----------------------------------
      const wetL = bstL * g + highL
      const wetR = bstR * g + highR
      const of = this.onF
      l[i] = inL + of * (wetL - inL)
      r[i] = inR + of * (wetR - inR)
    }

    // snap the boost smoother so a settled state is bit-exact
    if (Math.abs(this.boostC - this.boostT) < 1e-6) this.boostC = this.boostT
    // flush denormal-ish crossover state
    if (this.lpL < 1e-20 && this.lpL > -1e-20) this.lpL = 0
    if (this.lpR < 1e-20 && this.lpR > -1e-20) this.lpR = 0

    this.grLevel = Math.min(1, grDb / GR_FULL_DB)
  }
}
