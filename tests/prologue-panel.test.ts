// @vitest-environment happy-dom
/*
 * prologue Panel <-> Store binding tests (patterned on tests/mono-panel.test.ts):
 * construction at BOTH variants (the 16 shows TIMBRE + VOICE SPREAD +
 * L.F. COMP, the 8 hides them; neither has a step strip or PLAY/REC),
 * variant keybed sizes, the wheels column (spring pitch bend vs held
 * unipolar mod wheel), the EDIT-TIMBRE scoping rebind (the panel's crux),
 * per-timbre voice-mode buttons, the exclusive DELAY/REVERB 3-way, and the
 * ARP ON/LATCH hold gesture. Plus smoke checks of the per-variant
 * display-def / debug-def factories.
 *
 * The prologue synth has no def.ts yet (voice/engine land separately), so
 * the StoreDef is assembled inline from the data layer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/state/store'
import type { StoreDef } from '../src/synths/def'
import { P, PARAMS, PARAM_COUNT, clampParam, TIMBRE_BLOCKS } from '../src/synths/prologue/params'
import {
  SYNTH_ID,
  initProgram,
  cloneProgram,
  serializeProgram,
  deserializeProgram,
} from '../src/synths/prologue/program'
import { Panel, type PanelOpts } from '../src/synths/prologue/panel'
import { makePrologueDisplayDef } from '../src/synths/prologue/display-def'
import { makePrologueDebugDef } from '../src/synths/prologue/debug-def'
import type { PrologueVariant } from '../src/synths/prologue/ids'
import { installLocalStorageMock, pev } from './helpers/dom'

const T1 = TIMBRE_BLOCKS[0]
const T2 = TIMBRE_BLOCKS[1]

const PROLOGUE_TEST_DEF: StoreDef = {
  id: SYNTH_ID,
  params: PARAMS,
  paramCount: PARAM_COUNT,
  clampParam,
  initProgram,
  cloneProgram,
  serializeProgram,
  deserializeProgram,
  factoryPresets: [],
  bankKey: 'prologue-test',
  numSlots: 20,
}

/* ---------------------------------------------------------------- shims */

let restoreLS: () => void

beforeEach(() => {
  restoreLS = installLocalStorageMock().restore
  document.body.innerHTML = ''
})

afterEach(() => {
  restoreLS()
})

function make(variant: PrologueVariant = 16): { store: Store; panel: Panel; opts: PanelOpts } {
  const store = new Store(PROLOGUE_TEST_DEF)
  const opts: PanelOpts = {
    store,
    variant,
    onNoteOn: vi.fn(),
    onNoteOff: vi.fn(),
    onBend: vi.fn(),
    onJoyY: vi.fn(),
    onMaster: vi.fn(),
  }
  const panel = new Panel(opts)
  document.body.appendChild(panel.el)
  return { store, panel, opts }
}

function knob(panel: Panel, scope: string, label: string): HTMLElement {
  const el = panel.el.querySelector<HTMLElement>(`${scope} .xd-knob[aria-label="${label}"]`)
  if (!el) throw new Error(`knob not found: ${scope} ${label}`)
  return el
}

/** Drag a knob all the way up (to max) via pointer events. */
function dragToMax(el: HTMLElement): void {
  el.dispatchEvent(pev('pointerdown', { clientY: 500 }))
  el.dispatchEvent(pev('pointermove', { clientY: -100000 }))
  el.dispatchEvent(pev('pointerup', { clientY: -100000 }))
}

/** Drag a knob all the way down (to min). */
function dragToMin(el: HTMLElement): void {
  el.dispatchEvent(pev('pointerdown', { clientY: 0 }))
  el.dispatchEvent(pev('pointermove', { clientY: 100000 }))
  el.dispatchEvent(pev('pointerup', { clientY: 100000 }))
}

function button(panel: Panel, label: string): HTMLButtonElement {
  const el = panel.el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!el) throw new Error(`button not found: ${label}`)
  return el
}

/** Find a selector-switch position button by its printed label within scope. */
function switchPos(panel: Panel, scope: string, label: string): HTMLButtonElement {
  const btns = panel.el.querySelectorAll<HTMLButtonElement>(`${scope} .xd-selector-pos`)
  const b = Array.from(btns).find((x) => x.textContent === label)
  if (!b) throw new Error(`switch position not found: ${scope} ${label}`)
  return b
}

function wheelEl(panel: Panel, label: string): HTMLElement {
  const el = panel.el.querySelector<HTMLElement>(`.prologue-wheels .xd-hslider[aria-label="${label}"]`)
  if (!el) throw new Error(`wheel not found: ${label}`)
  return el
}

function wheelTrack(el: HTMLElement): HTMLElement {
  const t = el.querySelector<HTMLElement>('.xd-hslider-track')
  if (!t) throw new Error('wheel track not found')
  return t
}

function spin(el: HTMLElement, deltaY: number): void {
  el.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }))
}

const flushMicrotasks = (): Promise<void> => Promise.resolve()

/* ---------------------------------------------------------------- tests */

describe('prologue Panel: construction + variant surface', () => {
  it('builds the family public surface + shared sections at both variants', () => {
    for (const variant of [8, 16] as const) {
      document.body.innerHTML = ''
      const { panel } = make(variant)
      expect(panel.el).toBeInstanceOf(HTMLElement)
      expect(panel.displaySlot.classList.contains('xd-display-slot')).toBe(true)
      expect(panel.keyboard).toBeTruthy()
      expect(typeof panel.setPlayhead).toBe('function')
      expect(typeof panel.setVoices).toBe('function')
      expect(typeof panel.flashMidi).toBe('function')
      for (const sel of [
        '.prologue-sec-master',
        '.prologue-sec-vm',
        '.prologue-sec-vco1',
        '.prologue-sec-vco2',
        '.prologue-sec-modulation',
        '.prologue-sec-multi',
        '.prologue-sec-mixer',
        '.prologue-sec-filter',
        '.prologue-sec-prog',
        '.prologue-sec-amp',
        '.prologue-sec-eg',
        '.prologue-sec-lfo',
        '.prologue-sec-fx',
        '.prologue-sec-arp',
      ]) {
        expect(panel.el.querySelector(sel), `${sel} @ ${variant}`).toBeTruthy()
      }
      // arp-only transport (spec §10): no step strip, no PLAY/REC row
      expect(panel.el.querySelector('.xd-seq-steps')).toBeNull()
      expect(panel.el.querySelector('button[aria-label="REC"]')).toBeNull()
      expect(panel.el.querySelector('button[aria-label="PLAY"]')).toBeNull()
    }
  })

  it('16 shows TIMBRE + VOICE SPREAD + L.F. COMP; 8 hides them', () => {
    const { panel: p16 } = make(16)
    expect(p16.el.querySelector('.prologue-sec-timbre')).toBeTruthy()
    expect(p16.el.querySelector('.prologue-sec-lfcomp')).toBeTruthy()
    expect(p16.el.querySelector('.xd-knob[aria-label="VOICE SPREAD"]')).toBeTruthy()

    document.body.innerHTML = ''
    const { panel: p8 } = make(8)
    expect(p8.el.querySelector('.prologue-sec-timbre')).toBeNull()
    expect(p8.el.querySelector('.prologue-sec-lfcomp')).toBeNull()
    expect(p8.el.querySelector('.xd-knob[aria-label="VOICE SPREAD"]')).toBeNull()
  })

  it('keybed sizes per variant: 49 keys (E1..E5) / 61 keys (C2..C7)', () => {
    const { panel: p8 } = make(8)
    const keys8 = Array.from(p8.el.querySelectorAll<HTMLElement>('.xd-key'))
    expect(keys8.length).toBe(49)
    const notes8 = keys8.map((k) => Number(k.dataset.note)).sort((a, b) => a - b)
    expect(notes8[0]).toBe(28)
    expect(notes8[48]).toBe(76)

    document.body.innerHTML = ''
    const { panel: p16 } = make(16)
    const keys16 = Array.from(p16.el.querySelectorAll<HTMLElement>('.xd-key'))
    expect(keys16.length).toBe(61)
    const notes16 = keys16.map((k) => Number(k.dataset.note)).sort((a, b) => a - b)
    expect(notes16[0]).toBe(36)
    expect(notes16[60]).toBe(96)
  })
})

describe('prologue Panel: wheels column', () => {
  it('pitch wheel is a vertical bipolar spring bender feeding onBend', async () => {
    const { panel, opts } = make(8)
    const pitch = wheelEl(panel, 'PITCH')
    expect(pitch.classList.contains('xd-hslider--v')).toBe(true)
    expect(pitch.getAttribute('aria-orientation')).toBe('vertical')
    expect(pitch.getAttribute('aria-valuemin')).toBe('-1')

    const t = wheelTrack(pitch)
    t.dispatchEvent(pev('pointerdown', { clientY: 10 }))
    spin(pitch, -1) // wheel steps work mid-drag: +0.05 each (float-noise-rounded)
    spin(pitch, -1)
    spin(pitch, -1)
    expect(opts.onBend).toHaveBeenCalledWith(0.15)
    t.dispatchEvent(pev('pointerup'))

    // spring-return: rAF path or the fallback timer, both settle < 400ms
    await new Promise((r) => setTimeout(r, 400))
    expect(pitch.getAttribute('aria-valuenow')).toBe('0')
    const calls = (opts.onBend as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.at(-1)?.[0]).toBe(0)
    expect(opts.onJoyY).not.toHaveBeenCalled()
  })

  it('mod wheel is unipolar (0..1), holds its position, feeds onJoyY', async () => {
    const { panel, opts } = make(8)
    const mod = wheelEl(panel, 'MOD')
    expect(mod.classList.contains('xd-hslider--v')).toBe(true)
    expect(mod.getAttribute('aria-valuemin')).toBe('0')
    expect(mod.getAttribute('aria-valuemax')).toBe('1')

    const t = wheelTrack(mod)
    // degenerate happy-dom rect: a unipolar press lands at travel center 0.5
    t.dispatchEvent(pev('pointerdown', { clientY: 10 }))
    t.dispatchEvent(pev('pointerup'))
    expect(opts.onJoyY).toHaveBeenCalledWith(0.5)

    // non-spring: the cap stays where it was left
    await new Promise((r) => setTimeout(r, 250))
    expect(mod.getAttribute('aria-valuenow')).toBe('0.5')
    expect(opts.onBend).not.toHaveBeenCalled()
  })
})

describe('prologue Panel: timbre scoping (EDIT TIMBRE rebind)', () => {
  it('CUTOFF drags write t1 by default, t2 after EDIT TIMBRE -> Sub; the rebind resync is silent', () => {
    const { store, panel } = make(16)
    const el = knob(panel, '.prologue-sec-filter', 'CUTOFF')

    // default scope: MAIN (t1)
    dragToMin(el)
    expect(store.getParam(T1.cutoff)).toBe(0)
    expect(store.getParam(T2.cutoff)).toBe(1023) // untouched

    // pre-set a distinct t2 value, then re-scope to SUB
    store.setParam(T2.cutoff, 333, 'menu')
    const uiEvents: number[] = []
    store.onParam((id, _v, source) => {
      if (source === 'ui') uiEvents.push(id)
    })
    store.setParam(P.EDIT_TIMBRE, 2, 'menu') // Sub
    expect(el.getAttribute('aria-valuenow')).toBe('333') // silently resynced
    expect(uiEvents.length).toBe(0) // no echo from the rebind

    // edits now land on t2, t1 stays put
    dragToMax(el)
    expect(store.getParam(T2.cutoff)).toBe(1023)
    expect(store.getParam(T1.cutoff)).toBe(0)

    // '+' (Main+Sub) edits MAIN (UNCONFIRMED hardware behavior, spec §3)
    store.setParam(P.EDIT_TIMBRE, 1, 'menu')
    expect(el.getAttribute('aria-valuenow')).toBe('0') // back on t1
  })

  it('external (midi) changes resync only the ADDRESSED timbre block', () => {
    const { store, panel } = make(8)
    const el = knob(panel, '.prologue-sec-filter', 'RESONANCE')
    // current scope is MAIN: a t2 change must not move the knob...
    store.setParam(T2.resonance, 700, 'midi')
    expect(el.getAttribute('aria-valuenow')).toBe('0')
    // ...but a t1 change does, silently
    const uiEvents: number[] = []
    store.onParam((id, _v, source) => {
      if (source === 'ui') uiEvents.push(id)
    })
    store.setParam(T1.resonance, 512, 'midi')
    expect(el.getAttribute('aria-valuenow')).toBe('512')
    expect(uiEvents.length).toBe(0)
  })

  it('voice-mode buttons bind the edited timbre and re-light on rescope', async () => {
    const { store, panel } = make(16)
    const mono = button(panel, 'MONO')
    mono.dispatchEvent(pev('pointerdown'))
    mono.dispatchEvent(pev('pointerup'))
    await flushMicrotasks()
    expect(store.getParam(T1.voiceMode)).toBe(1)
    expect(store.getParam(T2.voiceMode)).toBe(0)

    store.setParam(P.EDIT_TIMBRE, 2, 'menu') // Sub
    const uni = button(panel, 'UNISON')
    uni.dispatchEvent(pev('pointerdown'))
    uni.dispatchEvent(pev('pointerup'))
    await flushMicrotasks()
    expect(store.getParam(T2.voiceMode)).toBe(2)
    expect(store.getParam(T1.voiceMode)).toBe(1) // untouched
    // LEDs follow the SUB block now
    expect(uni.querySelector<HTMLElement>('.xd-ledbtn-led')!.style.getPropertyValue('--b')).toBe('1')
    expect(mono.querySelector<HTMLElement>('.xd-ledbtn-led')!.style.getPropertyValue('--b')).toBe('0')
  })

  it("the 16's PANEL switch prints SUB/+/MAIN and maps reversed onto EDIT TIMBRE", () => {
    const { store, panel } = make(16)
    const labels = Array.from(
      panel.el.querySelectorAll<HTMLElement>('.prologue-sec-timbre .xd-selector-pos'),
    ).map((b) => b.textContent)
    expect(labels).toContain('SUB')
    expect(labels).toContain('+')
    expect(labels).toContain('MAIN')

    switchPos(panel, '.prologue-sec-timbre', 'SUB').click()
    expect(store.getParam(P.EDIT_TIMBRE)).toBe(2)
    switchPos(panel, '.prologue-sec-timbre', 'MAIN').click()
    expect(store.getParam(P.EDIT_TIMBRE)).toBe(0)
    switchPos(panel, '.prologue-sec-timbre', '+').click()
    expect(store.getParam(P.EDIT_TIMBRE)).toBe(1)

    // external changes land on the reversed position
    store.setParam(P.EDIT_TIMBRE, 2, 'midi')
    expect(switchPos(panel, '.prologue-sec-timbre', 'SUB').classList.contains('is-active')).toBe(true)
  })
})

describe('prologue Panel: EFFECT + ARP', () => {
  it('the exclusive DELAY/REVERB 3-way binds DLRV SELECT (OFF/DELAY/REVERB)', () => {
    const { store, panel } = make(8)
    expect(store.getParam(P.DLRV_SELECT)).toBe(0)
    switchPos(panel, '.prologue-sec-fx', 'DELAY').click()
    expect(store.getParam(P.DLRV_SELECT)).toBe(1)
    switchPos(panel, '.prologue-sec-fx', 'REVERB').click()
    expect(store.getParam(P.DLRV_SELECT)).toBe(2)
    switchPos(panel, '.prologue-sec-fx', 'OFF').click()
    expect(store.getParam(P.DLRV_SELECT)).toBe(0)
  })

  it('ARP ON/LATCH: tap toggles Off <-> On; hold >500ms latches (blink)', async () => {
    const { store, panel } = make(8)
    const btn = button(panel, 'ON/LATCH')
    const root = btn.parentElement!
    const nowSpy = vi.spyOn(Date, 'now')

    // tap: Off -> On, LED lit
    nowSpy.mockReturnValue(1000)
    btn.dispatchEvent(pev('pointerdown'))
    nowSpy.mockReturnValue(1100)
    btn.dispatchEvent(pev('pointerup'))
    await flushMicrotasks()
    expect(store.getParam(P.ARP_ON_LATCH)).toBe(1)
    expect(btn.querySelector<HTMLElement>('.xd-ledbtn-led')!.style.getPropertyValue('--b')).toBe('1')
    expect(root.classList.contains('xd-blink')).toBe(false)

    // tap again: On -> Off
    nowSpy.mockReturnValue(2000)
    btn.dispatchEvent(pev('pointerdown'))
    nowSpy.mockReturnValue(2100)
    btn.dispatchEvent(pev('pointerup'))
    await flushMicrotasks()
    expect(store.getParam(P.ARP_ON_LATCH)).toBe(0)

    // long hold: latch + blinking LED
    nowSpy.mockReturnValue(3000)
    btn.dispatchEvent(pev('pointerdown'))
    nowSpy.mockReturnValue(3600)
    btn.dispatchEvent(pev('pointerup'))
    await flushMicrotasks()
    expect(store.getParam(P.ARP_ON_LATCH)).toBe(2)
    expect(root.classList.contains('xd-blink')).toBe(true)

    // long hold again: release the latch
    nowSpy.mockReturnValue(4000)
    btn.dispatchEvent(pev('pointerdown'))
    nowSpy.mockReturnValue(4600)
    btn.dispatchEvent(pev('pointerup'))
    await flushMicrotasks()
    expect(store.getParam(P.ARP_ON_LATCH)).toBe(0)
    expect(root.classList.contains('xd-blink')).toBe(false)
    nowSpy.mockRestore()
  })

  it('TEMPO knob steps in 0.1 BPM increments and binds seq bpm', () => {
    const { store, panel } = make(8)
    const tempo = knob(panel, '.prologue-sec-arp', 'TEMPO')
    const before = store.program.seq.bpm
    tempo.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
    )
    expect(store.program.seq.bpm).toBeCloseTo(before + 0.1, 5)
    expect(tempo.getAttribute('aria-valuetext')).toBe((before + 0.1).toFixed(1))
  })
})

describe('prologue display-def / debug-def factories', () => {
  it("the 8's menu folds in the TIMBRE switches; the 16 keeps the strict menu list", () => {
    const d8 = makePrologueDisplayDef(8)
    const d16 = makePrologueDisplayDef(16)
    expect(d8.transport).toBe('arp')
    expect(d16.transport).toBe('arp')
    const ids8 = new Set(d8.menuParams.map((p) => p.id))
    const ids16 = new Set(d16.menuParams.map((p) => p.id))
    for (const id of [P.SUB_ON, P.EDIT_TIMBRE, P.TIMBRE_TYPE]) {
      expect(ids8.has(id)).toBe(true)
      expect(ids16.has(id)).toBe(false)
    }
    // both carry per-timbre menu pages (voice spread reachable on the 8)
    expect(ids8.has(T1.voiceSpread)).toBe(true)
    expect(ids8.has(T2.voiceSpread)).toBe(true)
  })

  it('debug-def factory carries the variant voice count + prologue stages', () => {
    const d8 = makePrologueDebugDef(8)
    const d16 = makePrologueDebugDef(16)
    expect(d8.numVoices).toBe(8)
    expect(d16.numVoices).toBe(16)
    expect(d16.sumBadge.label).toBe('Σ ×16')
    expect(d16.stages.map((s) => s.label)).toEqual([
      'VCO 1', 'VCO 2', 'MULTI', 'MIX', 'VCF', 'VCA', 'MOD FX', 'DL-RV', 'OUTPUT',
    ])
    // FX cells are stereo pairs; voice cells are not
    expect(d16.stages[6].r).toBe(7)
    expect(d16.stages[8].r).toBe(11)
  })
})
