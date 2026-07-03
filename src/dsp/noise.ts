/*
 * Noise — white-noise source ('logue-family mixer NOISE channel).
 *
 * Plain TS class, allocation-free tick(). Deterministic seeded xorshift32
 * (per-voice seeds keep voices decorrelated while tests stay stable), same
 * PRNG family as the sequencer/multi-engine generators.
 */

export class Noise {
  private state: number

  constructor(seed = 1) {
    this.state = (seed | 0) || 1
  }

  /** White noise, uniform -1..1. */
  tick(): number {
    let x = this.state | 0
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.state = x | 0
    return (x >>> 0) / 2147483648 - 1
  }

  reset(seed = 1): void {
    this.state = (seed | 0) || 1
  }
}
