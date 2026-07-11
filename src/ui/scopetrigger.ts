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

const SIG_N = 48
const ERR_ACCEPT = 0.35
const FREEZE_MAX = 3

/**
 * Frame-coherent trigger lock for one scope cell — a real scope's holdoff.
 *
 * The trough-anchored trigger alone can't stay locked when the buffer is
 * barely longer than the wave period: the anchor can land where its crossing
 * doesn't fit the displayable range, and clamping the window there unlocks
 * the view (the "jumping horizontally" regression). Instead: every rising
 * crossing whose display window fits is a CANDIDATE; the one whose window
 * best correlates with the previous frame's chosen view wins. Frames where
 * the locked crossing class genuinely isn't displayable (it happens ~12% of
 * the time when one doubled period barely fits) FREEZE — the caller redraws
 * the stored copy — and a run of misses (content actually changed) re-locks.
 */
export class ScopeLock {
  private ref: Float32Array | null = null
  private held: Float32Array | null = null
  private heldR: Float32Array | null = null
  private freezeRun = 0

  /**
   * Choose the window start for this frame. `frozen` non-null means "draw
   * these stored samples instead" (length win; heldR when the cell is
   * stereo and dataR was passed).
   */
  pick(
    data: Float32Array,
    lo: number,
    hi: number,
    half: number,
    win: number,
    fallbackStart: number,
    dataR?: Float32Array,
  ): { start: number; frozen: Float32Array | null; frozenR: Float32Array | null } {
    const n = data.length
    const startOf = (trig: number): number => Math.max(0, Math.min(trig - half, n - win))
    // candidate rising crossings whose display window fits untranslated
    const cands: number[] = []
    for (let i = Math.max(1, lo); i < hi && cands.length < 48; i++) {
      if (data[i - 1] <= 0 && data[i] > 0) cands.push(i)
    }
    if (cands.length === 0) {
      this.ref = null
      this.freezeRun = 0
      return { start: fallbackStart, frozen: null, frozenR: null }
    }
    const sig = (start: number): Float32Array => {
      const s = new Float32Array(SIG_N)
      for (let k = 0; k < SIG_N; k++) s[k] = data[start + Math.floor((k * win) / SIG_N)]
      return s
    }
    const accept = (trig: number): { start: number; frozen: null; frozenR: null } => {
      const start = startOf(trig)
      this.ref = sig(start)
      this.held = data.slice(start, start + win)
      this.heldR = dataR ? dataR.slice(start, start + win) : null
      this.freezeRun = 0
      return { start, frozen: null, frozenR: null }
    }
    if (!this.ref) {
      // first frame: trough-anchored canonical choice, snapped to a candidate
      const anchor = scopeTrigger(data, Math.max(1, lo), hi, cands[0])
      let best = cands[0]
      for (const c of cands) if (Math.abs(c - anchor) < Math.abs(best - anchor)) best = c
      return accept(best)
    }
    // score candidates against last frame's view. The score must be SCALE-
    // SENSITIVE (relative residual, not normalized correlation): on
    // alternating-amplitude teeth both classes have identical normalized
    // shape and only the amplitude tells them apart.
    const ref = this.ref
    let nb = 0
    for (let k = 0; k < SIG_N; k++) nb += ref[k] * ref[k]
    let bestErr = Infinity
    let bestTrig = cands[0]
    for (const c of cands) {
      const start = startOf(c)
      let e = 0
      for (let k = 0; k < SIG_N; k++) {
        const d = data[start + Math.floor((k * win) / SIG_N)] - ref[k]
        e += d * d
      }
      const err = nb > 1e-12 ? e / nb : Infinity
      if (err < bestErr) {
        bestErr = err
        bestTrig = c
      }
    }
    if (bestErr <= ERR_ACCEPT || this.freezeRun >= FREEZE_MAX || !this.held) {
      return accept(bestTrig)
    }
    // isolated missing-class frame: hold last frame's trace
    this.freezeRun++
    return { start: 0, frozen: this.held, frozenR: this.heldR }
  }
}
