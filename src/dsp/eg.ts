/*
 * Envelope generators for the minilogue xd replica.
 *
 * Plain TS classes — no DOM, no worklet globals. sampleRate is injected.
 * No allocation on the audio path; all state is scalar.
 *
 * Analog-style shapes:
 *  - Attack is a fast-charging exponential aiming ABOVE 1.0 (target ~1.3) so
 *    the segment is clipped at 1.0 while the curve is still steep — the punchy
 *    RC "capacitor charge" shape of the hardware. The attack coefficient is
 *    scaled so the level hits 1.0 in exactly the displayed attack time.
 *  - Decay/release are true exponentials toward their target with a time
 *    constant of displayedTime/3, i.e. the displayed time corresponds to
 *    ~3 time constants (~95% settled), matching typical analog EG spec.
 *  - MEASURED xd alternative (D5, 2026-07-12): the real xd runs its fall
 *    segments as a CONSTANT-RATE LINEAR phase raised to a power (p = 3.00
 *    across the whole knob range, RMS 0.2 dB vs capture) that reaches TRUE
 *    ZERO at the table time T. setFallPower(p) switches decay/release to
 *    that model; null (default) keeps the legacy exponential bit-identical
 *    for og/mono/prologue and xd profiles v0-v4. Sustain > 0 decay tracking
 *    under the cubic model is INFERRED (phase ramps to sustain^(1/p); only
 *    sustain = 0 was measured).
 *  - Changing times mid-segment only swaps the one-pole coefficient; the
 *    level continues from its current value, so changes are click-free.
 *  - gateOn always (re)starts the attack FROM THE CURRENT LEVEL, never from
 *    zero, so retriggering during release cannot click.
 */

const ATTACK_TARGET = 1.3
// time-to-reach-1.0 (in time constants) when charging toward ATTACK_TARGET:
// solve 1 = T*(1 - e^-x)  =>  x = ln(T / (T - 1))
const ATTACK_TC_RATIO = Math.log(ATTACK_TARGET / (ATTACK_TARGET - 1)) // ~1.4663
const DECAY_TC_RATIO = 3 // displayed time = 3 time constants

const MIN_TIME = 0.0005
const MAX_TIME = 20
const KILL_TIME = 0.0015 // fast linear ramp for voice stealing
const SILENCE = 1e-4 // -80 dB: snap to 0 / idle below this
const FLUSH = 1e-9 // denormal flush distance from segment target

// stages
const S_IDLE = 0
const S_ATTACK = 1
const S_DECAY = 2 // includes sustain: one-pole keeps tracking the sustain rail
const S_RELEASE = 3
const S_KILL = 4

function clampTime(sec: number): number {
  if (!Number.isFinite(sec)) return MIN_TIME
  return sec < MIN_TIME ? MIN_TIME : sec > MAX_TIME ? MAX_TIME : sec
}

function clamp01(v: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback
  return v < 0 ? 0 : v > 1 ? 1 : v
}

export class AdsrEg {
  private readonly sr: number
  private readonly killRate: number
  private stage = S_IDLE
  private lvl = 0
  private sus = 1
  private aCoef = 0
  private dCoef = 0
  private rCoef = 0
  /** measured-fall model: null = legacy exponential (bit-identical) */
  private fallPow: number | null = null
  private phase = 0
  private phaseSus = 1
  private dRate = 0
  private rRate = 0

  constructor(sampleRate: number) {
    this.sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
    this.killRate = 1 / (KILL_TIME * this.sr)
    this.setAttack(0.002)
    this.setDecay(0.1)
    this.setSustain(1)
    this.setRelease(0.05)
  }

  /** one-pole coefficient for a given time constant (seconds) */
  private coef(tau: number): number {
    return 1 - Math.exp(-1 / (tau * this.sr))
  }

  setAttack(sec: number): void {
    this.aCoef = this.coef(clampTime(sec) / ATTACK_TC_RATIO)
  }

  setDecay(sec: number): void {
    this.dCoef = this.coef(clampTime(sec) / DECAY_TC_RATIO)
    this.dRate = 1 / (clampTime(sec) * this.sr)
  }

  setSustain(level: number): void {
    this.sus = clamp01(level, this.sus)
    const p = this.fallPow
    this.phaseSus = p === null ? this.sus : Math.pow(this.sus, 1 / p)
  }

  setRelease(sec: number): void {
    this.rCoef = this.coef(clampTime(sec) / DECAY_TC_RATIO)
    this.rRate = 1 / (clampTime(sec) * this.sr)
  }

  /**
   * Switch the fall segments to the measured linear-phase^p model (times
   * become time-to-zero), or back to the legacy exponential with null.
   * Safe mid-note: the phase is re-derived from the current level.
   */
  setFallPower(p: number | null): void {
    if (p !== null && (!Number.isFinite(p) || p <= 0)) p = null
    this.fallPow = p
    if (p !== null) {
      this.phase = Math.pow(Math.max(0, this.lvl), 1 / p)
      this.phaseSus = Math.pow(this.sus, 1 / p)
    }
  }

  /**
   * retrigger=true (default): restart the attack segment from the CURRENT
   * level (no reset to zero, no click). retrigger=false: legato — if the
   * envelope is still in attack/decay/sustain it just keeps going; if it was
   * releasing (or idle/killed) it re-enters attack from the current level.
   *
   * fromZero=true (with retrigger): HARD-RESET the level to zero before the
   * attack — the monologue's multi-trigger behavior (monologue-spec.md §5/§14:
   * "the envelope is reset to zero — an uncomfortable silence with a slow
   * attack"). The xd/og keep the default restart-from-current-level.
   */
  gateOn(retrigger: boolean = true, fromZero: boolean = false): void {
    if (retrigger) {
      if (fromZero) this.lvl = 0
      this.stage = S_ATTACK
    } else if (this.stage === S_IDLE || this.stage === S_RELEASE || this.stage === S_KILL) {
      this.stage = S_ATTACK
    }
    // else: legato while attack/decay running — continue untouched
  }

  gateOff(): void {
    if (this.stage !== S_IDLE && this.stage !== S_KILL) {
      const p = this.fallPow
      if (p !== null && this.stage !== S_RELEASE) {
        // measured model: the linear phase resumes from the current level
        this.phase = Math.pow(Math.max(0, this.lvl), 1 / p)
      }
      this.stage = S_RELEASE
    }
  }

  /** ~1.5 ms linear ramp to 0 for voice stealing, then idle. */
  kill(): void {
    if (this.stage === S_IDLE && this.lvl === 0) return
    this.stage = S_KILL
  }

  reset(): void {
    this.stage = S_IDLE
    this.lvl = 0
    this.phase = 0
  }

  tick(): number {
    let l = this.lvl
    if (!Number.isFinite(l)) {
      // self-heal: never propagate NaN/Inf into the audio path
      l = 0
      this.stage = S_IDLE
    }
    const p = this.fallPow
    switch (this.stage) {
      case S_ATTACK:
        l += this.aCoef * (ATTACK_TARGET - l)
        if (l >= 1) {
          l = 1
          this.stage = S_DECAY
          this.phase = 1 // full-scale entry for the measured-fall model
        }
        break
      case S_DECAY: {
        if (p !== null) {
          // constant-rate linear phase toward the sustain phase, level = phase^p
          let ph = this.phase
          const ps = this.phaseSus
          if (ph > ps) {
            ph -= this.dRate
            if (ph < ps) ph = ps
          } else if (ph < ps) {
            ph += this.dRate
            if (ph > ps) ph = ps
          }
          this.phase = ph
          l = p === 3 ? ph * ph * ph : Math.pow(ph, p)
          break
        }
        const s = this.sus
        l += this.dCoef * (s - l)
        if (l - s < FLUSH && s - l < FLUSH) l = s // flush denormal residue
        break
      }
      case S_RELEASE:
        if (p !== null) {
          // constant-rate linear phase to TRUE ZERO at the table time
          const ph = this.phase - this.rRate
          if (ph <= 0) {
            this.phase = 0
            l = 0
            this.stage = S_IDLE
          } else {
            this.phase = ph
            l = p === 3 ? ph * ph * ph : Math.pow(ph, p)
          }
          break
        }
        l -= this.rCoef * l
        if (l < SILENCE) {
          l = 0
          this.stage = S_IDLE
        }
        break
      case S_KILL:
        l -= this.killRate
        if (l <= 0) {
          l = 0
          this.stage = S_IDLE
        }
        break
      default:
        l = 0
        break
    }
    this.lvl = l
    return l
  }

  get active(): boolean {
    return this.stage !== S_IDLE
  }

  get level(): number {
    return this.lvl
  }
}

/**
 * The xd's modulation EG: Attack-Decay, no sustain.
 *
 * gateOff() is a documented NO-OP: on the hardware the AD envelope always
 * completes its full attack+decay cycle regardless of gate length (even a
 * very long attack keeps rising after note-off), so we simply let it run.
 */
export class AdEg {
  private readonly sr: number
  private stage = S_IDLE
  private lvl = 0
  private aCoef = 0
  private dCoef = 0
  /** measured-fall model: null = legacy exponential (bit-identical) */
  private fallPow: number | null = null
  private phase = 0
  private dRate = 0

  constructor(sampleRate: number) {
    this.sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
    this.setAttack(0.002)
    this.setDecay(0.1)
  }

  private coef(tau: number): number {
    return 1 - Math.exp(-1 / (tau * this.sr))
  }

  setAttack(sec: number): void {
    this.aCoef = this.coef(clampTime(sec) / ATTACK_TC_RATIO)
  }

  setDecay(sec: number): void {
    this.dCoef = this.coef(clampTime(sec) / DECAY_TC_RATIO)
    this.dRate = 1 / (clampTime(sec) * this.sr)
  }

  /** Same measured linear-phase^p fall as AdsrEg.setFallPower (INFERRED for
   *  the mod EG: the amp EG was the measured one; same firmware generator). */
  setFallPower(p: number | null): void {
    if (p !== null && (!Number.isFinite(p) || p <= 0)) p = null
    this.fallPow = p
    if (p !== null) this.phase = Math.pow(Math.max(0, this.lvl), 1 / p)
  }

  /**
   * retrigger=true (default): restart attack from the current level.
   * retrigger=false: legato — only starts a cycle if the envelope is idle.
   */
  gateOn(retrigger: boolean = true): void {
    if (retrigger) {
      this.stage = S_ATTACK
    } else if (this.stage === S_IDLE) {
      this.stage = S_ATTACK
    }
  }

  /** No-op: the AD envelope completes regardless of gate (xd behavior). */
  gateOff(): void {
    // intentionally empty
  }

  reset(): void {
    this.stage = S_IDLE
    this.lvl = 0
    this.phase = 0
  }

  tick(): number {
    let l = this.lvl
    if (!Number.isFinite(l)) {
      l = 0
      this.stage = S_IDLE
    }
    const p = this.fallPow
    if (this.stage === S_ATTACK) {
      l += this.aCoef * (ATTACK_TARGET - l)
      if (l >= 1) {
        l = 1
        this.stage = S_DECAY
        this.phase = 1
      }
    } else if (this.stage === S_DECAY) {
      if (p !== null) {
        const ph = this.phase - this.dRate
        if (ph <= 0) {
          this.phase = 0
          l = 0
          this.stage = S_IDLE
        } else {
          this.phase = ph
          l = p === 3 ? ph * ph * ph : Math.pow(ph, p)
        }
      } else {
        l -= this.dCoef * l
        if (l < SILENCE) {
          l = 0
          this.stage = S_IDLE
        }
      }
    } else {
      l = 0
    }
    this.lvl = l
    return l
  }

  get active(): boolean {
    return this.stage !== S_IDLE
  }
}
