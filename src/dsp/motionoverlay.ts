/*
 * MotionOverlay — the motion-sequence parameter override layer shared by the
 * synth engines (raw units; cleared when the transport stops).
 *
 * Non-destructive: overrides shadow the knob values and are resolved by the
 * engine's effectiveParam through effective(id, base); clamping to the param
 * range stays engine-side (after its offset layers). MOTION_PITCH_BEND
 * drives the bend multiplier via the refreshBend hook; MOTION_GATE_TIME
 * never arrives here (the sequencer consumes gate-time lanes itself as
 * per-step gate overrides) — the guard is kept for safety.
 */
import { MOTION_PITCH_BEND, MOTION_GATE_TIME } from '../shared/paramdef'
import type { ParamMeta } from '../shared/paramdef'
import { clamp } from '../shared/maps'
import type { MotionLane } from '../shared/program'

/** Engine callbacks: re-push a param / re-derive the bend multiplier. */
export interface MotionHooks {
  applyParam(id: number): void
  refreshBend(): void
}

export class MotionOverlay {
  /** Pitch-bend lane override (engine bend logic prefers it while on). */
  bendOn = false
  bend = 0

  private readonly params: readonly ParamMeta[]
  private readonly hooks: MotionHooks
  private readonly val: Float64Array
  private readonly has: Uint8Array

  constructor(params: readonly ParamMeta[], hooks: MotionHooks) {
    this.params = params
    this.hooks = hooks
    this.val = new Float64Array(params.length)
    this.has = new Uint8Array(params.length)
  }

  /** Motion-resolved raw value: the override if present, else `base`. */
  effective(id: number, base: number): number {
    return this.has[id] ? this.val[id] : base
  }

  /** Motion-lane value: like setParam but into the override layer. */
  applyMotion(paramId: number, v: number): void {
    if (!Number.isFinite(v)) return
    if (paramId === MOTION_PITCH_BEND) {
      this.bendOn = true
      this.bend = clamp(v, -1, 1)
      this.hooks.refreshBend()
      return
    }
    if (paramId === MOTION_GATE_TIME) return // consumed by the sequencer
    if (!this.params[paramId]) return
    this.has[paramId] = 1
    this.val[paramId] = v
    this.hooks.applyParam(paramId)
  }

  /** Transport stop: drop every override, re-pushing the affected params. */
  clearOverrides(): void {
    if (this.bendOn) {
      this.bendOn = false
      this.hooks.refreshBend()
    }
    for (let id = 0; id < this.has.length; id++) {
      if (this.has[id]) {
        this.has[id] = 0
        this.hooks.applyParam(id)
      }
    }
  }

  /**
   * Lane edits mid-play: drop overrides whose lane was disabled, cleared or
   * re-assigned so the panel knob regains control immediately (otherwise the
   * stale override would pin the param until STOP).
   */
  releaseStale(lanes: readonly MotionLane[]): void {
    for (let id = 0; id < this.has.length; id++) {
      if (!this.has[id]) continue
      if (!this.laneLive(lanes, id)) {
        this.has[id] = 0
        this.hooks.applyParam(id)
      }
    }
    if (this.bendOn && !this.laneLive(lanes, MOTION_PITCH_BEND)) {
      this.bendOn = false
      this.hooks.refreshBend()
    }
  }

  /** Program load: silently drop all overrides (applyAllParams re-pushes). */
  reset(): void {
    this.has.fill(0)
    this.bendOn = false
  }

  private laneLive(lanes: readonly MotionLane[], id: number): boolean {
    for (const l of lanes) {
      if (l && l.on === true && Math.round(l.paramId) === id) return true
    }
    return false
  }
}
