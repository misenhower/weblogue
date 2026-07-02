/*
 * LFO for the minilogue xd replica.
 *
 * Plain TS class — no DOM, no worklet globals. sampleRate is injected.
 * Runs per-sample (tick), no allocation on the audio path.
 *
 * Waveform conventions (matching the hardware panel behavior):
 *  - TRI starts at 0 rising (0 -> +1 -> -1 -> 0 over one cycle)
 *  - SAW is the DOWNWARD ramp (+1 falling to -1)
 *  - SQR starts high (+1 for the first half cycle)
 *
 * Band-limiting is unnecessary at LFO rates, but every output edge (square
 * transitions, saw wrap, wave switches, one-shot end) is passed through a
 * linear slew limiter that covers the full -1..+1 range in ~1 ms, so nothing
 * clicks when the LFO is routed to pitch/shape.
 *
 * ONE_SHOT: after trigger() the LFO runs exactly HALF a cycle (hardware:
 * "stops after a half-cycle from the time the sound is played"): the phase
 * runs 0 -> 0.5 and freezes there, and the output holds the wave's value at
 * phase 0.5 (TRI: 0, SAW: mid-fall 0, SQR: transitions low to -1). The hold
 * is reached through the slew limiter, so the freeze is click-free. Entering
 * ONE_SHOT mode arms the LFO silent (output 0) until the next trigger().
 * BPM mode behaves like NORMAL (free-run); the caller computes the synced
 * frequency in Hz.
 */

export const LFO_WAVE = { SQR: 0, TRI: 1, SAW: 2 } as const
export const LFO_MODE = { ONE_SHOT: 0, NORMAL: 1, BPM: 2 } as const

const SLEW_TIME = 0.001 // seconds to traverse the full -1..+1 range
const MIN_FREQ = 0
const MAX_FREQ = 100 // 0.01..~40 Hz in practice; headroom for BPM sync

export class Lfo {
  private readonly sr: number
  private readonly maxStep: number
  private ph = 0
  private inc = 0
  private wave: number = LFO_WAVE.TRI
  private mode: number = LFO_MODE.NORMAL
  private done = false // ONE_SHOT: finished (or awaiting trigger)
  private hold = 0 // ONE_SHOT: frozen output target once done
  private out = 0 // slewed output state

  constructor(sampleRate: number) {
    this.sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
    this.maxStep = 2 / (SLEW_TIME * this.sr)
    this.setFreq(1)
  }

  setWave(w: number): void {
    if (w === LFO_WAVE.SQR || w === LFO_WAVE.TRI || w === LFO_WAVE.SAW) this.wave = w
  }

  setFreq(hz: number): void {
    if (!Number.isFinite(hz)) return
    const f = hz < MIN_FREQ ? MIN_FREQ : hz > MAX_FREQ ? MAX_FREQ : hz
    this.inc = f / this.sr
  }

  setMode(m: number): void {
    if (m !== LFO_MODE.ONE_SHOT && m !== LFO_MODE.NORMAL && m !== LFO_MODE.BPM) return
    if (m === this.mode) return
    this.mode = m
    // arming: a freshly-selected one-shot stays silent until trigger()
    if (m === LFO_MODE.ONE_SHOT) {
      this.done = true
      this.hold = 0
    }
  }

  /** Phase reset — key sync, or (re)start of a one-shot cycle. */
  trigger(): void {
    this.ph = 0
    this.done = false
  }

  reset(): void {
    this.ph = 0
    this.out = 0
    this.done = this.mode === LFO_MODE.ONE_SHOT
    this.hold = 0
  }

  /** Raw (unslewed) wave value at phase p (cycles, 0..1). */
  private waveAt(p: number): number {
    const w = this.wave
    if (w === LFO_WAVE.SQR) return p < 0.5 ? 1 : -1
    if (w === LFO_WAVE.TRI) return p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4
    return 1 - 2 * p // falling ramp
  }

  tick(): number {
    let target: number
    if (this.mode === LFO_MODE.ONE_SHOT && this.done) {
      target = this.hold
    } else {
      const p = this.ph
      target = this.waveAt(p)
      let np = p + this.inc
      if (this.mode === LFO_MODE.ONE_SHOT) {
        if (np >= 0.5) {
          // half-cycle done: freeze the phase at 0.5 and hold the wave's
          // value there (TRI/SAW: 0, SQR: -1) — reached via the slew limiter
          np = 0.5
          this.done = true
          this.hold = this.waveAt(0.5)
        }
      } else if (np >= 1) {
        np -= Math.floor(np)
      }
      this.ph = np
    }
    // linear slew limiter: full swing in ~1 ms, converges exactly (no denormals)
    const d = target - this.out
    const s = this.maxStep
    this.out += d > s ? s : d < -s ? -s : d
    return this.out
  }

  get phase(): number {
    return this.ph
  }
}
