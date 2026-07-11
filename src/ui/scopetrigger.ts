/*
 * Canonical scope trigger shared by the OLED scope and the service-mode
 * panels. Waves can cross zero more than once per cycle — hard-sync ramps,
 * RING products, the SHAPE morphs' period-doubled teeth — so triggering on
 * the FIRST rising crossing lands on a different crossing class frame to
 * frame and the trace looks mangled (worst on the VCO2 tap, where sync/ring
 * products land). Anchor at the search window's global minimum — one
 * canonical point per cycle — then take the first rising zero crossing
 * after it. Same rule as the calibration harness (tools/calib measure.ts /
 * scope.ts), minus the pitch tracker the UI doesn't have.
 */

/**
 * Find a trigger index in [lo, hi): the first rising zero crossing after the
 * window's deepest trough. The anchor is the EARLIEST sample within 2% of
 * the window minimum — equal troughs repeat every cycle, and anchoring the
 * first instance leaves maximal room for the crossing search (a global
 * argmin can land on the last instance, whose crossing lies past the
 * window). Wraps the crossing search to the window start as a last resort.
 * Returns `fallback` when the window has no rising crossing (silence, DC).
 */
export function scopeTrigger(data: Float32Array, lo: number, hi: number, fallback: number): number {
  if (hi - lo < 2) return fallback
  let minV = Infinity
  let maxV = -Infinity
  for (let i = lo; i < hi; i++) {
    const v = data[i]
    if (v < minV) minV = v
    if (v > maxV) maxV = v
  }
  const tol = (maxV - minV) * 0.02
  let minI = lo
  for (let i = lo; i < hi; i++) {
    if (data[i] <= minV + tol) {
      minI = i
      break
    }
  }
  for (let i = minI + 1; i < hi; i++) {
    if (data[i - 1] <= 0 && data[i] > 0) return i
  }
  for (let i = lo + 1; i <= minI; i++) {
    if (data[i - 1] <= 0 && data[i] > 0) return i
  }
  return fallback
}
