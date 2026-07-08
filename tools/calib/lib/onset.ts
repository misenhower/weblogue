/*
 * Capture-validation primitives for the calibration harness (tools/calib):
 * given a recorded take, find where the synth actually started sounding and
 * report basic level stats. Pure math over Float32Arrays — no node imports.
 *
 * detectOnset measures the noise floor as the RMS of the pre-roll (the first
 * preRollSec of the take), sets the threshold at max(10 * floor, 1e-3), then
 * scans 2 ms RMS windows on a 1 ms hop starting after the pre-roll. The onset
 * is pinned to the first sample inside the first crossing window whose |x|
 * exceeds the threshold.
 */

export interface Onset {
  sample: number
  noiseFloorRms: number
  peakDbfs: number
}

/** 20*log10(max|x|); -Infinity for an all-zero (or empty) buffer. */
export function peakDbfs(x: Float32Array): number {
  let peak = 0
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i])
    if (a > peak) peak = a
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity
}

function rms(x: Float32Array, from: number, to: number): number {
  let acc = 0
  for (let i = from; i < to; i++) acc += x[i] * x[i]
  return Math.sqrt(acc / Math.max(1, to - from))
}

export function detectOnset(x: Float32Array, sr: number, preRollSec = 0.25): Onset | null {
  const pre = Math.min(x.length, Math.max(0, Math.round(preRollSec * sr)))
  const noiseFloorRms = rms(x, 0, pre)
  const threshold = Math.max(10 * noiseFloorRms, 1e-3)

  const win = Math.max(1, Math.round(0.002 * sr))
  const hop = Math.max(1, Math.round(0.001 * sr))

  for (let start = pre; start + win <= x.length; start += hop) {
    if (rms(x, start, start + win) <= threshold) continue
    // First crossing window: pin the onset to its first over-threshold sample
    // (windows overlap, so the crossing may sit anywhere inside).
    let sample = start
    for (let i = start; i < start + win; i++) {
      if (Math.abs(x[i]) > threshold) {
        sample = i
        break
      }
    }
    return { sample, noiseFloorRms, peakDbfs: peakDbfs(x) }
  }
  return null
}
