/*
 * OgDelayFx — the original minilogue's HI PASS + DELAY block (og-spec §9).
 *
 * Composite over the generic DelayFx core using its HIPASS voicing (loop
 * highpass = each repeat thins out) with the OG's dedicated controls:
 * continuous HI PASS CUTOFF, TIME (free, not tempo-synced), FEEDBACK
 * (decoupled loop gain, just-over-unity self-oscillation) and OUTPUT
 * ROUTING [BYPASS, PRE FILTER, POST FILTER] where "FILTER" is the delay's
 * own HPF: BYPASS = delay AND HPF fully bypassed; PRE = HPF on the wet only
 * (the core's loop HPF); POST = HPF on dry + wet (extra output one-pole).
 *
 * UNCONFIRMED voicings (calibration targets): fixed wet level 0.85, output
 * HPF sharing the loop cutoff, no ghost tail feeding while bypassed.
 */
import { DelayFx } from '../../dsp/fx/delay'

const ROUTE_BYPASS = 0
const ROUTE_PRE = 1
const ROUTE_POST = 2

const TWO_PI = Math.PI * 2

export class OgDelayFx {
  private readonly sr: number
  private readonly core: DelayFx
  private routing = ROUTE_BYPASS

  // POST-routing output highpass (applied to dry + wet).
  private hpHz = 600
  private hpCoef: number
  private hpL = 0
  private hpR = 0

  constructor(sampleRate: number) {
    this.sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
    this.core = new DelayFx(this.sr)
    this.core.setSubType(3) // HIPASS: loop highpass, analog-ish 9 kHz loop LP
    this.core.setDryWet(0.5) // dry and wet both at full
    this.core.setDepth(0.85) // fixed wet level (no depth knob on the OG)
    this.core.setFeedback(0)
    this.core.setOn(false) // BYPASS at init
    this.hpCoef = 1 - Math.exp((-TWO_PI * this.hpHz) / this.sr)
  }

  /** TIME knob 0..1 (core maps exponentially 1 ms .. 1.4 s). */
  setTime(knob01: number): void {
    this.core.setTime(knob01)
  }

  /** Loop gain 0..1.05 (curves.delayFeedback01). */
  setFeedback(gain: number): void {
    this.core.setFeedback(gain)
  }

  /** HI PASS CUTOFF in Hz (loop HPF + POST output HPF). */
  setHipassHz(hz: number): void {
    if (!Number.isFinite(hz)) return
    this.core.setHipassHz(hz)
    this.hpHz = hz < 10 ? 10 : hz > 8000 ? 8000 : hz
    this.hpCoef = 1 - Math.exp((-TWO_PI * this.hpHz) / this.sr)
  }

  /** OUTPUT ROUTING: 0 BYPASS, 1 PRE FILTER, 2 POST FILTER. */
  setRouting(r: number): void {
    const v = r <= 0 ? ROUTE_BYPASS : r >= 2 ? ROUTE_POST : ROUTE_PRE
    if (v === this.routing) return
    this.routing = v
    this.core.setOn(v !== ROUTE_BYPASS) // faded on/off; off = exact bypass
    if (v !== ROUTE_POST) {
      this.hpL = 0
      this.hpR = 0
    }
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    this.core.process(l, r, n) // BYPASS: core is off -> exact identity
    if (this.routing !== ROUTE_POST) return
    // POST FILTER: the HPF also shapes the dry+wet sum.
    const c = this.hpCoef
    let sL = this.hpL
    let sR = this.hpR
    for (let i = 0; i < n; i++) {
      sL += c * (l[i] - sL)
      l[i] -= sL
      sR += c * (r[i] - sR)
      r[i] -= sR
    }
    // flush denormal-ish state
    this.hpL = sL < 1e-20 && sL > -1e-20 ? 0 : sL
    this.hpR = sR < 1e-20 && sR > -1e-20 ? 0 : sR
  }
}
