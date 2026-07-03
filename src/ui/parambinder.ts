/**
 * Shared param-binding layer for the synth front panels (xd, og).
 *
 * A ParamBinder owns one panel's static param-id -> control bindings and the
 * store plumbing around them:
 *
 *   paramKnob / paramSwitch build a control pre-wired to the param table
 *     (label, range, default, format) and register it in the bindings map;
 *   knobInput funnels every param-bound knob move — while step buttons are
 *     held the move is diverted to the panel's motion-write callback
 *     (step edit, spec §11) instead of changing the live parameter;
 *   resync / resyncAll push store values back into the bound controls
 *     silently (the store.onParam / store.onProgram handlers).
 *
 * Dynamic controls (the xd's SHIFT/engine-addressed SHAPE and FX knobs) stay
 * per-panel: they are not registered here — the panel rebinds them with
 * setRange/setValue and feeds their input through knobInput.
 */
import type { Store } from '../state/store'
import type { ParamMeta } from '../shared/paramdef'
import { Knob, SelectorSwitch, type SetValueOpts } from './components'

export interface Bindable {
  setValue(v: number, opts?: SetValueOpts): void
}

export interface ParamBinderOpts {
  store: Store
  params: readonly ParamMeta[]
  formatParam(id: number, v: number): string
  /** true while step buttons are held (the step strip stays per-panel). */
  isStepHeld(): boolean
  /** Write a knob move as motion data into the held steps. */
  writeHeldStepMotion(id: number, v: number): void
}

export class ParamBinder {
  /** static param id -> bound controls */
  private bindings = new Map<number, Bindable[]>()

  private store: Store
  private params: readonly ParamMeta[]
  private formatParam: (id: number, v: number) => string
  private isStepHeld: () => boolean
  private writeHeldStepMotion: (id: number, v: number) => void

  constructor(opts: ParamBinderOpts) {
    this.store = opts.store
    this.params = opts.params
    this.formatParam = opts.formatParam
    this.isStepHeld = opts.isStepHeld
    this.writeHeldStepMotion = opts.writeHeldStepMotion
  }

  bind(id: number, c: Bindable): void {
    let arr = this.bindings.get(id)
    if (!arr) {
      arr = []
      this.bindings.set(id, arr)
    }
    arr.push(c)
  }

  /**
   * Every param-bound knob funnels here: while step buttons are held the
   * move writes motion data to those steps (spec §11 step edit) instead of
   * changing the live parameter.
   */
  knobInput(id: number, v: number): void {
    if (this.isStepHeld() && this.params[id]?.motion === true) {
      this.writeHeldStepMotion(id, v)
      return
    }
    this.store.setParam(id, v, 'ui')
  }

  paramKnob(
    id: number,
    size: 'xl' | 'l' | 'm',
    extra?: { label?: string; bipolar?: boolean; format?: (v: number) => string },
  ): Knob {
    const m = this.params[id]
    const k = new Knob({
      label: extra?.label ?? m.label,
      size,
      min: m.min,
      max: m.max,
      value: this.store.getParam(id),
      defaultValue: m.def,
      bipolar: extra?.bipolar,
      format: extra?.format ?? ((v) => this.formatParam(id, v)),
      onInput: (v) => this.knobInput(id, v),
    })
    this.bind(id, k)
    return k
  }

  paramSwitch(id: number, extra?: { label?: string; positions?: string[] }): SelectorSwitch {
    const m = this.params[id]
    const s = new SelectorSwitch({
      label: extra?.label ?? m.label,
      positions: extra?.positions ?? (m.labels ? [...m.labels] : []),
      value: this.store.getParam(id),
      onInput: (v) => this.store.setParam(id, v, 'ui'),
    })
    this.bind(id, s)
    return s
  }

  /** Silently resync the controls bound to one param (non-'ui' changes). */
  resync(id: number, v: number): void {
    const arr = this.bindings.get(id)
    if (arr) for (const c of arr) c.setValue(v, { silent: true })
  }

  /** Silently resync every bound control from the store (program loads). */
  resyncAll(): void {
    for (const [id, arr] of this.bindings) {
      const v = this.store.getParam(id)
      for (const c of arr) c.setValue(v, { silent: true })
    }
  }
}
