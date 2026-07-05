/*
 * Web-native settings drawer — everything the OLED menu can edit (PROG EDIT
 * menu params, SEQ EDIT fields, motion-lane config) as a grouped, directly
 * clickable surface. A synth supplies its grouping via SettingsDef
 * (synths/<id>/settings-def.ts); the SEQUENCER and MOTION groups are
 * synth-agnostic and appended automatically on 'seq'-transport synths.
 *
 * All edits go through the same central Store as the OLED and panel —
 * params with source 'menu' so panels resync statically bound duplicates —
 * which keeps drawer, OLED and panel in sync in every direction for free.
 */
import type { Store } from '../state/store'
import type { ParamMeta } from '../shared/paramdef'
import type { SynthDef } from '../synths/def'
import type { DisplayDef } from './display'
import { buildPresetsGroup, stepBtn } from './presets'
import { showMenu, menuOpen, type MenuItem } from './menu'
import { NUM_MOTION_LANES } from '../shared/program'
import { SEQ_FIELDS, type SeqFieldDef } from './seqfields'
import { div, row } from './dom'

export interface SettingsGroup {
  title: string
  /** Param ids in display order (menu params; switch params also work). */
  ids: readonly number[]
}

/** A tab of groups. Single-tab synths never render the tab bar. */
export interface SettingsTab {
  title: string
  groups: readonly SettingsGroup[]
}

export interface SettingsDef {
  tabs: readonly SettingsTab[]
}

/** Horizontal pixels for a full-range drag on a numeric value. */
const DRAG_PX = 160

/** A numeric value the drawer can step/drag: params, seq fields. */
interface NumSpec {
  get(): number
  set(v: number): void
  min: number
  max: number
  step: number
  fmt(v: number): string
  /** Double-click reset target; omit to disable. */
  def?: number
}

/** An enumerated value picked from a popover. */
interface EnumSpec {
  get(): number
  set(v: number): void
  options(): MenuItem[]
  fmt(v: number): string
}

export class SettingsDrawer {
  el: HTMLElement

  private store: Store
  private displayDef: DisplayDef
  private openState = false
  private updaters: Array<() => void> = []
  private refreshQueued = false

  constructor(opts: { store: Store; synthDef: SynthDef; displayDef: DisplayDef; def: SettingsDef }) {
    this.store = opts.store
    this.displayDef = opts.displayDef

    this.el = div('xd-settings')

    /* ---- head ------------------------------------------------------ */
    const title = div('xd-set-title', 'SETTINGS')
    const close = document.createElement('button')
    close.className = 'xd-set-close'
    close.textContent = '✕'
    close.setAttribute('aria-label', 'close settings')
    close.addEventListener('click', () => this.toggle(false))
    this.el.appendChild(row('xd-set-head', title, close))

    /* ---- tabs + body ------------------------------------------------ */
    const tabs = opts.def.tabs
    const body = div('xd-set-body')
    const panes: HTMLElement[] = []

    const selectTab = (i: number): void => {
      panes.forEach((p, k) => p.classList.toggle('is-hidden', k !== i))
      tabBtns.forEach((b, k) => b.classList.toggle('is-on', k === i))
    }
    const tabBtns: HTMLButtonElement[] = []
    if (tabs.length > 1) {
      const bar = div('xd-set-tabbar')
      tabs.forEach((t, i) => {
        const b = document.createElement('button')
        b.className = 'xd-set-tab'
        b.textContent = t.title
        b.addEventListener('click', () => selectTab(i))
        tabBtns.push(b)
        bar.appendChild(b)
      })
      this.el.appendChild(bar)
    }

    for (const tab of tabs) {
      const pane = div('xd-set-pane')
      for (const group of tab.groups) this.buildGroup(pane, group)
      panes.push(pane)
      body.appendChild(pane)
    }

    // Sequencer + motion-lane groups are the same on every 'seq' synth;
    // they live on the last pane (single-tab synths: the only one).
    // 'arp' synths keep a TEMPO group (the OLED's arp-mode TEMPO page).
    if (panes.length > 0) {
      if (this.displayDef.transport === 'seq') {
        const last = panes[panes.length - 1]
        this.buildSeqGroup(last, 'SEQUENCER', SEQ_FIELDS)
        this.buildMotionGroup(last)
      } else {
        this.buildSeqGroup(
          panes[0],
          'TEMPO',
          SEQ_FIELDS.filter((f) => f.field === 'bpm'),
        )
      }
      // Preset/file import-export lives on the first pane (prologue: GLOBAL).
      buildPresetsGroup(panes[0], { store: opts.store, def: opts.synthDef })
    }

    this.el.appendChild(body)
    if (tabs.length > 1) selectTab(0)

    /* ---- store subscriptions (drawer lives for the page lifetime) ---
     * onParam + onSeq cover program loads too: afterLoad() fires both. */
    this.store.onParam(() => this.scheduleRefresh())
    this.store.onSeq(() => this.scheduleRefresh())

    // Escape closes the drawer — but an open popover wins the keypress
    // (menu.ts closes it in its own capture listener; menuOpen() is still
    // true here because this listener was registered first).
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || !this.openState || menuOpen()) return
        this.toggle(false)
      },
      true,
    )
  }

  get open(): boolean {
    return this.openState
  }

  toggle(on = !this.openState): void {
    if (on === this.openState) return
    this.openState = on
    this.el.classList.toggle('is-open', on)
    if (on) this.refresh()
  }

  /* ---------------------------------------------------------------- */
  /* refresh                                                           */
  /* ---------------------------------------------------------------- */

  /** Coalesce bursts (program load fires onParam once per param). */
  private scheduleRefresh(): void {
    if (!this.openState || this.refreshQueued) return
    this.refreshQueued = true
    queueMicrotask(() => {
      this.refreshQueued = false
      if (this.openState) this.refresh()
    })
  }

  private refresh(): void {
    for (const u of this.updaters) u()
  }

  /* ---------------------------------------------------------------- */
  /* groups                                                            */
  /* ---------------------------------------------------------------- */

  private buildGroup(pane: HTMLElement, group: SettingsGroup): void {
    pane.appendChild(div('xd-set-group', group.title))
    for (const id of group.ids) {
      const meta = this.displayDef.params[id]
      if (!meta) continue
      pane.appendChild(this.paramRow(meta))
    }
  }

  private paramRow(meta: ParamMeta): HTMLElement {
    const store = this.store
    const set = (v: number): void => store.setParam(meta.id, v, 'menu')
    const get = (): number => store.getParam(meta.id)
    const fmt = (v: number): string => this.displayDef.formatParam(meta.id, v)
    if (meta.labels) {
      return this.enumRow(meta.label, {
        get,
        set,
        fmt,
        options: () => {
          const items: MenuItem[] = []
          for (let v = meta.min; v <= meta.max; v++) {
            items.push({ label: fmt(v), value: v, selected: v === get() })
          }
          return items
        },
      })
    }
    return this.numRow(meta.label, { get, set, min: meta.min, max: meta.max, step: 1, fmt, def: meta.def })
  }

  private buildSeqGroup(pane: HTMLElement, title: string, fields: readonly SeqFieldDef[]): void {
    pane.appendChild(div('xd-set-group', title))
    const store = this.store
    for (const f of fields) {
      const get = (): number => f.get(store.program.seq)
      const set = (v: number): void => store.setSeqField(f.field, v)
      if (f.labels) {
        const labels = f.labels
        pane.appendChild(
          this.enumRow(f.label, {
            get,
            set,
            fmt: f.fmt,
            options: () => labels.map((label, i) => ({ label, value: i, selected: i === get() })),
          }),
        )
      } else {
        pane.appendChild(this.numRow(f.label, { get, set, min: f.min, max: f.max, step: f.step, fmt: f.fmt }))
      }
    }
  }

  private buildMotionGroup(pane: HTMLElement): void {
    pane.appendChild(div('xd-set-group', 'MOTION SEQUENCE'))
    for (let lane = 0; lane < NUM_MOTION_LANES; lane++) {
      pane.appendChild(this.motionRow(lane))
    }
  }

  private motionRow(lane: number): HTMLElement {
    const store = this.store
    const displayDef = this.displayDef
    const l = (): { paramId: number; on: boolean; smooth: boolean } => store.program.seq.motion[lane]

    const label = div('xd-set-label', 'M' + (lane + 1))

    const assign = document.createElement('button')
    assign.className = 'xd-set-value xd-set-assign'
    assign.addEventListener('click', () => {
      const cur = l().paramId
      const items: MenuItem[] = [{ label: '---', value: -1, selected: cur === -1 }]
      for (const id of displayDef.motionParamIds) {
        items.push({ label: displayDef.motionParamLabel(id), value: id, selected: id === cur })
      }
      showMenu(assign, items, (v) => store.setMotionLane(lane, { paramId: Number(v) }))
    })

    const onChip = this.chip('ON', () => store.setMotionLane(lane, { on: !l().on }))
    const smoothChip = this.chip('SMOOTH', () => store.setMotionLane(lane, { smooth: !l().smooth }))

    const clear = document.createElement('button')
    clear.className = 'xd-set-clear'
    clear.textContent = '✕'
    clear.title = 'Clear lane ' + (lane + 1)
    clear.addEventListener('click', () => store.clearMotionLane(lane))

    const sync = (): void => {
      const cfg = l()
      const t = cfg.paramId === -1 ? '---' : displayDef.motionParamLabel(cfg.paramId)
      if (assign.textContent !== t) assign.textContent = t
      onChip.classList.toggle('is-on', cfg.on)
      smoothChip.classList.toggle('is-on', cfg.smooth)
    }
    this.updaters.push(sync)
    sync()

    return row('xd-set-row xd-set-motionrow', label, assign, onChip, smoothChip, clear)
  }

  /* ---------------------------------------------------------------- */
  /* rows                                                              */
  /* ---------------------------------------------------------------- */

  private enumRow(label: string, spec: EnumSpec): HTMLElement {
    const value = document.createElement('button')
    value.className = 'xd-set-value'
    value.addEventListener('click', () => {
      showMenu(value, spec.options(), (v) => spec.set(Number(v)))
    })
    const sync = (): void => {
      const t = spec.fmt(spec.get())
      if (value.textContent !== t) value.textContent = t
    }
    this.updaters.push(sync)
    sync()
    return row('xd-set-row', div('xd-set-label', label), value)
  }

  private numRow(label: string, spec: NumSpec): HTMLElement {
    const minus = stepBtn('−', () => spec.set(this.quantize(spec, spec.get() - spec.step)))
    const plus = stepBtn('+', () => spec.set(this.quantize(spec, spec.get() + spec.step)))

    const value = div('xd-set-value xd-set-num')
    const sync = (): void => {
      const t = spec.fmt(spec.get())
      if (value.textContent !== t) value.textContent = t
    }
    this.updaters.push(sync)
    sync()

    /* horizontal drag on the value, DRAG_PX px = full range */
    let dragX = 0
    let dragV = 0
    value.addEventListener('pointerdown', (e) => {
      // Right-click must not start a drag (undefined = synthetic test events).
      if (e.button !== undefined && e.button !== 0) return
      dragX = e.clientX
      dragV = spec.get()
      value.setPointerCapture(e.pointerId)
      value.classList.add('is-dragging')
    })
    value.addEventListener('pointermove', (e) => {
      if (!value.classList.contains('is-dragging')) return
      const span = spec.max - spec.min
      const raw = dragV + ((e.clientX - dragX) / DRAG_PX) * span
      spec.set(this.quantize(spec, raw))
    })
    const endDrag = (): void => value.classList.remove('is-dragging')
    value.addEventListener('pointerup', endDrag)
    value.addEventListener('pointercancel', endDrag)
    // Belt-and-braces: capture can be lost without a pointerup (e.g. the
    // element is re-rendered or the browser steals the pointer).
    value.addEventListener('lostpointercapture', endDrag)

    /* vertical wheel steps; double-click resets to the default */
    value.addEventListener(
      'wheel',
      (e) => {
        if (e.deltaY === 0) return // horizontal scroll is not an edit
        e.preventDefault()
        const dir = e.deltaY < 0 ? 1 : -1
        spec.set(this.quantize(spec, spec.get() + dir * spec.step))
      },
      { passive: false },
    )
    if (spec.def !== undefined) {
      const d = spec.def
      value.addEventListener('dblclick', () => spec.set(d))
      value.title = 'Drag or scroll to adjust; double-click for default'
    } else {
      value.title = 'Drag or scroll to adjust'
    }

    return row('xd-set-row', div('xd-set-label', label), row('xd-set-numwrap', minus, value, plus))
  }

  private quantize(spec: NumSpec, v: number): number {
    const q = Math.round(v / spec.step) * spec.step
    // float-safe for the 0.5-step BPM; integers pass through untouched
    const r = Math.round(q * 100) / 100
    return Math.max(spec.min, Math.min(spec.max, r))
  }

  private chip(label: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'xd-set-chip'
    b.textContent = label
    b.addEventListener('click', fn)
    return b
  }
}
