/*
 * Per-voice analog pitch drift for the minilogue xd replica.
 *
 * Models the small tuning imperfections of an analog VCO as the sum of:
 *  1. a slow random walk — a new target (within ±2.5 cents) is chosen every
 *     0.3..1 s and approached with a one-pole slew (~0.35 s time constant),
 *     like slow thermal wander of the oscillator core;
 *  2. a per-noteOn random offset (±1.5 cents) that persists for the whole
 *     note, like sample-and-hold error in the key CV;
 *  3. a very small fast jitter (~±0.15 cents peak), white noise through a
 *     ~30 Hz one-pole lowpass, hard-limited so the total output is bounded.
 *
 * Worst case |output| < 2.5 + 1.5 + 0.2 = 4.2 cents.
 *
 * Fully deterministic from the seed (mulberry32 PRNG) so tests are stable.
 * tick() returns cents; no allocation on the audio path.
 */

export interface DriftConfig {
  walkCents: number
  walkTauSec: number
  walkMinIntervalSec: number
  walkMaxIntervalSec: number
  noteOffsetCents: number
  jitterCutoffHz: number
  jitterDrive: number
  jitterClampCents: number
}

export const DEFAULT_DRIFT_CONFIG: DriftConfig = {
  walkCents: 2.5,
  walkTauSec: 0.35, // slew toward the walk target
  walkMinIntervalSec: 0.3, // spacing between new walk targets
  walkMaxIntervalSec: 1.0,
  noteOffsetCents: 1.5, // persistent per-note offset, drawn at noteOn
  jitterCutoffHz: 30, // one-pole lowpass on the jitter noise
  jitterDrive: 2.0, // pre-filter noise amplitude (post-filter ~±0.15 pk)
  jitterClampCents: 0.2, // hard bound on the jitter component
}
const FLUSH = 1e-9

export class Drift {
  private readonly sr: number
  private readonly seed: number
  private config: DriftConfig
  private walkCoef: number
  private jitterCoef: number
  private rngState: number
  private walk = 0
  private walkTarget = 0
  private walkCounter = 0 // samples until the next walk target
  private noteOffset = 0
  private jitter = 0

  constructor(sampleRate: number, seed: number, config: DriftConfig = DEFAULT_DRIFT_CONFIG) {
    this.sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
    this.seed = (Number.isFinite(seed) ? seed : 0) >>> 0
    this.rngState = this.seed
    this.config = config
    this.walkCoef = 0
    this.jitterCoef = 0
    this.configure(config)
  }

  configure(config: DriftConfig): void {
    this.config = config
    this.walkCoef = 1 - Math.exp(-1 / (Math.max(1e-6, config.walkTauSec) * this.sr))
    this.jitterCoef = 1 - Math.exp((-2 * Math.PI * Math.max(0, config.jitterCutoffHz)) / this.sr)
  }

  /** mulberry32 — deterministic, uniform in [0, 1) */
  private rand(): number {
    let t = (this.rngState = (this.rngState + 0x6d2b79f5) | 0)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Draw a fresh persistent offset for the new note (±1.5 cents). */
  noteOn(): void {
    this.noteOffset = (this.rand() * 2 - 1) * this.config.noteOffsetCents
  }

  reset(): void {
    this.rngState = this.seed
    this.walk = 0
    this.walkTarget = 0
    this.walkCounter = 0
    this.noteOffset = 0
    this.jitter = 0
  }

  /** Returns the current drift in cents. */
  tick(): number {
    // slow random walk: retarget every 0.3..1 s, one-pole slew toward it
    if (--this.walkCounter <= 0) {
      const cfg = this.config
      this.walkTarget = (this.rand() * 2 - 1) * cfg.walkCents
      const interval =
        cfg.walkMinIntervalSec + (cfg.walkMaxIntervalSec - cfg.walkMinIntervalSec) * this.rand()
      this.walkCounter = (interval * this.sr) | 0
    }
    let w = this.walk + this.walkCoef * (this.walkTarget - this.walk)
    const dw = this.walkTarget - w
    if (dw < FLUSH && dw > -FLUSH) w = this.walkTarget // flush denormal residue
    this.walk = w

    // fast jitter: lowpassed white noise, hard-limited
    const cfg = this.config
    const j = this.jitter + this.jitterCoef * ((this.rand() * 2 - 1) * cfg.jitterDrive - this.jitter)
    this.jitter = j
    const jc = j > cfg.jitterClampCents ? cfg.jitterClampCents : j < -cfg.jitterClampCents ? -cfg.jitterClampCents : j

    return w + this.noteOffset + jc
  }
}
