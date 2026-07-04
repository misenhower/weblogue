// @vitest-environment happy-dom
/*
 * monologue Panel <-> Store binding tests (patterned on tests/og-panel.test.ts):
 * construction + public surface (always-visible step strip, 25-key keybed),
 * knob edits reaching the store, the reversed-label 3-position switches
 * (EG TYPE, SYNC/RING), the KEY TRG/HOLD tap/hold gesture, and the
 * MOTION/SLIDE/NOTE step-edit switch behaviors (slide flag toggling through
 * the store, motion-presence LEDs, family NOTE-mode step edit).
 *
 * The mono synth has no def.ts yet (voice/engine land separately), so the
 * StoreDef is assembled inline from the data layer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/state/store'
import type { StoreDef } from '../src/synths/def'
import { P, PARAMS, PARAM_COUNT, clampParam } from '../src/synths/mono/params'
import {
  SYNTH_ID,
  initProgram,
  cloneProgram,
  serializeProgram,
  deserializeProgram,
} from '../src/synths/mono/program'
import { Panel, type PanelOpts } from '../src/synths/mono/panel'
import { installLocalStorageMock, pev } from './helpers/dom'

const MONO_TEST_DEF: StoreDef = {
  id: SYNTH_ID,
  params: PARAMS,
  paramCount: PARAM_COUNT,
  clampParam,
  initProgram,
  cloneProgram,
  serializeProgram,
  deserializeProgram,
  factoryPresets: [],
  bankKey: 'mono-test',
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

function make(): { store: Store; panel: Panel; opts: PanelOpts } {
  const store = new Store(MONO_TEST_DEF)
  const opts: PanelOpts = {
    store,
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

function stepButtons(panel: Panel): HTMLElement[] {
  return Array.from(panel.el.querySelectorAll<HTMLElement>('.mono-seq-steps .xd-step'))
}

function pressStep(panel: Panel, i: number): void {
  const s = stepButtons(panel)[i]
  s.dispatchEvent(pev('pointerdown'))
  s.dispatchEvent(pev('pointerup'))
}

function sliderEl(panel: Panel): HTMLElement {
  const el = panel.el.querySelector<HTMLElement>('.mono-slider-block .xd-hslider')
  if (!el) throw new Error('slider not found')
  return el
}

function wheel(el: HTMLElement, deltaY: number): void {
  el.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }))
}

const flushMicrotasks = (): Promise<void> => Promise.resolve()

/* ---------------------------------------------------------------- tests */

describe('mono Panel: construction + public surface', () => {
  it('builds and exposes the family public surface', () => {
    const { panel } = make()
    expect(panel.el).toBeInstanceOf(HTMLElement)
    expect(panel.displaySlot.classList.contains('xd-display-slot')).toBe(true)
    expect(panel.keyboard).toBeTruthy()
    expect(typeof panel.setPlayhead).toBe('function')
    expect(typeof panel.setVoices).toBe('function')
    expect(typeof panel.flashMidi).toBe('function')
    // hardware-faithful sections present (spec §2)
    for (const sel of [
      '.mono-sec-master',
      '.mono-sec-vco1',
      '.mono-sec-vco2',
      '.mono-sec-mixer',
      '.mono-sec-filter',
      '.mono-sec-eg',
      '.mono-sec-lfo',
      '.mono-sec-prog',
    ]) {
      expect(panel.el.querySelector(sel), sel).toBeTruthy()
    }
    // no og/xd-only concepts
    expect(panel.el.querySelector('.og-sec-vm')).toBeNull()
    expect(panel.el.querySelector('.xd-sec-multi')).toBeNull()
    expect(panel.el.querySelector('.xd-sec-fx')).toBeNull()
  })

  it('shows the 16-step strip by default — the hardware has the buttons', () => {
    const { panel } = make()
    const steps = stepButtons(panel)
    expect(steps.length).toBe(16)
    const wrap = panel.el.querySelector<HTMLElement>('.mono-seq-steps')!
    expect(wrap.hidden).toBe(false)
    // no og-style show/hide chip
    expect(panel.el.querySelector('.og-steps-chip')).toBeNull()
  })

  it('has the 25-key E-to-E keybed (MIDI 52..76)', () => {
    const { panel } = make()
    const keys = Array.from(panel.el.querySelectorAll<HTMLElement>('.xd-key'))
    expect(keys.length).toBe(25)
    const notes = keys.map((k) => Number(k.dataset.note)).sort((a, b) => a - b)
    expect(notes[0]).toBe(52)
    expect(notes[24]).toBe(76)
  })
})

describe('mono Panel: param knobs <-> store', () => {
  it('dragging the CUTOFF knob updates store P.CUTOFF', () => {
    const { store, panel } = make()
    const el = knob(panel, '.mono-sec-filter', 'CUTOFF')
    dragToMin(el)
    expect(store.getParam(P.CUTOFF)).toBe(0)
    dragToMax(el)
    expect(store.getParam(P.CUTOFF)).toBe(1023)
  })

  it('the MASTER section DRIVE knob binds the continuous P.DRIVE', () => {
    const { store, panel } = make()
    dragToMax(knob(panel, '.mono-sec-master', 'DRIVE'))
    expect(store.getParam(P.DRIVE)).toBe(1023)
    dragToMin(knob(panel, '.mono-sec-master', 'DRIVE'))
    expect(store.getParam(P.DRIVE)).toBe(0)
  })

  it('external (midi) param changes resync the knob silently', () => {
    const { store, panel } = make()
    const el = knob(panel, '.mono-sec-filter', 'RESONANCE')
    const uiEvents: number[] = []
    store.onParam((id, _v, source) => {
      if (source === 'ui') uiEvents.push(id)
    })
    store.setParam(P.RESONANCE, 700, 'midi')
    expect(el.getAttribute('aria-valuenow')).toBe('700')
    expect(uiEvents.length).toBe(0) // silent resync: no ui echo back into store
    expect(store.getParam(P.RESONANCE)).toBe(700)
  })

  it('MASTER knob drives onMaster with 0..1', () => {
    const { panel, opts } = make()
    const el = knob(panel, '.mono-sec-master', 'MASTER')
    dragToMin(el)
    expect(opts.onMaster).toHaveBeenCalledWith(0)
    dragToMax(el)
    expect(opts.onMaster).toHaveBeenCalledWith(1)
  })

  it('OCTAVE param moves the keybed octave shift', () => {
    const { store, panel } = make()
    store.setParam(P.OCTAVE, 4, 'midi')
    expect(panel.keyboard.octaveShift).toBe(2)
    store.setParam(P.OCTAVE, 0, 'midi')
    expect(panel.keyboard.octaveShift).toBe(-2)
  })

  it('program load resyncs knob values to the new program silently', () => {
    const { store, panel } = make()
    const el = knob(panel, '.mono-sec-filter', 'CUTOFF')
    store.setParam(P.CUTOFF, 111, 'midi')
    expect(el.getAttribute('aria-valuenow')).toBe('111')
    const uiEvents: number[] = []
    store.onParam((id, _v, source) => {
      if (source === 'ui') uiEvents.push(id)
    })
    store.loadSlot(1)
    expect(el.getAttribute('aria-valuenow')).toBe(String(store.getParam(P.CUTOFF)))
    expect(store.getParam(P.CUTOFF)).not.toBe(111)
    expect(uiEvents.length).toBe(0)
  })
})

describe('mono Panel: reversed-label 3-position switches', () => {
  it('EG TYPE prints A/D | A/G/D | GATE and maps to the stored enum (0=GATE)', () => {
    const { store, panel } = make()
    // silkscreen order top-to-bottom (spec §5 note in params.ts)
    const labels = Array.from(
      panel.el.querySelectorAll<HTMLElement>('.mono-sec-eg .xd-selector-pos'),
    ).map((b) => b.textContent)
    expect(labels.slice(0, 3)).toEqual(['A/D', 'A/G/D', 'GATE'])

    switchPos(panel, '.mono-sec-eg', 'GATE').click()
    expect(store.getParam(P.EG_TYPE)).toBe(0)
    switchPos(panel, '.mono-sec-eg', 'A/D').click()
    expect(store.getParam(P.EG_TYPE)).toBe(2)
    switchPos(panel, '.mono-sec-eg', 'A/G/D').click()
    expect(store.getParam(P.EG_TYPE)).toBe(1)
  })

  it('external EG TYPE changes land on the reversed position', () => {
    const { store, panel } = make()
    store.setParam(P.EG_TYPE, 0, 'midi') // stored 0 = GATE = bottom position
    expect(switchPos(panel, '.mono-sec-eg', 'GATE').classList.contains('is-active')).toBe(true)
    store.setParam(P.EG_TYPE, 2, 'midi') // stored 2 = A/D = top position
    expect(switchPos(panel, '.mono-sec-eg', 'A/D').classList.contains('is-active')).toBe(true)
  })

  it('SYNC/RING prints SYNC/OFF/RING and maps to byte-32 order (0=RING)', () => {
    const { store, panel } = make()
    expect(store.getParam(P.SYNC_RING)).toBe(1) // default OFF
    switchPos(panel, '.mono-sec-vco2', 'SYNC').click()
    expect(store.getParam(P.SYNC_RING)).toBe(2)
    switchPos(panel, '.mono-sec-vco2', 'RING').click()
    expect(store.getParam(P.SYNC_RING)).toBe(0)
  })
})

describe('mono Panel: KEY TRG/HOLD button', () => {
  it('tap cycles Off <-> KEY TRG; hold >500ms latches HOLD (blink)', async () => {
    const { store, panel } = make()
    const btn = button(panel, 'KEY TRG/HOLD')
    const root = btn.parentElement!
    const nowSpy = vi.spyOn(Date, 'now')

    // tap: Off -> KEY TRG, LED lit
    nowSpy.mockReturnValue(1000)
    btn.dispatchEvent(pev('pointerdown'))
    nowSpy.mockReturnValue(1100)
    btn.dispatchEvent(pev('pointerup'))
    await flushMicrotasks() // LED re-assert after the momentary release
    expect(store.getParam(P.KEY_TRIG)).toBe(1)
    expect(btn.querySelector<HTMLElement>('.xd-ledbtn-led')!.style.getPropertyValue('--b')).toBe('1')
    expect(root.classList.contains('xd-blink')).toBe(false)

    // tap again: KEY TRG -> Off
    nowSpy.mockReturnValue(2000)
    btn.dispatchEvent(pev('pointerdown'))
    nowSpy.mockReturnValue(2100)
    btn.dispatchEvent(pev('pointerup'))
    await flushMicrotasks()
    expect(store.getParam(P.KEY_TRIG)).toBe(0)
    expect(btn.querySelector<HTMLElement>('.xd-ledbtn-led')!.style.getPropertyValue('--b')).toBe('0')

    // long hold: latch HOLD + blinking LED
    nowSpy.mockReturnValue(3000)
    btn.dispatchEvent(pev('pointerdown'))
    nowSpy.mockReturnValue(3600)
    btn.dispatchEvent(pev('pointerup'))
    await flushMicrotasks()
    expect(store.getParam(P.KEY_TRIG)).toBe(2)
    expect(root.classList.contains('xd-blink')).toBe(true)

    // long hold again: release HOLD
    nowSpy.mockReturnValue(4000)
    btn.dispatchEvent(pev('pointerdown'))
    nowSpy.mockReturnValue(4600)
    btn.dispatchEvent(pev('pointerup'))
    await flushMicrotasks()
    expect(store.getParam(P.KEY_TRIG)).toBe(0)
    expect(root.classList.contains('xd-blink')).toBe(false)
    nowSpy.mockRestore()
  })
})

describe('mono Panel: MOTION/SLIDE/NOTE step-edit switch', () => {
  it('defaults to NOTE: step press toggles a step that has notes', () => {
    const { store, panel } = make()
    store.setStep(0, [60], [100], [54])
    expect(store.program.seq.steps[0].on).toBe(true)
    pressStep(panel, 0)
    expect(store.program.seq.steps[0].on).toBe(false)
    pressStep(panel, 0)
    expect(store.program.seq.steps[0].on).toBe(true)
  })

  it('SLIDE mode toggles a step slide flag through the store + dim LED', async () => {
    const { store, panel } = make()
    switchPos(panel, '.mono-row-seq', 'SLIDE').click()
    pressStep(panel, 3)
    expect(store.program.seq.steps[3].slide).toBe(true)
    await flushMicrotasks() // seq notify is microtask-coalesced
    expect(stepButtons(panel)[3].classList.contains('xd-step--dim')).toBe(true)
    expect(stepButtons(panel)[4].classList.contains('xd-step--dim')).toBe(false)
    pressStep(panel, 3)
    expect(store.program.seq.steps[3].slide).not.toBe(true)
    await flushMicrotasks()
    expect(stepButtons(panel)[3].classList.contains('xd-step--dim')).toBe(false)
    // and slide presses never mute-toggled the step
    expect(store.program.seq.steps[3].on).toBe(false)
  })

  it('SLIDE flag survives switching back to NOTE mode (mute still works)', () => {
    const { store, panel } = make()
    store.setStep(5, [60], [100], [54])
    switchPos(panel, '.mono-row-seq', 'SLIDE').click()
    pressStep(panel, 5)
    expect(store.program.seq.steps[5].slide).toBe(true)
    switchPos(panel, '.mono-row-seq', 'NOTE').click()
    pressStep(panel, 5)
    expect(store.program.seq.steps[5].on).toBe(false) // NOTE-mode mute toggle
    expect(store.program.seq.steps[5].slide).toBe(true) // flag untouched
  })

  it('MOTION mode: LEDs show motion presence, plain presses toggle nothing', async () => {
    const { store, panel } = make()
    store.setStep(6, [60], [100], [54])
    const lane = store.findMotionLane(P.CUTOFF, true)
    store.writeMotionStep(lane, 6, [500])
    switchPos(panel, '.mono-row-seq', 'MOTION').click()
    await flushMicrotasks()
    expect(stepButtons(panel)[6].classList.contains('xd-step--on')).toBe(true)
    expect(stepButtons(panel)[7].classList.contains('xd-step--on')).toBe(false)
    pressStep(panel, 6)
    expect(store.program.seq.steps[6].on).toBe(true) // no mute toggle
    expect(store.program.seq.steps[6].slide).not.toBe(true) // no slide toggle
  })

  it('holding a step + knob move writes a motion lane, not the live param', () => {
    const { store, panel } = make()
    const before = store.getParam(P.CUTOFF) // mono init cutoff = 1023
    const step = stepButtons(panel)[2]
    step.dispatchEvent(pev('pointerdown')) // hold (NOTE mode)
    dragToMin(knob(panel, '.mono-sec-filter', 'CUTOFF'))
    step.dispatchEvent(pev('pointerup'))
    expect(store.getParam(P.CUTOFF)).toBe(before) // live param untouched
    const lane = store.findMotionLane(P.CUTOFF)
    expect(lane).toBeGreaterThanOrEqual(0)
    const data = store.program.seq.motion[lane].data[2]
    expect(data).not.toBeNull()
    expect(data![0]).toBe(0)
    expect(store.program.seq.motion[lane].on).toBe(true)
    // no accidental note toggle on release
    expect(store.program.seq.steps[2].on).toBe(false)
  })

  it('holding a step + keyboard note writes ONE note (monophonic steps)', () => {
    const { store, panel, opts } = make()
    const step = stepButtons(panel)[7]
    step.dispatchEvent(pev('pointerdown')) // hold (NOTE mode)
    panel.keyboard.pressNote(60, 90)
    panel.keyboard.releaseNote(60)
    panel.keyboard.pressNote(64, 80)
    panel.keyboard.releaseNote(64)
    step.dispatchEvent(pev('pointerup'))
    const st = store.program.seq.steps[7]
    expect(st.notes).toEqual([64]) // last key REPLACES — no chord (spec §8)
    expect(st.on).toBe(true)
    expect(opts.onNoteOn).toHaveBeenCalledWith(60, 90)
    expect(opts.onNoteOff).toHaveBeenCalledWith(64)
  })

  it('REC while stopped enters step rec; step press jumps the cursor (NOTE mode)', () => {
    const { store, panel } = make()
    const rec = button(panel, 'REC')
    rec.click()
    expect(store.recMode).toBe('step')
    expect(stepButtons(panel)[0].classList.contains('xd-step--rec')).toBe(true)
    pressStep(panel, 5)
    expect(store.stepRecCursor).toBe(5)
    rec.click()
    expect(store.recMode).toBe('off')
  })
})

describe('mono Panel: SLIDER + tempo + program strip', () => {
  it('assignment 0 (PITCH BEND) feeds onBend, not onJoyY', () => {
    const { store, panel, opts } = make()
    expect(store.getParam(P.SLIDER_ASSIGN)).toBe(0)
    const s = sliderEl(panel)
    expect(s.querySelector('.xd-hslider-label')!.textContent).toBe('PITCH BEND')
    wheel(s, -1) // one wheel step = +0.05
    expect(opts.onBend).toHaveBeenCalledWith(0.05)
    expect(opts.onJoyY).not.toHaveBeenCalled()
  })

  it('changing SLIDER ASSIGN rebuilds the slider as a non-spring mod source', () => {
    const { store, panel, opts } = make()
    const before = sliderEl(panel)
    store.setParam(P.SLIDER_ASSIGN, 8, 'menu') // CUTOFF
    const after = sliderEl(panel)
    expect(after).not.toBe(before) // rebuilt
    expect(after.querySelector('.xd-hslider-label')!.textContent).toBe('CUTOFF')
    wheel(after, -1)
    expect(opts.onJoyY).toHaveBeenCalledWith(0.05)
    expect(opts.onBend).not.toHaveBeenCalled()
  })

  it('TEMPO knob steps in 0.1 BPM increments and binds seq bpm', () => {
    const { store, panel } = make()
    const tempo = knob(panel, '.mono-sec-master', 'TEMPO')
    const before = store.program.seq.bpm
    tempo.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
    )
    expect(store.program.seq.bpm).toBeCloseTo(before + 0.1, 5)
    expect(tempo.getAttribute('aria-valuetext')).toBe((before + 0.1).toFixed(1))
  })

  it('WRITE button commits the program (dirty -> clean)', () => {
    const { store, panel } = make()
    store.setParam(P.CUTOFF, 123)
    expect(store.dirty).toBe(true)
    const write = button(panel, 'WRITE')
    write.dispatchEvent(pev('pointerdown'))
    write.dispatchEvent(pev('pointerup'))
    expect(store.dirty).toBe(false)
    expect(write.parentElement!.classList.contains('xd-flash')).toBe(true)
    store.loadSlot(0)
    expect(store.getParam(P.CUTOFF)).toBe(123)
  })
})
