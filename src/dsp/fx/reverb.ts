/*
 * ReverbFx — minilogue xd style REVERB section (stereo, in-place block
 * processing).
 *
 * Core: 8-line FDN with Hadamard mixing. Each line has a modulated read tap
 * (~0.3–1 Hz, a few samples — kills metallic ringing), a one-pole damping
 * lowpass and a decay gain derived from the RT60. The mono input goes through
 * a predelay and 2–4 input-diffusion allpasses before being distributed to
 * the lines; stereo output comes from two decorrelated tap patterns.
 *
 * Subtypes (hardware order): HALL, SMOOTH, ARENA, PLATE, ROOM, EARLY REF,
 * SPACE, RISER, SUBMARINE, HORROR. Character comes from a per-type config
 * table (size, predelay, damping, diffusion, modulation, shimmer):
 *   HALL      — big, warm damping.
 *   SMOOTH    — heavier diffusion, softer attack.
 *   ARENA     — very big, ~60 ms predelay.
 *   PLATE     — bright, dense, minimal predelay.
 *   ROOM      — small, early-heavy, short.
 *   EARLY REF — multitap early reflections only, no tail.
 *   SPACE     — huge, slow-modulated, airy.
 *   RISER     — shimmer: cheap dual-head granular octave-UP shifter in the
 *               feedback path at low mix (per docs/xd-spec.md).
 *   SUBMARINE — octave-DOWN shifter, dark (~900 Hz damping).
 *   HORROR    — long tail with deep pitch-wobble modulation.
 *
 * Parameters: TIME 0..1 -> RT60 ~0.3 s..12 s (exponential, per-type scaled;
 * for EARLY REF it scales the reflection spread). DEPTH = wet level.
 * DRY/WET = final balance (0.5 = balanced, 0 = fully dry — exact identity,
 * 1 = fully wet). setOn() crossfades (~20 ms); fully-off is an exact bypass.
 *
 * Plain TS class, sampleRate as constructor arg, everything preallocated —
 * no allocation in the audio path. NaN/Inf hard-clears the tank; denormals
 * are flushed at every line write.
 */

export const REVERB_SUBTYPES: readonly string[] = [
  'HALL',
  'SMOOTH',
  'ARENA',
  'PLATE',
  'ROOM',
  'EARLY REF',
  'SPACE',
  'RISER',
  'SUBMARINE',
  'HORROR',
]

const NL = 8
const TWO_PI = Math.PI * 2

/** Mutually-prime-ish base line delays in ms (scaled per type by `size`). */
const LINE_MS: readonly number[] = [31.7, 37.3, 41.9, 47.3, 53.7, 59.3, 67.9, 73.1]
const MAX_SIZE = 2.0
const MAX_MOD = 64 // samples, must cover the deepest wobble (HORROR)

/** Input distribution and stereo output tap patterns (decorrelated). */
const IN_G: readonly number[] = [0.35, -0.35, 0.35, -0.35, 0.35, 0.35, -0.35, -0.35]
const OUT_L: readonly number[] = [0.38, -0.32, 0.3, -0.26, 0.34, -0.3, 0.26, -0.22]
const OUT_R: readonly number[] = [-0.26, 0.3, 0.38, -0.34, 0.22, 0.34, -0.3, -0.26]

/** Per-line modulation rate/depth spread multipliers + phase offsets. */
const MOD_RATE_MUL: readonly number[] = [1.0, 1.13, 0.91, 1.27, 0.83, 1.41, 0.77, 1.19]
const MOD_DEPTH_MUL: readonly number[] = [1.0, 0.9, 1.1, 0.85, 1.05, 0.95, 1.15, 0.8]

/** Input diffusion allpass lengths (ms) and early-reflection tap tables. */
const AP_MS: readonly number[] = [5.3, 8.9, 12.7, 15.1]
const ER_MS_L: readonly number[] = [11, 17, 23, 31, 43, 59, 71, 89]
const ER_MS_R: readonly number[] = [13, 19, 29, 37, 47, 61, 79, 97]
const ER_G: readonly number[] = [1, 0.84, 0.72, 0.6, 0.5, 0.42, 0.34, 0.27]
const ER_MAX_SCALE = 2.0

interface RevCfg {
  size: number
  preMs: number
  dampHz: number
  rtScale: number
  diffN: number
  diffG: number
  modRate: number // Hz
  modDepth: number // samples
  shim: number // 0 = none, +1 = octave up, -1 = octave down
  shimMix: number
  er: boolean
}

function rcfg(p: Partial<RevCfg>): RevCfg {
  return {
    size: 1,
    preMs: 10,
    dampHz: 5000,
    rtScale: 1,
    diffN: 3,
    diffG: 0.68,
    modRate: 0.5,
    modDepth: 3,
    shim: 0,
    shimMix: 0,
    er: false,
    ...p,
  }
}

const REVERB_CFG: readonly RevCfg[] = [
  rcfg({ size: 1.4, preMs: 20, dampHz: 4500 }), // HALL
  rcfg({ size: 1.2, preMs: 25, dampHz: 3800, diffN: 4, diffG: 0.75, modRate: 0.45, modDepth: 3.5 }), // SMOOTH
  rcfg({ size: 1.9, preMs: 60, dampHz: 4200, rtScale: 1.25, modRate: 0.4 }), // ARENA
  rcfg({ size: 0.9, preMs: 4, dampHz: 9500, rtScale: 0.9, diffN: 4, diffG: 0.72, modRate: 0.8, modDepth: 2.5 }), // PLATE
  rcfg({ size: 0.55, preMs: 8, dampHz: 6000, rtScale: 0.5, diffN: 2, diffG: 0.6, modRate: 0.7, modDepth: 2 }), // ROOM
  rcfg({ er: true, preMs: 0 }), // EARLY REF
  rcfg({ size: 2.0, preMs: 30, dampHz: 9000, rtScale: 1.5, modRate: 0.15, modDepth: 8 }), // SPACE
  rcfg({ size: 1.3, preMs: 20, dampHz: 6500, rtScale: 1.1, shim: 1, shimMix: 0.35 }), // RISER
  rcfg({ size: 1.15, preMs: 25, dampHz: 900, shim: -1, shimMix: 0.35, modRate: 0.4 }), // SUBMARINE
  rcfg({ size: 1.5, preMs: 40, dampHz: 3200, rtScale: 1.3, modRate: 1.1, modDepth: 45 }), // HORROR
]

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0
}

export class ReverbFx {
  private readonly sr: number

  // FDN lines
  private readonly lines: Float32Array[] = []
  private readonly lineLen: Int32Array
  private readonly lineW: Int32Array
  private readonly delaySamp: Float64Array
  private readonly decay: Float64Array
  private readonly dampState: Float64Array
  private dampCoef = 0.5

  // per-line modulation
  private readonly modPhase: Float64Array
  private readonly modInc: Float64Array
  private readonly modDepth: Float64Array

  // scratch vectors (no allocation in the audio path)
  private readonly y: Float64Array
  private readonly h: Float64Array

  // predelay
  private readonly preBuf: Float32Array
  private preW = 0
  private preDel = 0

  // input diffusion allpasses
  private readonly apBuf: Float32Array[] = []
  private readonly apLen: Int32Array
  private readonly apIdx: Int32Array

  // early reflections (EARLY REF type)
  private readonly erBuf: Float32Array
  private erW = 0
  private readonly erDelL: Int32Array
  private readonly erDelR: Int32Array

  // shimmer (RISER / SUBMARINE)
  private readonly shimBuf: Float32Array
  private readonly shimLen: number
  private shimW = 0
  private shimP = 0

  // parameters
  private sub = 0
  private conf: RevCfg = REVERB_CFG[0]
  private timeKnob = 0.5
  private depth = 0.5
  private dryWet = 0.5
  private on = true

  // smoothed gains + fades
  private dryT = 1
  private dryC = 1
  private wetT = 0.5
  private wetC = 0.5
  private readonly smooth: number
  private onF = 1
  private readonly onStep: number
  private typeF = 1
  private readonly typeStep: number
  private pendingSub = -1
  private clearPending = false
  private primed = false

  constructor(sampleRate: number) {
    this.sr = sampleRate
    this.lineLen = new Int32Array(NL)
    this.lineW = new Int32Array(NL)
    this.delaySamp = new Float64Array(NL)
    this.decay = new Float64Array(NL)
    this.dampState = new Float64Array(NL)
    this.modPhase = new Float64Array(NL)
    this.modInc = new Float64Array(NL)
    this.modDepth = new Float64Array(NL)
    this.y = new Float64Array(NL)
    this.h = new Float64Array(NL)
    for (let k = 0; k < NL; k++) {
      const len = Math.ceil((LINE_MS[k] * MAX_SIZE * sampleRate) / 1000) + MAX_MOD + 8
      this.lines.push(new Float32Array(len))
      this.lineLen[k] = len
    }
    this.preBuf = new Float32Array(Math.ceil(0.1 * sampleRate) + 2)
    this.apLen = new Int32Array(AP_MS.length)
    this.apIdx = new Int32Array(AP_MS.length)
    for (let a = 0; a < AP_MS.length; a++) {
      const len = Math.max(2, Math.round((AP_MS[a] * sampleRate) / 1000))
      this.apBuf.push(new Float32Array(len))
      this.apLen[a] = len
    }
    this.erBuf = new Float32Array(
      Math.ceil((ER_MS_R[ER_MS_R.length - 1] * ER_MAX_SCALE * sampleRate) / 1000) + 8,
    )
    this.erDelL = new Int32Array(NL)
    this.erDelR = new Int32Array(NL)
    this.shimLen = Math.max(256, Math.floor(0.09 * sampleRate))
    this.shimBuf = new Float32Array(this.shimLen)
    this.smooth = 1 - Math.exp(-1 / (0.008 * sampleRate))
    this.onStep = 1 / (0.02 * sampleRate)
    this.typeStep = 1 / (0.006 * sampleRate)
    this.applyConfig()
    this.reset()
  }

  setSubType(s: number): void {
    const idx = Math.min(
      REVERB_SUBTYPES.length - 1,
      Math.max(0, Math.floor(Number.isFinite(s) ? s : 0)),
    )
    if (idx === this.sub && this.pendingSub < 0) return
    if (!this.primed) {
      this.sub = idx
      this.applyConfig()
    } else {
      this.pendingSub = idx
    }
  }

  setTime(v: number): void {
    this.timeKnob = clamp01(v)
    this.updateDecay()
  }

  setDepth(v: number): void {
    this.depth = clamp01(v)
    this.updateGainTargets()
  }

  setDryWet(v: number): void {
    this.dryWet = clamp01(v)
    this.updateGainTargets()
  }

  setOn(on: boolean): void {
    if (on && !this.on && this.onF <= 0) this.clearPending = true
    this.on = on
  }

  reset(): void {
    for (let k = 0; k < NL; k++) this.lines[k].fill(0)
    this.lineW.fill(0)
    this.dampState.fill(0)
    for (let a = 0; a < this.apBuf.length; a++) this.apBuf[a].fill(0)
    this.apIdx.fill(0)
    this.preBuf.fill(0)
    this.preW = 0
    this.erBuf.fill(0)
    this.erW = 0
    this.shimBuf.fill(0)
    this.shimW = 0
    this.shimP = 0
    this.modPhase.fill(0)
    for (let k = 0; k < NL; k++) this.modPhase[k] = k * 0.7853
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

    const sm = this.smooth
    const onTgt = this.on ? 1 : 0

    for (let i = 0; i < n; i++) {
      const conf = this.conf
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

      const inL = l[i]
      const inR = r[i]
      const m = 0.5 * (inL + inR)
      let wetL: number
      let wetR: number

      if (this.conf.er) {
        // ---- EARLY REF: multitap reflections, no tail --------------------
        const eb = this.erBuf
        const elen = eb.length
        eb[this.erW] = m
        let sl = 0
        let srr = 0
        for (let j = 0; j < NL; j++) {
          let pl = this.erW - this.erDelL[j]
          if (pl < 0) pl += elen
          let pr = this.erW - this.erDelR[j]
          if (pr < 0) pr += elen
          sl += ER_G[j] * eb[pl]
          srr += ER_G[j] * eb[pr]
        }
        this.erW++
        if (this.erW >= elen) this.erW = 0
        wetL = 0.5 * sl
        wetR = 0.5 * srr
      } else {
        // ---- predelay ----------------------------------------------------
        const pb = this.preBuf
        const plen = pb.length
        pb[this.preW] = m
        let pr = this.preW - this.preDel
        if (pr < 0) pr += plen
        let x = pb[pr]
        this.preW++
        if (this.preW >= plen) this.preW = 0

        // ---- input diffusion (series allpasses) --------------------------
        const dn = conf.diffN
        const dg = conf.diffG
        for (let a = 0; a < dn; a++) {
          const buf = this.apBuf[a]
          const idx = this.apIdx[a]
          const z = buf[idx]
          let u = x + dg * z
          if (u < 1e-20 && u > -1e-20) u = 0
          buf[idx] = u
          x = z - dg * u
          const ni = idx + 1
          this.apIdx[a] = ni >= this.apLen[a] ? 0 : ni
        }

        // ---- modulated line reads ----------------------------------------
        const y = this.y
        for (let k = 0; k < NL; k++) {
          let ph = this.modPhase[k] + this.modInc[k]
          if (ph > TWO_PI) ph -= TWO_PI
          this.modPhase[k] = ph
          const d = this.delaySamp[k] + this.modDepth[k] * Math.sin(ph)
          const line = this.lines[k]
          const len = this.lineLen[k]
          let p = this.lineW[k] - d
          if (p < 0) p += len
          let i0 = p | 0
          const frac = p - i0
          if (i0 >= len) i0 -= len
          let i1 = i0 + 1
          if (i1 >= len) i1 = 0
          const a = line[i0]
          y[k] = a + frac * (line[i1] - a)
        }

        wetL =
          OUT_L[0] * y[0] + OUT_L[1] * y[1] + OUT_L[2] * y[2] + OUT_L[3] * y[3] +
          OUT_L[4] * y[4] + OUT_L[5] * y[5] + OUT_L[6] * y[6] + OUT_L[7] * y[7]
        wetR =
          OUT_R[0] * y[0] + OUT_R[1] * y[1] + OUT_R[2] * y[2] + OUT_R[3] * y[3] +
          OUT_R[4] * y[4] + OUT_R[5] * y[5] + OUT_R[6] * y[6] + OUT_R[7] * y[7]

        // ---- Hadamard mix (fast Walsh-Hadamard, normalized) --------------
        const h = this.h
        let a0 = y[0] + y[1]
        let a1 = y[0] - y[1]
        let a2 = y[2] + y[3]
        let a3 = y[2] - y[3]
        let a4 = y[4] + y[5]
        let a5 = y[4] - y[5]
        let a6 = y[6] + y[7]
        let a7 = y[6] - y[7]
        let b0 = a0 + a2
        let b1 = a1 + a3
        let b2 = a0 - a2
        let b3 = a1 - a3
        let b4 = a4 + a6
        let b5 = a5 + a7
        let b6 = a4 - a6
        let b7 = a5 - a7
        const nrm = 0.35355339059327373 // 1/sqrt(8)
        h[0] = (b0 + b4) * nrm
        h[1] = (b1 + b5) * nrm
        h[2] = (b2 + b6) * nrm
        h[3] = (b3 + b7) * nrm
        h[4] = (b0 - b4) * nrm
        h[5] = (b1 - b5) * nrm
        h[6] = (b2 - b6) * nrm
        h[7] = (b3 - b7) * nrm

        // ---- shimmer (octave up/down granular shifter in feedback) ------
        let shimOut = 0
        if (conf.shim !== 0) {
          const sb = this.shimBuf
          const W = this.shimLen
          const sIn = 0.25 * (y[0] + y[1] + y[2] + y[3] + y[4] + y[5] + y[6] + y[7])
          sb[this.shimW] = sIn < 1e-20 && sIn > -1e-20 ? 0 : sIn
          // two read heads, half-buffer apart, Hann windows summing to 1
          let p = this.shimP
          p += conf.shim > 0 ? -1 : 0.5 // up: read 2x (delay shrinks 1/spl)
          if (p < 0) p += W
          else if (p >= W) p -= W
          this.shimP = p
          let p2 = p + W / 2
          if (p2 >= W) p2 -= W
          shimOut =
            this.shimRead(p) * (0.5 - 0.5 * Math.cos((TWO_PI * p) / W)) +
            this.shimRead(p2) * (0.5 - 0.5 * Math.cos((TWO_PI * p2) / W))
          this.shimW++
          if (this.shimW >= W) this.shimW = 0
          shimOut *= conf.shimMix
        }

        // ---- damping + decay + write back --------------------------------
        const dc = this.dampCoef
        for (let k = 0; k < NL; k++) {
          let v = h[k] * this.decay[k]
          const ds = this.dampState[k] + dc * (v - this.dampState[k])
          this.dampState[k] = ds
          v = ds + (x + shimOut) * IN_G[k]
          if (!(v > -1e6 && v < 1e6)) {
            // NaN/Inf/runaway guard: hard-clear the tank
            this.hardClear()
            v = 0
          } else if (v < 1e-20 && v > -1e-20) {
            v = 0
          }
          const line = this.lines[k]
          const wIdx = this.lineW[k]
          line[wIdx] = v
          const nw = wIdx + 1
          this.lineW[k] = nw >= this.lineLen[k] ? 0 : nw
        }
      }

      // ---- output mix -----------------------------------------------------
      const wg = this.wetC * this.typeF
      const effL = this.dryC * inL + wg * wetL
      const effR = this.dryC * inR + wg * wetR
      const of = this.onF
      l[i] = inL + of * (effL - inL)
      r[i] = inR + of * (effR - inR)
    }

    if (Math.abs(this.dryC - this.dryT) < 1e-4) this.dryC = this.dryT
    if (Math.abs(this.wetC - this.wetT) < 1e-4) this.wetC = this.wetT
    for (let k = 0; k < NL; k++) {
      const ds = this.dampState[k]
      if (ds < 1e-20 && ds > -1e-20) this.dampState[k] = 0
    }
  }

  // -------------------------------------------------------------------------

  private shimRead(delay: number): number {
    const W = this.shimLen
    let p = this.shimW - 1 - delay
    if (p < 0) p += W
    let i0 = p | 0
    const frac = p - i0
    if (i0 >= W) i0 -= W
    else if (i0 < 0) i0 = 0
    let i1 = i0 + 1
    if (i1 >= W) i1 = 0
    const a = this.shimBuf[i0]
    return a + frac * (this.shimBuf[i1] - a)
  }

  private applyConfig(): void {
    const c = REVERB_CFG[this.sub]
    this.conf = c
    this.dampCoef = 1 - Math.exp((-TWO_PI * c.dampHz) / this.sr)
    this.preDel = Math.min(
      this.preBuf.length - 2,
      Math.round((c.preMs * this.sr) / 1000),
    )
    for (let k = 0; k < NL; k++) {
      const d = (LINE_MS[k] * c.size * this.sr) / 1000
      const maxD = this.lineLen[k] - MAX_MOD - 4
      this.delaySamp[k] = Math.min(maxD, Math.max(16, d))
      this.modInc[k] = (TWO_PI * c.modRate * MOD_RATE_MUL[k]) / this.sr
      this.modDepth[k] = Math.min(MAX_MOD, c.modDepth * MOD_DEPTH_MUL[k])
    }
    this.updateDecay()
    this.updateGainTargets()
  }

  private updateDecay(): void {
    const c = this.conf
    if (c.er) {
      // TIME scales the reflection spread
      const scale = 0.4 + 1.6 * this.timeKnob
      const max = this.erBuf.length - 2
      for (let j = 0; j < NL; j++) {
        this.erDelL[j] = Math.min(max, Math.max(1, Math.round((ER_MS_L[j] * scale * this.sr) / 1000)))
        this.erDelR[j] = Math.min(max, Math.max(1, Math.round((ER_MS_R[j] * scale * this.sr) / 1000)))
      }
      return
    }
    // RT60 ~0.3 s .. 12 s exponential, per-type scaled
    const rt = 0.3 * Math.pow(40, this.timeKnob) * c.rtScale
    for (let k = 0; k < NL; k++) {
      const t = this.delaySamp[k] / this.sr
      this.decay[k] = Math.pow(10, (-3 * t) / rt)
    }
  }

  private updateGainTargets(): void {
    const wetBal = Math.min(1, 2 * this.dryWet)
    const dryBal = Math.min(1, 2 * (1 - this.dryWet))
    this.wetT = wetBal * this.depth
    this.dryT = dryBal
  }

  private doSwitch(): void {
    this.sub = this.pendingSub
    this.pendingSub = -1
    this.hardClear()
    this.applyConfig()
  }

  private prime(): void {
    this.dryC = this.dryT
    this.wetC = this.wetT
    this.onF = this.on ? 1 : 0
    this.primed = true
  }

  private hardClear(): void {
    for (let k = 0; k < NL; k++) this.lines[k].fill(0)
    this.dampState.fill(0)
    for (let a = 0; a < this.apBuf.length; a++) this.apBuf[a].fill(0)
    this.preBuf.fill(0)
    this.erBuf.fill(0)
    this.shimBuf.fill(0)
  }
}
