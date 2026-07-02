/*
 * ModFx — minilogue xd style MOD effect section.
 *
 * Types: CHORUS / ENSEMBLE / PHASER / FLANGER / USER, each with the hardware's
 * subtype list. Plain TS class, no DOM / worklet globals; sampleRate is passed
 * to the constructor. All buffers are preallocated — the audio path never
 * allocates.
 *
 * Parameter semantics (all 0..1, smoothed internally):
 *   TIME  — LFO rate / rotary speed / tremolo rate (musical exponential maps).
 *   DEPTH — intensity. For every subtype except CHORUS/VIBRATO and USER/ROTARY,
 *           DEPTH = 0 is (exactly) identity: the wet mix and feedback scale to
 *           zero. VIBRATO is 100% wet, so DEPTH scales only the pitch-mod
 *           amount (DEPTH 0 = clean but ~4.5 ms latent signal). ROTARY is a
 *           full-wet speaker sim; DEPTH acts as mic distance (AM depth,
 *           doppler amount and stereo mic spread), so DEPTH 0 still applies
 *           the crossover/doppler coloration.
 *
 * Click policy:
 *   - setOn() crossfades dry<->wet over ~20 ms (exact identity once faded out).
 *   - setType() fades the effect contribution to zero (~6 ms), resets state,
 *     switches, then fades back in — no sample discontinuities.
 *   - TIME/DEPTH are one-pole smoothed (~15 ms).
 *   - Feedback paths are tanh-limited and denormal/NaN-flushed.
 */

export const MODFX_TYPE = {
  CHORUS: 0,
  ENSEMBLE: 1,
  PHASER: 2,
  FLANGER: 3,
  USER: 4,
} as const

export const MODFX_SUBTYPES: readonly (readonly string[])[] = [
  ['STEREO', 'LIGHT', 'DEEP', 'TRIPHASE', 'HARMONIC', 'MONO', 'FEEDBACK', 'VIBRATO'],
  ['STEREO', 'LIGHT', 'MONO'],
  ['STEREO', 'FAST', 'ORANGE', 'SMALL', 'SM RESO', 'BLACK', 'FORMANT', 'TWINKLE'],
  ['STEREO', 'LIGHT', 'MONO', 'HI SWEEP', 'MID SWEEP', 'PAN SWEEP', 'MONO SWEEP', 'TRIPHASE'],
  ['ROTARY', 'TREM'],
]

const TWO_PI = 2 * Math.PI
const THIRD = 1 / 3
const SIXTH = 1 / 6

// chorus sub-modes
const CH_ST = 0 // stereo (also FEEDBACK via fbBase > 0)
const CH_TRI = 1
const CH_HARM = 2
const CH_MONO = 3
const CH_VIB = 4

// flanger sub-modes
const FL_ST = 0
const FL_MONO = 1
const FL_PAN = 2
const FL_TRI = 3

/** Peterson–Barney-ish male vowel formants (F1,F2,F3) for A,E,I,O,U. */
const FORMANT_F: readonly number[] = [
  730, 1090, 2440, // A
  530, 1840, 2480, // E
  270, 2290, 3010, // I
  570, 840, 2410, // O
  300, 870, 2240, // U
]

/** Flush denormals; also maps NaN/Inf to 0 (comparisons with NaN are false). */
function flushDN(v: number): number {
  return v > 1e-15 || v < -1e-15 ? (v < 1e12 && v > -1e12 ? v : 0) : 0
}

function frac(p: number): number {
  return p - Math.floor(p)
}

/** Smoothed (parabolic) triangle, ph in cycles -> [-1, 1]. String-machine LFO. */
function triShape(ph: number): number {
  const p = ph - Math.floor(ph)
  const t = p < 0.5 ? 4 * p - 1 : 3 - 4 * p
  return t * (2 - Math.abs(t))
}

/** Power-of-two circular buffer with Catmull-Rom (cubic) fractional read. */
class DelayLine {
  private readonly buf: Float32Array
  private readonly mask: number
  private w = 0

  constructor(minSize: number) {
    let n = 16
    while (n < minSize) n <<= 1
    this.buf = new Float32Array(n)
    this.mask = n - 1
  }

  clear(): void {
    this.buf.fill(0)
    this.w = 0
  }

  write(x: number): void {
    this.buf[this.w] = flushDN(x)
    this.w = (this.w + 1) & this.mask
  }

  /** Cubic interpolated read, d samples behind the most recent write. */
  read(d: number): number {
    const mask = this.mask
    let dd = d
    if (!(dd >= 2)) dd = 2 // also catches NaN
    const dMax = mask - 3
    if (dd > dMax) dd = dMax
    const di = Math.floor(dd)
    const f = dd - di
    const b = this.buf
    const i0 = (this.w - 1 - di) & mask
    const xm1 = b[(i0 + 1) & mask]
    const x0 = b[i0]
    const x1 = b[(i0 - 1) & mask]
    const x2 = b[(i0 - 2) & mask]
    const c1 = 0.5 * (x1 - xm1)
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1)
    return ((c3 * f + c2) * f + c1) * f + x0
  }
}

export class ModFx {
  private readonly fs: number
  private readonly msToSamp: number
  private readonly dlA: DelayLine
  private readonly dlB: DelayLine
  private readonly kParam: number // TIME/DEPTH smoothing coefficient
  private readonly kRot: number // rotary speed inertia (~0.9 s)
  private readonly kRotXo: number // rotary 800 Hz crossover coefficient
  private readonly kHarm: number // harmonic-chorus 550 Hz split coefficient
  private readonly swStep: number // type-switch fade step (~6 ms)
  private readonly bypStep: number // bypass fade step (~20 ms)

  private curType = 0
  private curSub = 0
  private pendType = 0
  private pendSub = 0
  private switching = false
  private switchGain = 1
  private bypGain = 1
  private bypTarget = 1

  private timeT = 0.5
  private timeS = 0.5
  private depthT = 0.5
  private depthS = 0.5

  private readonly ph = new Float64Array(2) // LFO phase accumulators
  private readonly ap = new Float64Array(16) // allpass states, L = 0..7, R = 8..15
  private readonly f1 = new Float64Array(4) // one-pole filter states
  private fbL = 0 // phaser feedback memory L
  private fbR = 0
  private rotSpeed = 0.5 // slewed rotary speed (0..1)

  private outL = 0
  private outR = 0

  // ---- per-subtype configuration (written by configure()) ----
  private mode = CH_ST
  private base = 9 // ms — chorus base delay / flanger min delay
  private modMs = 4.5 // ms — chorus LFO depth
  private wetScale = 1
  private fbBase = 0
  private fbDepth = 0
  private roff = 0.25 // R-channel LFO phase offset (cycles)
  private rMin = 0.05 // Hz — rate = rMin * rRatio^time
  private rRatio = 200
  private stages = 6 // phaser stages
  private fMin = 120 // Hz — phaser sweep: fc = fMin * fRatio^lfo01
  private fRatio = 20
  private swRatio = 8 // flanger sweep: delay = base * swRatio^lfo01
  private dScale = 1 // ensemble mod-depth scale

  constructor(sampleRate: number) {
    let fs = sampleRate
    if (!Number.isFinite(fs) || fs <= 0) fs = 48000
    fs = Math.min(192000, Math.max(8000, fs))
    this.fs = fs
    this.msToSamp = fs / 1000
    const size = Math.ceil(0.05 * fs) + 64
    this.dlA = new DelayLine(size)
    this.dlB = new DelayLine(size)
    this.kParam = 1 - Math.exp(-1 / (0.015 * fs))
    this.kRot = 1 - Math.exp(-1 / (0.9 * fs))
    this.kRotXo = 1 - Math.exp((-TWO_PI * 800) / fs)
    this.kHarm = 1 - Math.exp((-TWO_PI * 550) / fs)
    this.swStep = 1 / (0.006 * fs)
    this.bypStep = 1 / (0.02 * fs)
    this.configure()
  }

  /** Select effect type + subtype. Click-free: fade out, reset, fade in. */
  setType(t: number, sub: number): void {
    let ti = Number.isFinite(t) ? Math.floor(t) : 0
    if (ti < 0) ti = 0
    else if (ti > 4) ti = 4
    const nSub = MODFX_SUBTYPES[ti].length
    let si = Number.isFinite(sub) ? Math.floor(sub) : 0
    if (si < 0) si = 0
    else if (si >= nSub) si = nSub - 1
    if (!this.switching && ti === this.curType && si === this.curSub) return
    if (this.switching && ti === this.pendType && si === this.pendSub) return
    this.pendType = ti
    this.pendSub = si
    this.switching = true
  }

  /** TIME knob, 0..1 (rate / rotary speed). Smoothed. */
  setTime(v: number): void {
    if (!Number.isFinite(v)) return
    this.timeT = v < 0 ? 0 : v > 1 ? 1 : v
  }

  /** DEPTH knob, 0..1 (intensity). Smoothed. */
  setDepth(v: number): void {
    if (!Number.isFinite(v)) return
    this.depthT = v < 0 ? 0 : v > 1 ? 1 : v
  }

  /** Bypass with ~20 ms crossfade. Off converges to exact identity. */
  setOn(on: boolean): void {
    this.bypTarget = on ? 1 : 0
  }

  /** Hard reset: clears all audio state, applies pending switch immediately. */
  reset(): void {
    if (this.switching) {
      this.curType = this.pendType
      this.curSub = this.pendSub
      this.switching = false
      this.configure()
    }
    this.resetFxState()
    this.switchGain = 1
    this.bypGain = this.bypTarget
    this.timeS = this.timeT
    this.depthS = this.depthT
  }

  /** In-place stereo block processing. */
  process(l: Float32Array, r: Float32Array, n: number): void {
    let nn = n | 0
    if (nn > l.length) nn = l.length
    if (nn > r.length) nn = r.length
    const kp = this.kParam
    for (let i = 0; i < nn; i++) {
      let xl = l[i]
      let xr = r[i]
      if (!(xl > -1e6 && xl < 1e6)) xl = 0 // NaN/Inf guard
      if (!(xr > -1e6 && xr < 1e6)) xr = 0

      // parameter smoothing (with snap so identity cases become exact)
      let ts = this.timeS + kp * (this.timeT - this.timeS)
      if (ts - this.timeT < 1e-5 && this.timeT - ts < 1e-5) ts = this.timeT
      this.timeS = ts
      let ds = this.depthS + kp * (this.depthT - this.depthS)
      if (ds - this.depthT < 1e-5 && this.depthT - ds < 1e-5) ds = this.depthT
      this.depthS = ds

      // type-switch fade: down -> swap+reset at exactly zero -> up
      if (this.switching) {
        this.switchGain -= this.swStep
        if (this.switchGain <= 0) {
          this.switchGain = 0
          this.curType = this.pendType
          this.curSub = this.pendSub
          this.switching = false
          this.configure()
          this.resetFxState()
        }
      } else if (this.switchGain < 1) {
        this.switchGain += this.swStep
        if (this.switchGain > 1) this.switchGain = 1
      }

      // bypass fade
      if (this.bypGain < this.bypTarget) {
        this.bypGain += this.bypStep
        if (this.bypGain > this.bypTarget) this.bypGain = this.bypTarget
      } else if (this.bypGain > this.bypTarget) {
        this.bypGain -= this.bypStep
        if (this.bypGain < this.bypTarget) this.bypGain = this.bypTarget
      }

      switch (this.curType) {
        case 0:
          this.tickChorus(xl, xr)
          break
        case 1:
          this.tickEnsemble(xl, xr)
          break
        case 2:
          this.tickPhaser(xl, xr)
          break
        case 3:
          this.tickFlanger(xl, xr)
          break
        default:
          if (this.mode === 0) this.tickRotary(xl, xr)
          else this.tickTrem(xl, xr)
          break
      }

      let el = this.outL
      let er = this.outR
      if (!(el > -1e6 && el < 1e6)) el = 0
      if (!(er > -1e6 && er < 1e6)) er = 0
      const g = this.bypGain * this.switchGain
      l[i] = xl + g * (el - xl)
      r[i] = xr + g * (er - xr)
    }
  }

  // ------------------------------------------------------------------ private

  private resetFxState(): void {
    this.dlA.clear()
    this.dlB.clear()
    this.ph.fill(0)
    this.ap.fill(0)
    this.f1.fill(0)
    this.fbL = 0
    this.fbR = 0
    this.rotSpeed = this.timeS // no long spin-up right after a switch
    this.outL = 0
    this.outR = 0
  }

  private configure(): void {
    const t = this.curType
    const s = this.curSub
    this.mode = 0
    this.wetScale = 1
    this.fbBase = 0
    this.fbDepth = 0
    this.roff = 0.25
    this.dScale = 1
    if (t === MODFX_TYPE.CHORUS) {
      this.rMin = 0.05
      this.rRatio = 200 // 0.05 .. 10 Hz
      this.base = 9
      this.modMs = 4.5
      switch (s) {
        case 1: // LIGHT
          this.base = 8
          this.modMs = 1.8
          this.wetScale = 0.65
          break
        case 2: // DEEP
          this.base = 14
          this.modMs = 7
          break
        case 3: // TRIPHASE
          this.mode = CH_TRI
          this.base = 10
          this.modMs = 5
          break
        case 4: // HARMONIC — chorus only the >550 Hz band, lows stay dry
          this.mode = CH_HARM
          this.base = 8
          this.modMs = 3.5
          break
        case 5: // MONO
          this.mode = CH_MONO
          this.modMs = 4
          this.wetScale = 0.9
          break
        case 6: // FEEDBACK
          this.base = 9.5
          this.fbBase = 0.3
          this.fbDepth = 0.3
          break
        case 7: // VIBRATO — 100% wet pitch mod
          this.mode = CH_VIB
          this.base = 4.5
          this.modMs = 3.5
          this.roff = 0
          this.rMin = 0.1
          this.rRatio = 100 // 0.1 .. 10 Hz
          break
        default:
          break // STEREO
      }
    } else if (t === MODFX_TYPE.ENSEMBLE) {
      if (s === 1) {
        // LIGHT
        this.dScale = 0.5
        this.wetScale = 0.7
      } else if (s === 2) {
        this.mode = 1 // MONO
      }
    } else if (t === MODFX_TYPE.PHASER) {
      this.rMin = 0.03
      this.rRatio = 200 // 0.03 .. 6 Hz
      this.stages = 6
      this.fMin = 120
      this.fRatio = 20
      this.fbBase = 0.1
      this.fbDepth = 0.4
      switch (s) {
        case 1: // FAST — fixed faster rate range
          this.stages = 4
          this.fMin = 200
          this.fRatio = 15
          this.rMin = 1.2
          this.rRatio = 12 // 1.2 .. 14.4 Hz
          this.fbDepth = 0.35
          break
        case 2: // ORANGE — 4-stage warm, moderate fb, mono LFO
          this.stages = 4
          this.fMin = 300
          this.fRatio = 5.7
          this.fbBase = 0.25
          this.fbDepth = 0.35
          this.roff = 0
          this.rMin = 0.05
          this.rRatio = 140
          break
        case 3: // SMALL — 2-stage, low fb
          this.stages = 2
          this.fMin = 250
          this.fRatio = 8.8
          this.fbBase = 0.05
          this.fbDepth = 0.15
          this.roff = 0
          this.rMin = 0.05
          this.rRatio = 140
          break
        case 4: // SM RESO — 2-stage, high fb
          this.stages = 2
          this.fMin = 250
          this.fRatio = 8.8
          this.fbBase = 0.45
          this.fbDepth = 0.3
          this.roff = 0
          this.rMin = 0.05
          this.rRatio = 140
          break
        case 5: // BLACK — 6-stage dark sweep
          this.fMin = 70
          this.fRatio = 12.9
          this.fbBase = 0.15
          this.fbDepth = 0.35
          this.rMin = 0.02
          this.rRatio = 200
          break
        case 6: // FORMANT — allpass centers ride A-E-I-O-U morph
          this.mode = 1
          this.fbBase = 0.25
          this.fbDepth = 0.25
          this.roff = 0.12
          this.rMin = 0.03
          this.rRatio = 170
          break
        case 7: // TWINKLE — 8-stage shimmery high range
          this.stages = 8
          this.fMin = 1200
          this.fRatio = 6.25
          this.fbBase = 0.2
          this.fbDepth = 0.3
          this.rMin = 0.05
          this.rRatio = 160
          break
        default:
          break // STEREO (quadrature LFOs)
      }
    } else if (t === MODFX_TYPE.FLANGER) {
      this.rMin = 0.02
      this.rRatio = 250 // 0.02 .. 5 Hz
      this.base = 0.6
      this.swRatio = 5.5 / 0.6
      this.fbBase = 0.45
      switch (s) {
        case 1: // LIGHT — low feedback
          this.fbBase = 0.15
          this.wetScale = 0.7
          break
        case 2: // MONO
          this.mode = FL_MONO
          break
        case 3: // HI SWEEP — restricted upper delay range
          this.base = 0.35
          this.swRatio = 1.4 / 0.35
          this.fbBase = 0.55
          break
        case 4: // MID SWEEP
          this.base = 1.2
          this.swRatio = 3.5 / 1.2
          this.fbBase = 0.5
          break
        case 5: // PAN SWEEP — wet is auto-panned by the sweep LFO
          this.mode = FL_PAN
          break
        case 6: // MONO SWEEP — mono, deepest sweep, hot fb
          this.mode = FL_MONO
          this.base = 0.5
          this.swRatio = 6.5 / 0.5
          this.fbBase = 0.6
          break
        case 7: // TRIPHASE
          this.mode = FL_TRI
          this.base = 0.8
          this.swRatio = 5 / 0.8
          this.fbBase = 0.4
          break
        default:
          break // STEREO (quadrature LFOs)
      }
    } else {
      // USER: 0 = ROTARY, 1 = TREM
      this.mode = s
      this.rMin = 0.5
      this.rRatio = 40 // trem 0.5 .. 20 Hz
    }
  }

  private apCoef(fc: number): number {
    const fs = this.fs
    let f = fc
    if (f < 16) f = 16
    const lim = 0.47 * fs
    if (f > lim) f = lim
    const tn = Math.tan((Math.PI * f) / fs)
    return (tn - 1) / (tn + 1)
  }

  private formantF(m: number, i: number): number {
    const k = m | 0
    const f = m - k
    const a = FORMANT_F[k * 3 + i]
    const b = FORMANT_F[(k + 1) * 3 + i]
    return a + (b - a) * f
  }

  // ---------------------------------------------------------------- CHORUS

  private tickChorus(xl: number, xr: number): void {
    const d = this.depthS
    const rate = this.rMin * Math.pow(this.rRatio, this.timeS)
    const p0 = frac(this.ph[0] + rate / this.fs)
    this.ph[0] = p0
    const ms = this.msToSamp
    const baseS = this.base * ms
    const mode = this.mode
    const modS = this.modMs * ms * (mode === CH_VIB ? d : 0.3 + 0.7 * d)
    const m = Math.min(1, d * 1.35) * this.wetScale

    if (mode === CH_TRI) {
      const xm = 0.5 * (xl + xr)
      const t0 = this.dlA.read(baseS + modS * Math.sin(TWO_PI * p0))
      const t1 = this.dlA.read(baseS + modS * Math.sin(TWO_PI * (p0 + THIRD)))
      const t2 = this.dlA.read(baseS + modS * Math.sin(TWO_PI * (p0 + 2 * THIRD)))
      this.dlA.write(xm)
      const dg = 1 - 0.3 * m
      this.outL = xl * dg + (t0 * 0.75 + t1 * 0.45) * m
      this.outR = xr * dg + (t2 * 0.75 + t1 * 0.45) * m
    } else if (mode === CH_HARM) {
      const k = this.kHarm
      const lpL = this.f1[0] + k * (xl - this.f1[0])
      this.f1[0] = flushDN(lpL)
      const lpR = this.f1[1] + k * (xr - this.f1[1])
      this.f1[1] = flushDN(lpR)
      const hL = xl - lpL
      const hR = xr - lpR
      const tL = this.dlA.read(baseS + modS * Math.sin(TWO_PI * p0))
      const tR = this.dlB.read(baseS + modS * Math.sin(TWO_PI * (p0 + this.roff)))
      this.dlA.write(hL)
      this.dlB.write(hR)
      // lows stay dry; highs partially replaced by their chorused copy
      this.outL = xl - 0.45 * m * hL + 0.8 * m * tL
      this.outR = xr - 0.45 * m * hR + 0.8 * m * tR
    } else if (mode === CH_MONO) {
      const xm = 0.5 * (xl + xr)
      const tp = this.dlA.read(baseS + modS * Math.sin(TWO_PI * p0))
      this.dlA.write(xm)
      const dg = 1 - 0.3 * m
      this.outL = xl * dg + tp * 0.8 * m
      this.outR = xr * dg + tp * 0.8 * m
    } else if (mode === CH_VIB) {
      const dly = baseS + modS * Math.sin(TWO_PI * p0)
      const tL = this.dlA.read(dly)
      const tR = this.dlB.read(dly)
      this.dlA.write(xl)
      this.dlB.write(xr)
      this.outL = tL // 100% wet
      this.outR = tR
    } else {
      // STEREO / LIGHT / DEEP / FEEDBACK
      const tL = this.dlA.read(baseS + modS * Math.sin(TWO_PI * p0))
      const tR = this.dlB.read(baseS + modS * Math.sin(TWO_PI * (p0 + this.roff)))
      let fbk = 0
      if (this.fbBase > 0) {
        fbk = this.fbBase + this.fbDepth * d
        if (fbk > 0.7) fbk = 0.7
      }
      this.dlA.write(xl + (fbk > 0 ? fbk * Math.tanh(tL) : 0))
      this.dlB.write(xr + (fbk > 0 ? fbk * Math.tanh(tR) : 0))
      const dg = 1 - 0.3 * m
      this.outL = xl * dg + tL * 0.8 * m
      this.outR = xr * dg + tR * 0.8 * m
    }
  }

  // -------------------------------------------------------------- ENSEMBLE

  private tickEnsemble(xl: number, xr: number): void {
    const fs = this.fs
    const d = this.depthS
    // two simultaneous string-machine rates, both scaled by TIME (x0.5..x2)
    const sc = 0.5 * Math.pow(4, this.timeS)
    const p0 = frac(this.ph[0] + (0.55 * sc) / fs) // chorale (slow, deep)
    const p1 = frac(this.ph[1] + (5.9 * sc) / fs) // vibrato (fast, shallow)
    this.ph[0] = p0
    this.ph[1] = p1
    const ms = this.msToSamp
    const xm = 0.5 * (xl + xr)
    const dAmt = 0.3 + 0.7 * d
    const dsl = 2.6 * ms * this.dScale * dAmt
    const dfa = 0.28 * ms * this.dScale * dAmt
    const baseS = 6 * ms
    const mono = this.mode === 1
    let wl = 0
    let wr = 0
    for (let v = 0; v < 3; v++) {
      const ps = p0 + v * THIRD
      const pf = p1 + v * THIRD
      wl += this.dlA.read(baseS + dsl * triShape(ps) + dfa * triShape(pf))
      if (!mono) {
        wr += this.dlA.read(baseS + dsl * triShape(ps + SIXTH) + dfa * triShape(pf + SIXTH))
      }
    }
    this.dlA.write(xm)
    wl *= 0.38
    wr = mono ? wl : wr * 0.38
    const m = Math.min(1, d * 1.25) * this.wetScale
    const dg = 1 - 0.35 * m
    this.outL = xl * dg + wl * 0.95 * m
    this.outR = xr * dg + wr * 0.95 * m
  }

  // ---------------------------------------------------------------- PHASER

  private tickPhaser(xl: number, xr: number): void {
    const d = this.depthS
    const rate = this.rMin * Math.pow(this.rRatio, this.timeS)
    const p0 = frac(this.ph[0] + rate / this.fs)
    this.ph[0] = p0
    const lfoL = 0.5 + 0.5 * Math.sin(TWO_PI * p0)
    const lfoR = 0.5 + 0.5 * Math.sin(TWO_PI * (p0 + this.roff))
    let fbk = this.fbBase + this.fbDepth * d
    if (fbk > 0.75) fbk = 0.75
    const mix = 0.5 * Math.min(1, d * 1.6)
    const nSt = this.stages
    const ap = this.ap

    let aL0: number
    let aL1: number
    let aL2: number
    let aR0: number
    let aR1: number
    let aR2: number
    if (this.mode === 1) {
      // FORMANT: three allpass pairs ride the vowel formants
      const mL = lfoL * 3.999
      const mR = lfoR * 3.999
      aL0 = this.apCoef(this.formantF(mL, 0))
      aL1 = this.apCoef(this.formantF(mL, 1))
      aL2 = this.apCoef(this.formantF(mL, 2))
      aR0 = this.apCoef(this.formantF(mR, 0))
      aR1 = this.apCoef(this.formantF(mR, 1))
      aR2 = this.apCoef(this.formantF(mR, 2))
    } else {
      aL0 = this.apCoef(this.fMin * Math.pow(this.fRatio, lfoL))
      aL1 = aL0
      aL2 = aL0
      aR0 = this.apCoef(this.fMin * Math.pow(this.fRatio, lfoR))
      aR1 = aR0
      aR2 = aR0
    }

    let vL = xl + fbk * Math.tanh(this.fbL)
    for (let s = 0; s < nSt; s++) {
      const a = (s >> 1) === 0 ? aL0 : (s >> 1) === 1 ? aL1 : aL2
      const y = a * vL + ap[s]
      ap[s] = flushDN(vL - a * y)
      vL = y
    }
    this.fbL = flushDN(vL)

    let vR = xr + fbk * Math.tanh(this.fbR)
    for (let s = 0; s < nSt; s++) {
      const a = (s >> 1) === 0 ? aR0 : (s >> 1) === 1 ? aR1 : aR2
      const y = a * vR + ap[8 + s]
      ap[8 + s] = flushDN(vR - a * y)
      vR = y
    }
    this.fbR = flushDN(vR)

    this.outL = xl * (1 - mix) + vL * mix
    this.outR = xr * (1 - mix) + vR * mix
  }

  // --------------------------------------------------------------- FLANGER

  private tickFlanger(xl: number, xr: number): void {
    const d = this.depthS
    const rate = this.rMin * Math.pow(this.rRatio, this.timeS)
    const p0 = frac(this.ph[0] + rate / this.fs)
    this.ph[0] = p0
    const ms = this.msToSamp
    const lfoL = 0.5 + 0.5 * Math.sin(TWO_PI * p0)
    let fbk = this.fbBase * (0.25 + 0.75 * d)
    if (fbk > 0.72) fbk = 0.72
    const wet = 0.75 * Math.min(1, d * 1.3) * this.wetScale
    const dg = 1 - 0.3 * wet
    const mode = this.mode

    if (mode === FL_TRI) {
      const xm = 0.5 * (xl + xr)
      const l0 = 0.5 + 0.5 * Math.sin(TWO_PI * p0)
      const l1 = 0.5 + 0.5 * Math.sin(TWO_PI * (p0 + THIRD))
      const l2 = 0.5 + 0.5 * Math.sin(TWO_PI * (p0 + 2 * THIRD))
      const t0 = this.dlA.read(ms * this.base * Math.pow(this.swRatio, l0))
      const t1 = this.dlA.read(ms * this.base * Math.pow(this.swRatio, l1))
      const t2 = this.dlA.read(ms * this.base * Math.pow(this.swRatio, l2))
      this.dlA.write(xm + fbk * Math.tanh((t0 + t1 + t2) * THIRD))
      this.outL = xl * dg + (t0 * 0.8 + t1 * 0.45) * wet
      this.outR = xr * dg + (t2 * 0.8 + t1 * 0.45) * wet
    } else if (mode === FL_MONO) {
      const xm = 0.5 * (xl + xr)
      const tp = this.dlA.read(ms * this.base * Math.pow(this.swRatio, lfoL))
      this.dlA.write(xm + fbk * Math.tanh(tp))
      this.outL = xl * dg + tp * wet
      this.outR = xr * dg + tp * wet
    } else if (mode === FL_PAN) {
      const xm = 0.5 * (xl + xr)
      const tp = this.dlA.read(ms * this.base * Math.pow(this.swRatio, lfoL))
      this.dlA.write(xm + fbk * Math.tanh(tp))
      const gl = Math.cos(0.5 * Math.PI * lfoL)
      const gr = Math.sin(0.5 * Math.PI * lfoL)
      this.outL = xl * dg + tp * wet * 1.35 * gl
      this.outR = xr * dg + tp * wet * 1.35 * gr
    } else {
      // STEREO / LIGHT / HI SWEEP / MID SWEEP (quadrature LFOs)
      const lfoR = 0.5 + 0.5 * Math.sin(TWO_PI * (p0 + this.roff))
      const tL = this.dlA.read(ms * this.base * Math.pow(this.swRatio, lfoL))
      const tR = this.dlB.read(ms * this.base * Math.pow(this.swRatio, lfoR))
      this.dlA.write(xl + fbk * Math.tanh(tL))
      this.dlB.write(xr + fbk * Math.tanh(tR))
      this.outL = xl * dg + tL * wet
      this.outR = xr * dg + tR * wet
    }
  }

  // -------------------------------------------------------------- USER FX

  private tickRotary(xl: number, xr: number): void {
    const fs = this.fs
    // rotor speed inertia (~0.9 s slew between slow and fast)
    const sp = this.rotSpeed + this.kRot * (this.timeS - this.rotSpeed)
    this.rotSpeed = sp
    const hornHz = 0.7 * Math.pow(9.71, sp) // 0.7 .. 6.8 Hz
    const drumHz = 0.6 * Math.pow(9.5, sp) // 0.6 .. 5.7 Hz
    const p0 = frac(this.ph[0] + hornHz / fs)
    const p1 = frac(this.ph[1] - drumHz / fs) // opposite direction
    this.ph[0] = p0
    this.ph[1] = p1

    const xm = 0.5 * (xl + xr)
    const k = this.kRotXo
    const lp = this.f1[2] + k * (xm - this.f1[2])
    this.f1[2] = flushDN(lp)
    const hi = xm - lp

    const d = this.depthS // mic distance / intensity
    const off = 0.1 + 0.15 * d // stereo mic angle (cycles)
    const ms = this.msToSamp
    const dopH = ms * (0.08 + 0.42 * d)
    const dopD = ms * (0.04 + 0.16 * d)
    const amH = 0.25 + 0.45 * d
    const amD = 0.1 + 0.22 * d
    const baseD = 4 * ms

    const phl = TWO_PI * (p0 + off)
    const phr = TWO_PI * (p0 - off)
    const hL = this.dlA.read(baseD + dopH * Math.sin(phl)) * (1 - amH * (0.5 + 0.5 * Math.cos(phl)))
    const hR = this.dlA.read(baseD + dopH * Math.sin(phr)) * (1 - amH * (0.5 + 0.5 * Math.cos(phr)))
    const pdl = TWO_PI * (p1 - off)
    const pdr = TWO_PI * (p1 + off)
    const dL = this.dlB.read(baseD + dopD * Math.sin(pdl)) * (1 - amD * (0.5 + 0.5 * Math.cos(pdl)))
    const dR = this.dlB.read(baseD + dopD * Math.sin(pdr)) * (1 - amD * (0.5 + 0.5 * Math.cos(pdr)))
    this.dlA.write(hi)
    this.dlB.write(lp)

    const ch = 1 + 0.45 * amH // loudness makeup for the AM dip
    const cd = 1 + 0.3 * amD
    this.outL = hL * ch + dL * cd
    this.outR = hR * ch + dR * cd
  }

  private tickTrem(xl: number, xr: number): void {
    const rate = this.rMin * Math.pow(this.rRatio, this.timeS)
    const p0 = frac(this.ph[0] + rate / this.fs)
    this.ph[0] = p0
    const d = this.depthS
    // sine -> square-ish chop as depth rises
    const k = 1 + 7 * d * d
    const inv = 1 / Math.tanh(k)
    const sL = Math.tanh(k * Math.sin(TWO_PI * p0)) * inv
    const sR = Math.tanh(k * Math.sin(TWO_PI * (p0 + 0.25))) * inv // auto-pan offset
    const gL = 1 - d * (0.5 + 0.5 * sL)
    const gR = 1 - d * (0.5 + 0.5 * sR)
    this.outL = xl * gL
    this.outR = xr * gR
  }
}
