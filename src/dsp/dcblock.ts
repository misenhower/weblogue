/*
 * First-order DC blocker: y[n] = x[n] − x[n−1] + R·y[n−1].
 *
 * Models the AC coupling at the 'logue family's analog-voice → digital-FX
 * boundary (the voice bus is capacitor-coupled into the FX ADC on the real
 * hardware). Without it, waveforms with a genuine mean — RING of two
 * hard-synced same-pitch oscillators is essentially osc², mean ≈ +1/3 —
 * push DC into the FX, where a reverb/delay feedback loop (whose damping is
 * a LOWPASS: DC circulates freely) amplifies it several-fold and the output
 * limiter flattens the mix ("Replicant xd" bug, 2026-07-10).
 *
 * Corner defaults to 5 Hz: INFERRED (the real coupling corner is unmeasured;
 * anything single-digit is inaudible against the xd's 20.6 Hz lowest note
 * while settling DC in ~100 ms).
 */
export class DcBlock {
  private x1 = 0
  private y1 = 0
  private readonly R: number

  constructor(sampleRate: number, fcHz = 5) {
    this.R = 1 - (2 * Math.PI * fcHz) / sampleRate
  }

  /** In-place over buf[0..n). */
  process(buf: Float32Array, n: number): void {
    let x1 = this.x1
    let y1 = this.y1
    const R = this.R
    for (let i = 0; i < n; i++) {
      const x = buf[i]
      let y = x - x1 + R * y1
      if (y < 1e-20 && y > -1e-20) y = 0 // flush denormals
      x1 = x
      y1 = y
      buf[i] = y
    }
    this.x1 = x1
    this.y1 = y1
  }

  reset(): void {
    this.x1 = 0
    this.y1 = 0
  }
}
