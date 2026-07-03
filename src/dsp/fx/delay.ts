/*
 * DelayFx — minilogue xd style DELAY section (stereo, in-place block processing).
 *
 * Plain TS class: no DOM / worklet globals; sampleRate is a constructor arg.
 * All buffers are preallocated — the audio path never allocates.
 *
 * Subtypes (hardware order): STEREO, MONO, PING PONG, HIPASS, TAPE, ONE TAP,
 * ST.BPM, MONO BPM, PING BPM, HIPASS BPM, TAPE BPM, DOUBLING.
 *
 * Parameter semantics:
 *   TIME   0..1 — free types map exponentially 1 ms .. 1400 ms; BPM types
 *          quantize to divisions of the current BPM
 *          [1/64, 1/32, 1/16T, 1/16, 1/8T, 1/16D, 1/8, 1/4T, 1/8D, 1/4,
 *           1/2T, 1/4D, 1/2, 3/4, 1/1] spread evenly across the knob.
 *          DOUBLING maps 30..90 ms slap.
 *   DEPTH  0..1 — wet level = depth; feedback = min(0.9, depth*0.85)
 *          except ONE TAP / DOUBLING (no feedback). DOUBLING mixes the wet
 *          tap near unity for thickening.
 *   DRYWET 0..1 — final balance (SHIFT+DEPTH). 0.5 = balanced (dry and wet
 *          both at full), 0 = fully dry (exact identity), 1 = fully wet.
 *
 * Click policy:
 *   - Time changes crossfade between two read taps (~30 ms) for clean types;
 *     TAPE types instead slew the read position (authentic pitch bend).
 *   - setOn() crossfades over ~20 ms; fully-off is an exact bypass.
 *   - setSubType() fades the wet signal out (~6 ms), resets, switches, fades in.
 *   - DEPTH / DRYWET / feedback gains are one-pole smoothed.
 *
 * Character:
 *   - Gentle one-pole lowpass ~9 kHz in the feedback path on every type
 *     (analog-ish darkening) except DOUBLING (full band).
 *   - HIPASS: ~600 Hz one-pole highpass in the loop.
 *   - TAPE: tanh saturation + wow (~0.5 Hz) / flutter (~6 Hz) read modulation
 *     + ~5 kHz lowpass in the loop.
 *   - STEREO: +/-3 % L/R time offset. MONO: summed input, centered.
 *   - PING PONG: cross-fed L->R->L. ONE TAP: single echo. DOUBLING: 30..90 ms
 *     slap with slight (+/-2 %) width.
 *
 * NaN/Inf are guarded per sample (a bad value hard-clears the loop state) and
 * denormals are flushed at the write point.
 */

export const DELAY_SUBTYPES: readonly string[] = [
  'STEREO',
  'MONO',
  'PING PONG',
  'HIPASS',
  'TAPE',
  'ONE TAP',
  'ST.BPM',
  'MONO BPM',
  'PING BPM',
  'HIPASS BPM',
  'TAPE BPM',
  'DOUBLING',
]

/** BPM divisions as fractions of a whole note (240/bpm seconds). */
const BPM_DIVISIONS: readonly number[] = [
  1 / 64, // 1/64
  1 / 32, // 1/32
  1 / 24, // 1/16T
  1 / 16, // 1/16
  1 / 12, // 1/8T
  3 / 32, // 1/16D
  1 / 8, // 1/8
  1 / 6, // 1/4T
  3 / 16, // 1/8D
  1 / 4, // 1/4
  1 / 3, // 1/2T
  3 / 8, // 1/4D
  1 / 2, // 1/2
  3 / 4, // 3/4
  1, // 1/1
]

const TOPO_STEREO = 0
const TOPO_MONO = 1
const TOPO_PING = 2

interface DelayCfg {
  topo: number
  bpmSync: boolean
  doubling: boolean
  tape: boolean
  hipass: boolean
  feedback: boolean
  /** relative L/R spread, L = t*(1-spread), R = t*(1+spread) */
  spread: number
  /** loop lowpass cutoff in Hz; 0 = full band */
  lpHz: number
}

function cfg(
  topo: number,
  bpmSync: boolean,
  opts: Partial<DelayCfg> = {},
): DelayCfg {
  return {
    topo,
    bpmSync,
    doubling: false,
    tape: false,
    hipass: false,
    feedback: true,
    spread: 0,
    lpHz: 9000,
    ...opts,
  }
}

const DELAY_CFG: readonly DelayCfg[] = [
  cfg(TOPO_STEREO, false, { spread: 0.03 }), // STEREO
  cfg(TOPO_MONO, false), // MONO
  cfg(TOPO_PING, false), // PING PONG
  cfg(TOPO_STEREO, false, { hipass: true }), // HIPASS
  cfg(TOPO_STEREO, false, { tape: true, lpHz: 5000 }), // TAPE
  cfg(TOPO_STEREO, false, { feedback: false }), // ONE TAP
  cfg(TOPO_STEREO, true, { spread: 0.03 }), // ST.BPM
  cfg(TOPO_MONO, true), // MONO BPM
  cfg(TOPO_PING, true), // PING BPM
  cfg(TOPO_STEREO, true, { hipass: true }), // HIPASS BPM
  cfg(TOPO_STEREO, true, { tape: true, lpHz: 5000 }), // TAPE BPM
  cfg(TOPO_STEREO, false, {
    doubling: true,
    feedback: false,
    spread: 0.02,
    lpHz: 0,
  }), // DOUBLING
]

const MAX_DELAY_SEC = 4.0
const MIN_DELAY_SEC = 0.001
const TWO_PI = Math.PI * 2

function nextPow2(n: number): number {
  let p = 1
  while (p < n) p <<= 1
  return p
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0
}

export class DelayFx {
  private readonly sr: number
  private readonly bufL: Float32Array
  private readonly bufR: Float32Array
  private readonly mask: number
  private readonly maxDelaySamp: number
  private w = 0

  // parameters
  private sub = 0
  private conf: DelayCfg = DELAY_CFG[0]
  private timeKnob = 0.5
  private depth = 0.5
  private dryWet = 0.5
  private bpm = 120
  private on = true

  // smoothed gains
  private dryT = 1
  private dryC = 1
  private wetT = 0.5
  private wetC = 0.5
  private fbT = 0
  private fbC = 0
  private readonly smooth: number

  // on/off + type fades
  private onF = 1
  private readonly onStep: number
  private typeF = 1
  private readonly typeStep: number
  private pendingSub = -1
  private clearPending = false

  // read taps (samples). A = active, B = crossfade target.
  private tgtL = 0
  private tgtR = 0
  private dLA = 0
  private dRA = 0
  private dLB = 0
  private dRB = 0
  private xf = 0
  private xfActive = false
  private readonly xfStep: number
  private readonly tapeSlew: number

  // loop filters
  private lpL = 0
  private lpR = 0
  private lpCoef = 0
  private hpL = 0
  private hpR = 0
  private hpCoef: number
  private hpHz = 600
  /** Loop gain override (OG-style dedicated FEEDBACK knob); -1 = derive from depth. */
  private fbOverride = -1

  // tape wow/flutter
  private wowPh = 0
  private flutPh = 0
  private readonly wowInc: number
  private readonly flutInc: number

  private primed = false

  constructor(sampleRate: number) {
    this.sr = sampleRate
    const len = nextPow2(Math.ceil(MAX_DELAY_SEC * sampleRate) + 8)
    this.bufL = new Float32Array(len)
    this.bufR = new Float32Array(len)
    this.mask = len - 1
    this.maxDelaySamp = MAX_DELAY_SEC * sampleRate
    this.smooth = 1 - Math.exp(-1 / (0.008 * sampleRate))
    this.onStep = 1 / (0.02 * sampleRate)
    this.typeStep = 1 / (0.006 * sampleRate)
    this.xfStep = 1 / (0.03 * sampleRate)
    this.tapeSlew = 1 - Math.exp(-1 / (0.12 * sampleRate))
    this.hpCoef = 1 - Math.exp((-TWO_PI * this.hpHz) / sampleRate)
    this.wowInc = (TWO_PI * 0.5) / sampleRate
    this.flutInc = (TWO_PI * 6) / sampleRate
    this.applyConfig()
    this.updateTargets()
    this.reset()
  }

  setSubType(s: number): void {
    const idx = Math.min(
      DELAY_SUBTYPES.length - 1,
      Math.max(0, Math.floor(Number.isFinite(s) ? s : 0)),
    )
    if (idx === this.sub && this.pendingSub < 0) return
    if (!this.primed) {
      this.sub = idx
      this.applyConfig()
      this.updateTargets()
    } else {
      this.pendingSub = idx
    }
  }

  setTime(v: number): void {
    this.timeKnob = clamp01(v)
    this.updateTargets()
  }

  setDepth(v: number): void {
    this.depth = clamp01(v)
    this.updateGainTargets()
  }

  setDryWet(v: number): void {
    this.dryWet = clamp01(v)
    this.updateGainTargets()
  }

  /**
   * Direct loop gain 0..1.06 (a dedicated FEEDBACK knob, decoupled from
   * DEPTH; >1 self-oscillates, bounded by loop saturation). Pass a negative
   * value to return to the xd-style depth-derived feedback.
   */
  setFeedback(g: number): void {
    if (!Number.isFinite(g)) return
    this.fbOverride = g < 0 ? -1 : g > 1.06 ? 1.06 : g
    this.updateGainTargets()
  }

  /** Loop highpass cutoff in Hz (types with hipass: true). */
  setHipassHz(hz: number): void {
    if (!Number.isFinite(hz)) return
    this.hpHz = hz < 10 ? 10 : hz > 8000 ? 8000 : hz
    this.hpCoef = 1 - Math.exp((-TWO_PI * this.hpHz) / this.sr)
  }

  setBpm(bpm: number): void {
    this.bpm = Number.isFinite(bpm) ? Math.min(300, Math.max(10, bpm)) : 120
    if (this.conf.bpmSync) this.updateTargets()
  }

  setOn(on: boolean): void {
    if (on && !this.on && this.onF <= 0) this.clearPending = true
    this.on = on
  }

  reset(): void {
    this.bufL.fill(0)
    this.bufR.fill(0)
    this.w = 0
    this.lpL = this.lpR = 0
    this.hpL = this.hpR = 0
    this.wowPh = 0
    this.flutPh = 0
    this.xf = 0
    this.xfActive = false
    this.typeF = 1
    this.pendingSub = -1
    this.clearPending = false
    this.primed = false
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    if (!this.on && this.onF <= 0) return // exact bypass
    if (!this.primed) this.prime()
    if (this.clearPending) {
      this.hardClear()
      this.clearPending = false
    }

    const bufL = this.bufL
    const bufR = this.bufR
    const mask = this.mask
    const sm = this.smooth
    const onTgt = this.on ? 1 : 0

    for (let i = 0; i < n; i++) {
      // re-read per sample: a mid-block subtype switch must not use stale flags
      const conf = this.conf
      const topo = conf.topo
      const tape = conf.tape
      const hip = conf.hipass
      const lpOn = this.lpCoef > 0
      // ---- fades / smoothing -------------------------------------------
      if (this.onF !== onTgt) {
        this.onF += this.onF < onTgt ? this.onStep : -this.onStep
        if (this.onF > 1) this.onF = 1
        else if (this.onF < 0) this.onF = 0
      }
      if (this.pendingSub >= 0) {
        this.typeF -= this.typeStep
        if (this.typeF <= 0) {
          this.typeF = 0
          this.doSwitch()
        }
      } else if (this.typeF < 1) {
        this.typeF += this.typeStep
        if (this.typeF > 1) this.typeF = 1
      }
      this.dryC += sm * (this.dryT - this.dryC)
      this.wetC += sm * (this.wetT - this.wetC)
      this.fbC += sm * (this.fbT - this.fbC)

      // ---- read taps ----------------------------------------------------
      let dL: number
      let dR: number
      if (tape) {
        // slewed read position (pitch-bend artifacts) + wow/flutter
        this.dLA += this.tapeSlew * (this.tgtL - this.dLA)
        this.dRA += this.tapeSlew * (this.tgtR - this.dRA)
        this.wowPh += this.wowInc
        if (this.wowPh > TWO_PI) this.wowPh -= TWO_PI
        this.flutPh += this.flutInc
        if (this.flutPh > TWO_PI) this.flutPh -= TWO_PI
        const wobL =
          1 +
          0.002 * Math.sin(this.wowPh) +
          0.0004 * Math.sin(this.flutPh)
        const wobR =
          1 +
          0.002 * Math.sin(this.wowPh + 1.7) +
          0.0004 * Math.sin(this.flutPh + 2.3)
        dL = this.dLA * wobL
        dR = this.dRA * wobR
        if (dL < 2) dL = 2
        if (dR < 2) dR = 2
      } else {
        dL = this.dLA
        dR = this.dRA
      }

      let yL: number
      let yR: number
      if (!tape && this.xfActive) {
        this.xf += this.xfStep
        let x = this.xf
        if (x >= 1) {
          x = 1
          this.dLA = this.dLB
          this.dRA = this.dRB
          this.xf = 0
          this.xfActive = false
        }
        yL =
          this.readTap(bufL, dL) * (1 - x) + this.readTap(bufL, this.dLB) * x
        yR =
          this.readTap(bufR, dR) * (1 - x) + this.readTap(bufR, this.dRB) * x
        if (!this.xfActive) this.checkRetarget()
      } else {
        yL = this.readTap(bufL, dL)
        yR = this.readTap(bufR, dR)
        if (!tape && !this.xfActive) this.checkRetarget()
      }

      // NaN/Inf guard on the loop signal
      if (!(yL > -1e12 && yL < 1e12) || !(yR > -1e12 && yR < 1e12)) {
        this.hardClear()
        yL = 0
        yR = 0
      }

      // ---- feedback filtering -------------------------------------------
      let fL = yL
      let fR = yR
      if (lpOn) {
        this.lpL += this.lpCoef * (fL - this.lpL)
        this.lpR += this.lpCoef * (fR - this.lpR)
        fL = this.lpL
        fR = this.lpR
      }

      // ---- write --------------------------------------------------------
      const inL = l[i]
      const inR = r[i]
      const fb = this.fbC
      // Near/over-unity loops saturate instead of running away (tanh ~
      // identity at low level, so engaging it below the threshold is silent).
      const sat = tape || fb > 0.95
      let wetL: number
      let wetR: number
      if (topo === TOPO_MONO) {
        let x = 0.5 * (inL + inR) + fb * fL
        if (hip) {
          this.hpL += this.hpCoef * (x - this.hpL)
          x -= this.hpL
        }
        if (sat) x = Math.tanh(x)
        if (x < 1e-20 && x > -1e-20) x = 0
        bufL[this.w] = x
        bufR[this.w] = x
        wetL = yL
        wetR = yL
      } else if (topo === TOPO_PING) {
        const m = 0.5 * (inL + inR)
        let xL = m + fb * fR // cross-feedback R -> L
        let xR = fb * fL // L -> R
        if (hip) {
          this.hpL += this.hpCoef * (xL - this.hpL)
          xL -= this.hpL
          this.hpR += this.hpCoef * (xR - this.hpR)
          xR -= this.hpR
        }
        if (sat) {
          xL = Math.tanh(xL)
          xR = Math.tanh(xR)
        }
        if (xL < 1e-20 && xL > -1e-20) xL = 0
        if (xR < 1e-20 && xR > -1e-20) xR = 0
        bufL[this.w] = xL
        bufR[this.w] = xR
        wetL = yL
        wetR = yR
      } else {
        let xL = inL + fb * fL
        let xR = inR + fb * fR
        if (hip) {
          this.hpL += this.hpCoef * (xL - this.hpL)
          xL -= this.hpL
          this.hpR += this.hpCoef * (xR - this.hpR)
          xR -= this.hpR
        }
        if (sat) {
          xL = Math.tanh(xL)
          xR = Math.tanh(xR)
        }
        if (xL < 1e-20 && xL > -1e-20) xL = 0
        if (xR < 1e-20 && xR > -1e-20) xR = 0
        bufL[this.w] = xL
        bufR[this.w] = xR
        wetL = yL
        wetR = yR
      }
      this.w = (this.w + 1) & mask

      // ---- output mix -----------------------------------------------------
      const wg = this.wetC * this.typeF
      const effL = this.dryC * inL + wg * wetL
      const effR = this.dryC * inR + wg * wetR
      const of = this.onF
      l[i] = inL + of * (effL - inL)
      r[i] = inR + of * (effR - inR)
    }

    // snap smoothers so a settled state is bit-exact
    if (Math.abs(this.dryC - this.dryT) < 1e-4) this.dryC = this.dryT
    if (Math.abs(this.wetC - this.wetT) < 1e-4) this.wetC = this.wetT
    if (Math.abs(this.fbC - this.fbT) < 1e-4) this.fbC = this.fbT
    // flush denormal-ish filter state
    if (this.lpL < 1e-20 && this.lpL > -1e-20) this.lpL = 0
    if (this.lpR < 1e-20 && this.lpR > -1e-20) this.lpR = 0
    if (this.hpL < 1e-20 && this.hpL > -1e-20) this.hpL = 0
    if (this.hpR < 1e-20 && this.hpR > -1e-20) this.hpR = 0
  }

  // -------------------------------------------------------------------------

  private readTap(buf: Float32Array, delay: number): number {
    const p = this.w - delay
    let i0 = Math.floor(p)
    const frac = p - i0
    i0 += buf.length // buffer len is pow2 >= max delay + margin
    const a = buf[i0 & this.mask]
    const b = buf[(i0 + 1) & this.mask]
    return a + frac * (b - a)
  }

  private applyConfig(): void {
    this.conf = DELAY_CFG[this.sub]
    this.lpCoef =
      this.conf.lpHz > 0
        ? 1 - Math.exp((-TWO_PI * this.conf.lpHz) / this.sr)
        : 0
    this.updateGainTargets()
  }

  private updateGainTargets(): void {
    const wetBal = Math.min(1, 2 * this.dryWet)
    const dryBal = Math.min(1, 2 * (1 - this.dryWet))
    const lvl = this.conf.doubling
      ? Math.min(1, this.depth * 1.3) // near-unity slap for thickening
      : this.depth
    this.wetT = wetBal * lvl
    this.dryT = dryBal
    this.fbT = this.conf.feedback
      ? this.fbOverride >= 0
        ? this.fbOverride
        : Math.min(0.9, this.depth * 0.85)
      : 0
  }

  private updateTargets(): void {
    const c = this.conf
    let t: number
    if (c.doubling) {
      t = 0.03 + 0.06 * this.timeKnob
    } else if (c.bpmSync) {
      const idx = Math.min(
        BPM_DIVISIONS.length - 1,
        Math.floor(this.timeKnob * BPM_DIVISIONS.length),
      )
      t = (BPM_DIVISIONS[idx] * 240) / this.bpm
    } else {
      t = MIN_DELAY_SEC * Math.pow(1400, this.timeKnob)
    }
    if (t < MIN_DELAY_SEC) t = MIN_DELAY_SEC
    if (t > MAX_DELAY_SEC) t = MAX_DELAY_SEC
    const base = t * this.sr
    const lim = this.maxDelaySamp
    let dl = base * (1 - c.spread)
    let dr = base * (1 + c.spread)
    if (dl < 8) dl = 8
    if (dl > lim) dl = lim
    if (dr < 8) dr = 8
    if (dr > lim) dr = lim
    this.tgtL = dl
    this.tgtR = dr
    if (!this.primed) {
      this.dLA = dl
      this.dRA = dr
      this.dLB = dl
      this.dRB = dr
      this.xf = 0
      this.xfActive = false
    }
  }

  private checkRetarget(): void {
    if (
      Math.abs(this.tgtL - this.dLA) > 0.5 ||
      Math.abs(this.tgtR - this.dRA) > 0.5
    ) {
      this.dLB = this.tgtL
      this.dRB = this.tgtR
      this.xf = 0
      this.xfActive = true
    }
  }

  private doSwitch(): void {
    this.sub = this.pendingSub
    this.pendingSub = -1
    this.applyConfig()
    this.hardClear()
    this.primed = false // snap taps to the new targets
    this.updateTargets()
    this.primed = true
  }

  private prime(): void {
    this.dryC = this.dryT
    this.wetC = this.wetT
    this.fbC = this.fbT
    this.dLA = this.dLB = this.tgtL
    this.dRA = this.dRB = this.tgtR
    this.xf = 0
    this.xfActive = false
    this.onF = this.on ? 1 : 0
    this.primed = true
  }

  private hardClear(): void {
    this.bufL.fill(0)
    this.bufR.fill(0)
    this.lpL = this.lpR = 0
    this.hpL = this.hpR = 0
  }
}
