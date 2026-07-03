/*
 * ServiceTaps — SERVICE MODE (debug panel) tap rings, shared by the synth
 * engines. Zero-cost unless enabled.
 *
 * Rings 0-5: tapped voice, mono (vco1, vco2, multi, mix, filt, vca).
 * Rings 6-11: FX chain stages, stereo pairs (the signal is genuinely stereo
 * from the FX onward). 4-voice mode ('4V') adds per-voice rings, voice-major
 * [v*6 + (vco1..vca)].
 *
 * No allocation on the audio thread: all rings are preallocated.
 */

/** Per-stage tap fields a voice exposes while taps are on. */
export interface TapVoice {
  readonly active: boolean
  readonly tapV1: number
  readonly tapV2: number
  readonly tapM: number
  readonly tapMix: number
  readonly tapFilt: number
  readonly tapVca: number
}

export class ServiceTaps {
  /** Taps enabled (the debug panel is open). */
  on = false
  /** 4-voice tap mode: record every voice's stages, not just the tapped one. */
  all = false

  private readonly size: number
  private readonly rings: Float32Array[]
  private readonly vRings: Float32Array[]
  private w = 0
  private fxW = 0

  constructor(numVoices: number, tapSize: number) {
    this.size = tapSize
    this.rings = Array.from({ length: 12 }, () => new Float32Array(tapSize))
    this.vRings = Array.from({ length: numVoices * 6 }, () => new Float32Array(tapSize))
  }

  /**
   * Per-sample voice-stage write: the tapped voice into rings 0-5 and, in
   * 4-voice mode, every voice into its own ring set. Idle voices write
   * zeros: their tick() is skipped, so the tap fields would otherwise freeze
   * at the last computed sample and draw as a flat line at an arbitrary
   * height.
   */
  writeVoiceSample(tapped: TapVoice, voices: readonly TapVoice[]): void {
    const tOn = tapped.active
    const w = this.w
    const rings = this.rings
    rings[0][w] = tOn ? tapped.tapV1 : 0
    rings[1][w] = tOn ? tapped.tapV2 : 0
    rings[2][w] = tOn ? tapped.tapM : 0
    rings[3][w] = tOn ? tapped.tapMix : 0
    rings[4][w] = tOn ? tapped.tapFilt : 0
    rings[5][w] = tOn ? tapped.tapVca : 0
    if (this.all) {
      const vr = this.vRings
      for (let v = 0; v < voices.length; v++) {
        const b = v * 6
        const vv = voices[v]
        const on = vv.active
        vr[b][w] = on ? vv.tapV1 : 0
        vr[b + 1][w] = on ? vv.tapV2 : 0
        vr[b + 2][w] = on ? vv.tapM : 0
        vr[b + 3][w] = on ? vv.tapMix : 0
        vr[b + 4][w] = on ? vv.tapFilt : 0
        vr[b + 5][w] = on ? vv.tapVca : 0
      }
    }
    this.w = (w + 1) % this.size
  }

  /** FX-stage tap: stereo pair written after an FX stage processes. */
  writeFxTap(base: number, l: Float32Array, r: Float32Array, n: number, advance: boolean): void {
    const bufL = this.rings[base]
    const bufR = this.rings[base + 1]
    let w = this.fxW
    for (let s = 0; s < n; s++) {
      bufL[w] = l[s]
      bufR[w] = r[s]
      w = (w + 1) % this.size
    }
    if (advance) this.fxW = w
  }

  /** Copy the twelve tap rings (chronological order) into dst[0..11]. */
  copyDebugTaps(dst: Float32Array[]): void {
    for (let t = 0; t < this.rings.length && t < dst.length; t++) {
      const w = t >= 6 ? this.fxW : this.w
      const tail = this.size - w
      const ring = this.rings[t]
      const d = dst[t]
      d.set(ring.subarray(w), 0)
      d.set(ring.subarray(0, w), tail)
    }
  }

  /** Copy the per-voice tap rings (voice-major) into dst. */
  copyDebugVoiceTaps(dst: Float32Array[]): void {
    const w = this.w
    const tail = this.size - w
    for (let t = 0; t < this.vRings.length && t < dst.length; t++) {
      const ring = this.vRings[t]
      const d = dst[t]
      d.set(ring.subarray(w), 0)
      d.set(ring.subarray(0, w), tail)
    }
  }
}
