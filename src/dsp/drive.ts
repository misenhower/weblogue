/*
 * Drive — continuous post-VCA analog overdrive, the monologue's final stage
 * before the output jack (docs/monologue-spec.md §1, §7). tanh-family
 * waveshaper: input gain rises with the DRIVE amount, output makeup keeps the
 * perceived level roughly flat ("even fully cranked, drive never becomes too
 * much, nor does it excessively boost the volume" [SoS]).
 *
 * Voiced per synth by a DriveCfg record — the monologue's values live in
 * synths/mono/curves.ts (MONO_DRIVE_CFG); dsp/ never imports synths/.
 * Plain TS class, no allocation in the audio path; gain/makeup are one-pole
 * smoothed (~5 ms) so knob moves and motion lanes don't click.
 */
import { fastTanh } from './filter'

/** Per-synth drive voicing. Raw->gain/makeup curve UNCONFIRMED (spec §16). */
export interface DriveCfg {
  /** Input gain into the shaper at amount 1 (amount 0 = unity). */
  gainMax: number
  /** Taper exponent: gain = 1 + (gainMax - 1) * amount^gainCurve. */
  gainCurve: number
}

export class Drive {
  private readonly cfg: DriveCfg
  /** One-pole smoothing coefficient (~5 ms). */
  private readonly aSm: number
  private gainTarget = 1
  private makeupTarget = 1
  private gainSm = 1
  private makeupSm = 1

  constructor(sampleRate: number, cfg: DriveCfg) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) sampleRate = 48000
    this.cfg = cfg
    this.aSm = 1 - Math.exp(-1 / (0.005 * sampleRate))
  }

  /** DRIVE amount 0..1 (curves.driveAmount01 of the raw knob). Smoothed. */
  setAmount(a: number): void {
    if (!Number.isFinite(a)) return
    const t = a < 0 ? 0 : a > 1 ? 1 : a
    const gain = 1 + (this.cfg.gainMax - 1) * Math.pow(t, this.cfg.gainCurve)
    this.gainTarget = gain
    // Makeup pins a full-scale sine's saturated peak to its amount-0 value, so
    // cranking DRIVE adds harmonics/compression without boosting level.
    // UNCONFIRMED voicing (spec §7/§16) — calibration target.
    this.makeupTarget = fastTanh(1) / fastTanh(gain)
  }

  /** Process one sample: makeup(amount) * tanh(x * gain(amount)). */
  tick(x: number): number {
    if (!Number.isFinite(x)) x = 0
    this.gainSm += this.aSm * (this.gainTarget - this.gainSm)
    this.makeupSm += this.aSm * (this.makeupTarget - this.makeupSm)
    return this.makeupSm * fastTanh(x * this.gainSm)
  }

  /** Snap smoothers to their targets (program load / voice restart). */
  reset(): void {
    this.gainSm = this.gainTarget
    this.makeupSm = this.makeupTarget
  }
}
