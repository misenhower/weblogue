// @vitest-environment happy-dom
/*
 * Settings drawer tests.
 *
 * COVERAGE: every kind:'menu' param of each synth's PARAMS table appears
 * exactly once across its SettingsDef tabs/groups (no omissions, no
 * duplicates, no strays) — the guard that catches drift when params are
 * added later. The prologue-8 additionally folds in the three switch-kind
 * TIMBRE params (its only access to them — no panel section on the 8).
 *
 * BEHAVIOR (xd, happy-dom): enum rows open an .xd-menu popover and picks go
 * through store.setParam with source 'menu'; numeric rows step and clamp;
 * external param changes refresh row text (coalesced via queueMicrotask);
 * toggle() flips is-open; the auto-appended SEQUENCER/MOTION groups route
 * through setSeqField / setMotionLane / clearMotionLane.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/state/store'
import { SettingsDrawer, type SettingsDef } from '../src/ui/settings'
import { closeMenu } from '../src/ui/menu'
import type { ParamMeta } from '../src/shared/paramdef'

import { XD_DEF } from '../src/synths/xd/def'
import { XD_DISPLAY_DEF } from '../src/synths/xd/display-def'
import { XD_SETTINGS_DEF } from '../src/synths/xd/settings-def'
import { P as XP, PARAMS as XD_PARAMS, MOTION_PARAM_IDS } from '../src/synths/xd/params'

import { OG_SETTINGS_DEF } from '../src/synths/og/settings-def'
import { PARAMS as OG_PARAMS } from '../src/synths/og/params'

import { MONO_SETTINGS_DEF } from '../src/synths/mono/settings-def'
import { P as MP, PARAMS as MONO_PARAMS } from '../src/synths/mono/params'

import { prologueSettingsDef } from '../src/synths/prologue/settings-def'
import { P as PP, PARAMS as PRO_PARAMS } from '../src/synths/prologue/params'

/* ================================================================ coverage */

/** All param ids of a SettingsDef, in tab/group order (with repeats). */
function collectIds(def: SettingsDef): number[] {
  return def.tabs.flatMap((t) => t.groups.flatMap((g) => [...g.ids]))
}

/** id -> readable name for failure messages. */
function nameOf(params: readonly ParamMeta[], id: number): string {
  return params.find((p) => p.id === id)?.key ?? `#${id}`
}

/**
 * Assert def covers each kind:'menu' id of `params` exactly once, plus
 * exactly the ids in `extras` (non-menu params deliberately folded in),
 * and nothing else. Failures print param keys, not bare ids.
 */
function expectExactCoverage(def: SettingsDef, params: readonly ParamMeta[], extras: readonly number[] = []): void {
  const ids = collectIds(def)
  const named = (list: number[]): string[] => list.map((id) => nameOf(params, id))

  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
  expect(named(dupes), 'ids listed more than once').toEqual([])

  const menuIds = params.filter((p) => p.kind === 'menu').map((p) => p.id)
  const present = new Set(ids)
  const missing = menuIds.filter((id) => !present.has(id))
  expect(named(missing), 'menu params missing from the def').toEqual([])

  const allowed = new Set<number>([...menuIds, ...extras])
  const strays = ids.filter((id) => !allowed.has(id))
  expect(named(strays), 'non-menu ids not in the allowed extras').toEqual([])

  const missingExtras = extras.filter((id) => !present.has(id))
  expect(named(missingExtras), 'expected extras absent').toEqual([])
}

describe('settings-def coverage: every menu param exactly once', () => {
  it('xd: XD_SETTINGS_DEF covers all xd menu params', () => {
    expectExactCoverage(XD_SETTINGS_DEF, XD_PARAMS)
  })

  it('og: OG_SETTINGS_DEF covers all og menu params', () => {
    expectExactCoverage(OG_SETTINGS_DEF, OG_PARAMS)
  })

  it('mono: MONO_SETTINGS_DEF covers all mono menu params, incl. VCO1 OCTAVE', () => {
    expectExactCoverage(MONO_SETTINGS_DEF, MONO_PARAMS)
    // OLED-hidden on hardware; the drawer is its only UI reach — pin it.
    expect(collectIds(MONO_SETTINGS_DEF)).toContain(MP.VCO1_OCTAVE)
  })

  it('prologue-8: all menu params once, plus the folded-in TIMBRE switches', () => {
    const def = prologueSettingsDef(8)
    expectExactCoverage(def, PRO_PARAMS, [PP.SUB_ON, PP.EDIT_TIMBRE, PP.TIMBRE_TYPE])
    // The four TIMBRE items: three switch-kind + menu-kind BALANCE.
    const ids = collectIds(def)
    for (const id of [PP.SUB_ON, PP.EDIT_TIMBRE, PP.TIMBRE_TYPE, PP.BALANCE]) {
      expect(ids, `timbre item ${nameOf(PRO_PARAMS, id)}`).toContain(id)
    }
  })

  it('prologue-16: all menu params once, no switch extras (panel has them)', () => {
    const def = prologueSettingsDef(16)
    expectExactCoverage(def, PRO_PARAMS)
    const ids = collectIds(def)
    for (const id of [PP.SUB_ON, PP.EDIT_TIMBRE, PP.TIMBRE_TYPE]) {
      expect(ids, `switch ${nameOf(PRO_PARAMS, id)} must stay panel-only on the 16`).not.toContain(id)
    }
    expect(ids).toContain(PP.BALANCE) // menu-kind: on both variants
  })
})

/* ================================================================ behavior */

beforeEach(() => {
  try {
    localStorage.clear()
  } catch {
    /* no storage in this env: persist falls back to factory data */
  }
  document.body.innerHTML = ''
})

afterEach(() => {
  closeMenu()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function make(): { store: Store; drawer: SettingsDrawer } {
  const store = new Store(XD_DEF)
  const drawer = new SettingsDrawer({ store, displayDef: XD_DISPLAY_DEF, def: XD_SETTINGS_DEF })
  document.body.appendChild(drawer.el)
  return { store, drawer }
}

/** The .xd-set-row whose label text is exactly `label`. */
function rowByLabel(drawer: SettingsDrawer, label: string): HTMLElement {
  const rows = Array.from(drawer.el.querySelectorAll<HTMLElement>('.xd-set-row'))
  const r = rows.find((el) => el.querySelector('.xd-set-label')?.textContent === label)
  if (!r) throw new Error('missing settings row: ' + label)
  return r
}

function stepButtons(row: HTMLElement): { minus: HTMLButtonElement; plus: HTMLButtonElement } {
  const btns = row.querySelectorAll<HTMLButtonElement>('.xd-set-step')
  if (btns.length !== 2) throw new Error('expected 2 step buttons, got ' + btns.length)
  return { minus: btns[0], plus: btns[1] } // numwrap order: [−] value [+]
}

function openMenuItems(): HTMLButtonElement[] {
  const menu = document.body.querySelector('.xd-menu')
  if (!menu) throw new Error('no .xd-menu open')
  return Array.from(menu.querySelectorAll<HTMLButtonElement>('.xd-menu-item'))
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('SettingsDrawer behavior (xd)', () => {
  it('enum row: click opens an .xd-menu, picking calls setParam with source "menu"', () => {
    const { store, drawer } = make()
    store.setParam(XP.PORTAMENTO_MODE, 0, 'load') // known start: Auto

    const events: Array<{ id: number; v: number; source: string }> = []
    store.onParam((id, v, source) => events.push({ id, v, source }))

    const valueBtn = rowByLabel(drawer, 'PORTAMENTO MODE').querySelector<HTMLButtonElement>('.xd-set-value')
    expect(valueBtn).not.toBeNull()
    expect(document.body.querySelector('.xd-menu')).toBeNull()
    valueBtn!.click()

    const items = openMenuItems()
    expect(items.map((i) => i.textContent)).toEqual(['Auto', 'On'])
    expect(items[0].classList.contains('is-selected')).toBe(true)

    items[1].click() // pick 'On'
    expect(store.getParam(XP.PORTAMENTO_MODE)).toBe(1)
    expect(events).toEqual([{ id: XP.PORTAMENTO_MODE, v: 1, source: 'menu' }])
    expect(document.body.querySelector('.xd-menu')).toBeNull() // closed on pick
  })

  it('numeric row: +/− step by 1 and clamp at min/max', () => {
    const { store, drawer } = make()
    const { minus, plus } = stepButtons(rowByLabel(drawer, 'PROGRAM LEVEL')) // range 12..132

    store.setParam(XP.PROGRAM_LEVEL, 100, 'load')
    plus.click()
    expect(store.getParam(XP.PROGRAM_LEVEL)).toBe(101)
    minus.click()
    minus.click()
    expect(store.getParam(XP.PROGRAM_LEVEL)).toBe(99)

    store.setParam(XP.PROGRAM_LEVEL, 132, 'load')
    plus.click()
    expect(store.getParam(XP.PROGRAM_LEVEL)).toBe(132) // clamped at max

    store.setParam(XP.PROGRAM_LEVEL, 12, 'load')
    minus.click()
    expect(store.getParam(XP.PROGRAM_LEVEL)).toBe(12) // clamped at min
  })

  it('external setParam refreshes the displayed value while open (coalesced)', async () => {
    const { store, drawer } = make()
    drawer.toggle(true)

    const value = rowByLabel(drawer, 'PROGRAM LEVEL').querySelector<HTMLElement>('.xd-set-num')!
    const before = XD_DISPLAY_DEF.formatParam(XP.PROGRAM_LEVEL, store.getParam(XP.PROGRAM_LEVEL))
    expect(value.textContent).toBe(before)

    store.setParam(XP.PROGRAM_LEVEL, 120, 'ui')
    await flush() // refresh coalesces via queueMicrotask
    expect(value.textContent).toBe(XD_DISPLAY_DEF.formatParam(XP.PROGRAM_LEVEL, 120))
  })

  it('toggle(true/false) flips the is-open class', () => {
    const { drawer } = make()
    expect(drawer.open).toBe(false)
    expect(drawer.el.classList.contains('is-open')).toBe(false)
    drawer.toggle(true)
    expect(drawer.open).toBe(true)
    expect(drawer.el.classList.contains('is-open')).toBe(true)
    drawer.toggle(false)
    expect(drawer.open).toBe(false)
    expect(drawer.el.classList.contains('is-open')).toBe(false)
  })

  it('SEQUENCER group: the BPM row edits through setSeqField', () => {
    const { store, drawer } = make()
    const seqSpy = vi.spyOn(store, 'setSeqField')
    const { minus, plus } = stepButtons(rowByLabel(drawer, 'BPM'))
    const before = store.program.seq.bpm

    plus.click()
    expect(seqSpy).toHaveBeenCalledWith('bpm', before + 0.5)
    expect(store.program.seq.bpm).toBe(before + 0.5)
    minus.click()
    minus.click()
    expect(store.program.seq.bpm).toBe(before - 0.5)
  })

  it('MOTION rows: assign/chips go through setMotionLane, ✕ through clearMotionLane', () => {
    const { store, drawer } = make()
    const laneSpy = vi.spyOn(store, 'setMotionLane')
    const clearSpy = vi.spyOn(store, 'clearMotionLane')
    const rows = drawer.el.querySelectorAll<HTMLElement>('.xd-set-motionrow')
    expect(rows.length).toBeGreaterThan(0)
    const m1 = rows[0]

    // ASSIGN popover: '---' first, then the motion params; pick the first param.
    m1.querySelector<HTMLButtonElement>('.xd-set-assign')!.click()
    const items = openMenuItems()
    expect(items[0].textContent).toBe('---')
    expect(items.length).toBe(1 + MOTION_PARAM_IDS.length)
    items[1].click()
    expect(laneSpy).toHaveBeenCalledWith(0, { paramId: MOTION_PARAM_IDS[0] })
    expect(store.program.seq.motion[0].paramId).toBe(MOTION_PARAM_IDS[0])

    // ON / SMOOTH chips toggle their flags.
    const chips = m1.querySelectorAll<HTMLButtonElement>('.xd-set-chip')
    expect(chips.length).toBe(2)
    chips[0].click()
    expect(laneSpy).toHaveBeenCalledWith(0, { on: true })
    expect(store.program.seq.motion[0].on).toBe(true)
    chips[1].click()
    expect(laneSpy).toHaveBeenCalledWith(0, { smooth: true })
    expect(store.program.seq.motion[0].smooth).toBe(true)

    // ✕ clears the lane.
    m1.querySelector<HTMLButtonElement>('.xd-set-clear')!.click()
    expect(clearSpy).toHaveBeenCalledWith(0)
    expect(store.program.seq.motion[0]).toMatchObject({ paramId: -1, on: false, smooth: false })
  })
})
