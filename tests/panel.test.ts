// @vitest-environment happy-dom
/*
 * Panel <-> Store binding tests: knob edits reach the store, external param
 * changes resync controls silently, dynamic rebinds (multi engine SHAPE,
 * FX section TIME/DEPTH), sequencer step interactions, playhead LEDs,
 * program load resync and WRITE.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/state/store'
import { XD_DEF } from '../src/synths/xd/def'
import { P } from '../src/synths/xd/params'
import { Panel, type PanelOpts } from '../src/synths/xd/panel'
import { installLocalStorageMock, pev, type LocalStorageMock } from './helpers/dom'

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
  const store = new Store(XD_DEF)
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

function stepButtons(panel: Panel): HTMLElement[] {
  return Array.from(panel.el.querySelectorAll<HTMLElement>('.xd-seq-steps .xd-step'))
}

function pressStep(panel: Panel, i: number): void {
  const s = stepButtons(panel)[i]
  s.dispatchEvent(pev('pointerdown'))
  s.dispatchEvent(pev('pointerup'))
}

/* ---------------------------------------------------------------- tests */

describe('Panel: param knobs <-> store', () => {
  it('builds and exposes the public surface', () => {
    const { panel } = make()
    expect(panel.el).toBeInstanceOf(HTMLElement)
    expect(panel.displaySlot.classList.contains('xd-display-slot')).toBe(true)
    expect(panel.keyboard).toBeTruthy()
    expect(stepButtons(panel).length).toBe(16)
  })

  it('dragging the CUTOFF knob updates store P.CUTOFF', () => {
    const { store, panel } = make()
    const el = knob(panel, '.xd-sec-filter', 'CUTOFF')
    store.setParam(P.CUTOFF, 500, 'midi')
    dragToMax(el)
    expect(store.getParam(P.CUTOFF)).toBe(1023)
    dragToMin(el)
    expect(store.getParam(P.CUTOFF)).toBe(0)
  })

  it('display-menu edits (source "menu") resync statically bound controls', () => {
    const { store, panel } = make()
    const porta = knob(panel, '.xd-sec-master', 'PORTAMENTO')
    store.setParam(P.PORTAMENTO, 40, 'menu')
    expect(porta.getAttribute('aria-valuenow')).toBe('40') // knob follows the menu
    store.setParam(P.OCTAVE, 4, 'menu')
    expect(panel.keyboard.octaveShift).toBe(2) // lever/keybed follow too
  })

  it('store.setParam(P.RESONANCE, 700, "midi") resyncs the knob silently', () => {
    const { store, panel } = make()
    const el = knob(panel, '.xd-sec-filter', 'RESONANCE')
    const uiEvents: number[] = []
    store.onParam((id, _v, source) => {
      if (source === 'ui') uiEvents.push(id)
    })
    store.setParam(P.RESONANCE, 700, 'midi')
    expect(el.getAttribute('aria-valuenow')).toBe('700')
    expect(uiEvents.length).toBe(0) // silent resync: no ui echo back into store
    expect(store.getParam(P.RESONANCE)).toBe(700)
  })
})

describe('Panel: MULTI ENGINE dynamic SHAPE binding', () => {
  it('rebinds SHAPE to the active engine (NOISE after MULTI_TYPE=0)', () => {
    const { store, panel } = make()
    store.setParam(P.MULTI_TYPE, 0) // NOISE
    const before = store.getParam(P.SHAPE_VPM)
    const shape = knob(panel, '.xd-sec-multi', 'SHAPE')
    // knob resynced to the NOISE shape value
    expect(shape.getAttribute('aria-valuenow')).toBe(String(store.getParam(P.SHAPE_NOISE)))
    dragToMax(shape)
    expect(store.getParam(P.SHAPE_NOISE)).toBe(1023)
    expect(store.getParam(P.SHAPE_VPM)).toBe(before) // untouched
  })

  it('TYPE encoder steps the active engine select param with wraparound', () => {
    const { store, panel } = make()
    store.setParam(P.MULTI_TYPE, 0) // NOISE: 4 subtypes
    store.setParam(P.SELECT_NOISE, 3)
    const enc = panel.el.querySelector<HTMLElement>('.xd-sec-multi .xd-encoder[aria-label="TYPE"]')!
    enc.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }))
    expect(store.getParam(P.SELECT_NOISE)).toBe(0) // wrapped 3 -> 0
    enc.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true, cancelable: true }))
    expect(store.getParam(P.SELECT_NOISE)).toBe(3) // wrapped back
  })
})

describe('Panel: EFFECTS shared controls', () => {
  it('FX section switch rebinds the TIME knob (DEL vs REV)', () => {
    const { store, panel } = make()
    const time = knob(panel, '.xd-sec-fx', 'TIME')

    // default addressed section = DEL
    dragToMax(time)
    expect(store.getParam(P.DELAY_TIME)).toBe(1023)
    const delayTime = store.getParam(P.DELAY_TIME)

    // switch to REV
    const positions = panel.el.querySelectorAll<HTMLButtonElement>('.xd-sec-fx .xd-selector-pos')
    expect(positions[1].textContent).toBe('REV')
    positions[1].click()
    // knob resynced to the reverb time
    expect(time.getAttribute('aria-valuenow')).toBe(String(store.getParam(P.REVERB_TIME)))
    dragToMin(time)
    expect(store.getParam(P.REVERB_TIME)).toBe(0)
    expect(store.getParam(P.DELAY_TIME)).toBe(delayTime) // untouched
  })

  it('ON/OFF button toggles the addressed section on param', () => {
    const { store, panel } = make()
    const on = button(panel, 'ON/OFF')
    const before = store.getParam(P.DELAY_ON)
    on.click()
    expect(store.getParam(P.DELAY_ON)).toBe(before ? 0 : 1)
    on.click()
    expect(store.getParam(P.DELAY_ON)).toBe(before)
  })

  it('SHIFT+DEPTH addresses DRY WET with its full 0..1024 range', () => {
    const { store, panel } = make()
    store.setParam(P.DELAY_DRYWET, 1024, 'midi')
    const shift = button(panel, 'SHIFT')
    shift.dispatchEvent(pev('pointerdown')) // quick tap latches SHIFT on
    shift.dispatchEvent(pev('pointerup'))
    const depth = knob(panel, '.xd-sec-fx', 'DEPTH')
    expect(depth.getAttribute('aria-valuemax')).toBe('1024')
    expect(depth.getAttribute('aria-valuenow')).toBe('1024') // 100% wet shown
    dragToMin(depth)
    dragToMax(depth)
    expect(store.getParam(P.DELAY_DRYWET)).toBe(1024) // full wet reachable
  })

  it('SELECT cycles DELAY_SUB for the DEL section', () => {
    const { store, panel } = make()
    store.setParam(P.DELAY_SUB, 11, 'midi') // last delay sub
    const sel = button(panel, 'SELECT')
    sel.dispatchEvent(pev('pointerdown'))
    sel.dispatchEvent(pev('pointerup'))
    expect(store.getParam(P.DELAY_SUB)).toBe(0) // wrapped
  })
})

describe('Panel: sequencer strip', () => {
  it('step click toggles a step that has notes', () => {
    const { store, panel } = make()
    store.setStep(0, [60], [100], [54])
    expect(store.program.seq.steps[0].on).toBe(true)
    pressStep(panel, 0)
    expect(store.program.seq.steps[0].on).toBe(false)
    pressStep(panel, 0)
    expect(store.program.seq.steps[0].on).toBe(true)
  })

  it('SHIFT+step toggles activeStep', () => {
    const { store, panel } = make()
    const shift = button(panel, 'SHIFT')
    shift.dispatchEvent(pev('pointerdown')) // hold SHIFT
    expect(store.program.seq.activeSteps[3]).toBe(true)
    pressStep(panel, 3)
    expect(store.program.seq.activeSteps[3]).toBe(false)
    pressStep(panel, 3)
    expect(store.program.seq.activeSteps[3]).toBe(true)
    shift.dispatchEvent(pev('pointerup'))
  })

  it('playhead applies the playing state to the step button', () => {
    const { panel } = make()
    panel.setPlayhead(2)
    const steps = stepButtons(panel)
    expect(steps[2].classList.contains('xd-step--playing')).toBe(true)
    panel.setPlayhead(5)
    expect(steps[2].classList.contains('xd-step--playing')).toBe(false)
    expect(steps[5].classList.contains('xd-step--playing')).toBe(true)
    panel.setPlayhead(-1) // stopped
    expect(steps[5].classList.contains('xd-step--playing')).toBe(false)
  })

  it('REC while stopped enters step rec; step press jumps the cursor', () => {
    const { store, panel } = make()
    const rec = button(panel, 'REC')
    rec.click()
    expect(store.recMode).toBe('step')
    expect(rec.parentElement!.classList.contains('xd-blink')).toBe(true)
    expect(stepButtons(panel)[0].classList.contains('xd-step--rec')).toBe(true)
    pressStep(panel, 5)
    expect(store.stepRecCursor).toBe(5)
    expect(stepButtons(panel)[5].classList.contains('xd-step--rec')).toBe(true)
    rec.click()
    expect(store.recMode).toBe('off')
    expect(rec.parentElement!.classList.contains('xd-blink')).toBe(false)
  })

  it('holding a step + keyboard note writes the note into that step', () => {
    const { store, panel, opts } = make()
    const step = stepButtons(panel)[7]
    step.dispatchEvent(pev('pointerdown')) // hold
    panel.keyboard.pressNote(60, 90)
    panel.keyboard.releaseNote(60)
    panel.keyboard.pressNote(64, 80)
    panel.keyboard.releaseNote(64)
    step.dispatchEvent(pev('pointerup'))
    const st = store.program.seq.steps[7]
    expect(st.notes).toEqual([60, 64]) // chord accumulated during the hold
    expect(st.on).toBe(true)
    expect(st.vels).toEqual([90, 80])
    // held-step edit cancels the release toggle
    expect(store.program.seq.steps[7].on).toBe(true)
    // notes still forwarded to the audio callbacks
    expect(opts.onNoteOn).toHaveBeenCalledWith(60, 90)
    expect(opts.onNoteOff).toHaveBeenCalledWith(64)
  })

  it('holding a step + knob move writes a motion lane, not the live param', () => {
    const { store, panel } = make()
    const before = store.getParam(P.CUTOFF)
    const step = stepButtons(panel)[2]
    step.dispatchEvent(pev('pointerdown')) // hold
    dragToMax(knob(panel, '.xd-sec-filter', 'CUTOFF'))
    step.dispatchEvent(pev('pointerup'))
    expect(store.getParam(P.CUTOFF)).toBe(before) // live param untouched
    const lane = store.findMotionLane(P.CUTOFF)
    expect(lane).toBeGreaterThanOrEqual(0)
    const data = store.program.seq.motion[lane].data[2]
    expect(data).not.toBeNull()
    expect(data![0]).toBe(1023)
    expect(data!.length).toBe(5)
    // the lane is enabled (else the written motion would never play back)
    expect(store.program.seq.motion[lane].on).toBe(true)
    expect(store.program.seq.motion[lane].smooth).toBe(true) // CUTOFF smoothable
    // no accidental note toggle on release
    expect(store.program.seq.steps[2].on).toBe(false)
  })
})

describe('Panel: program block', () => {
  it('program load resyncs knob values to the new program', () => {
    const { store, panel } = make()
    const el = knob(panel, '.xd-sec-filter', 'CUTOFF')
    store.setParam(P.CUTOFF, 111, 'midi')
    expect(el.getAttribute('aria-valuenow')).toBe('111')
    store.loadSlot(1)
    expect(el.getAttribute('aria-valuenow')).toBe(String(store.getParam(P.CUTOFF)))
    expect(store.getParam(P.CUTOFF)).not.toBe(111)
  })

  it('PROGRAM encoder steps slots with wraparound', () => {
    const { store, panel } = make()
    const enc = panel.el.querySelector<HTMLElement>('.xd-encoder[aria-label="PROGRAM/VALUE"]')!
    enc.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true, cancelable: true }))
    expect(store.slot).toBe(499) // 0 - 1 wraps to the last slot
    enc.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }))
    expect(store.slot).toBe(0)
    const num = panel.el.querySelector('.xd-prog-num')!
    expect(num.textContent).toBe('001')
  })

  it('WRITE button commits the program (dirty -> clean)', () => {
    const { store, panel } = make()
    store.setParam(P.CUTOFF, 123)
    expect(store.dirty).toBe(true)
    const write = button(panel, 'WRITE')
    write.dispatchEvent(pev('pointerdown'))
    write.dispatchEvent(pev('pointerup'))
    expect(store.dirty).toBe(false)
    expect(write.parentElement!.classList.contains('xd-flash')).toBe(true) // success flash
    expect(write.parentElement!.classList.contains('xd-blink')).toBe(false)
    // the written value survives a reload of the slot
    store.loadSlot(0)
    expect(store.getParam(P.CUTOFF)).toBe(123)
  })

  it('WRITE shows the ~1s error blink and stays dirty when storage fails', () => {
    vi.useFakeTimers()
    try {
      const { store, panel } = make()
      const ls = (globalThis as unknown as { localStorage: LocalStorageMock }).localStorage
      ls.setItem = () => {
        throw new DOMException('quota exceeded', 'QuotaExceededError')
      }
      store.setParam(P.CUTOFF, 123)
      const write = button(panel, 'WRITE')
      write.dispatchEvent(pev('pointerdown'))
      write.dispatchEvent(pev('pointerup'))
      expect(store.dirty).toBe(true) // write did not persist
      const root = write.parentElement!
      expect(root.classList.contains('xd-blink')).toBe(true) // error treatment
      expect(root.classList.contains('xd-flash')).toBe(false)
      vi.advanceTimersByTime(1000)
      expect(root.classList.contains('xd-blink')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('SHIFT+WRITE inits the edit buffer instead of writing the slot', () => {
    const { store, panel } = make()
    const factoryName = store.program.name
    const factoryCutoff = store.getParam(P.CUTOFF)
    store.setParam(P.CUTOFF, 777)
    const shift = button(panel, 'SHIFT')
    shift.dispatchEvent(pev('pointerdown')) // hold SHIFT
    const write = button(panel, 'WRITE')
    write.dispatchEvent(pev('pointerdown'))
    write.dispatchEvent(pev('pointerup'))
    shift.dispatchEvent(pev('pointerup'))
    expect(store.program.name).toBe('Init Program') // edit buffer initialized
    expect(store.dirty).toBe(true) // init is an edit, not a save
    store.loadSlot(0) // the slot itself was not overwritten
    expect(store.program.name).toBe(factoryName)
    expect(store.getParam(P.CUTOFF)).toBe(factoryCutoff)
  })

  it('double-clicking the program name prompts for a rename', () => {
    const { store, panel } = make()
    const name = panel.el.querySelector<HTMLElement>('.xd-prog-name')!
    window.prompt = vi.fn(() => '  My Great Patch Name  ') // trimmed + capped
    name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    expect(store.program.name).toBe('My Great Patch N') // 16 chars max
    expect(store.dirty).toBe(true)
    expect(name.textContent).toBe('My Great Patch N') // readout follows
    window.prompt = vi.fn(() => null) // cancel: ignored
    name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    expect(store.program.name).toBe('My Great Patch N')
  })
})

describe('Panel: master + keyboard glue', () => {
  it('MASTER knob drives onMaster with 0..1', () => {
    const { panel, opts } = make()
    const el = knob(panel, '.xd-sec-master', 'MASTER')
    dragToMin(el)
    expect(opts.onMaster).toHaveBeenCalledWith(0)
    dragToMax(el)
    expect(opts.onMaster).toHaveBeenCalledWith(1)
  })

  it('TEMPO knob steps in 0.1 BPM increments', () => {
    const { store, panel } = make()
    const tempo = knob(panel, '.xd-sec-master', 'TEMPO')
    const before = store.program.seq.bpm
    // arrow keys move a knob by exactly one step (happy-dom drops shiftKey
    // from WheelEvent, so SHIFT+wheel can't probe the fine step here)
    tempo.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
    )
    expect(store.program.seq.bpm).toBeCloseTo(before + 0.1, 5)
    expect(tempo.getAttribute('aria-valuetext')).toBe((before + 0.1).toFixed(1))
    tempo.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    )
    expect(store.program.seq.bpm).toBeCloseTo(before, 5)
  })

  it('ARP LATCH LED blinks while latched (spec §3)', () => {
    const { store, panel } = make()
    const latch = button(panel, 'LATCH')
    const root = latch.parentElement!
    expect(root.classList.contains('xd-blink')).toBe(false)
    latch.click() // latching button: toggles P.ARP_LATCH on
    expect(store.getParam(P.ARP_LATCH)).toBe(1)
    expect(root.classList.contains('xd-blink')).toBe(true)
    store.setParam(P.ARP_LATCH, 0, 'midi') // external change syncs too
    expect(root.classList.contains('xd-blink')).toBe(false)
    store.setParam(P.ARP_LATCH, 1, 'midi')
    expect(root.classList.contains('xd-blink')).toBe(true)
    store.loadSlot(1) // program load resyncs from the loaded value (0)
    expect(store.getParam(P.ARP_LATCH)).toBe(0)
    expect(root.classList.contains('xd-blink')).toBe(false)
  })

  it('OCTAVE param moves the keybed octave shift', () => {
    const { store, panel } = make()
    store.setParam(P.OCTAVE, 4, 'midi')
    expect(panel.keyboard.octaveShift).toBe(2)
    store.setParam(P.OCTAVE, 0, 'midi')
    expect(panel.keyboard.octaveShift).toBe(-2)
  })

  it('setVoices lights keyboard keys; flashMidi pulses the LED', () => {
    vi.useFakeTimers()
    try {
      const { panel } = make()
      panel.setVoices([60])
      expect(panel.el.querySelectorAll('.xd-key--lit').length).toBe(1)
      panel.setVoices([])
      expect(panel.el.querySelectorAll('.xd-key--lit').length).toBe(0)
      const led = panel.el.querySelector<HTMLElement>('.xd-midi-ind .xd-led')!
      panel.flashMidi()
      expect(led.style.getPropertyValue('--b')).toBe('1')
      vi.advanceTimersByTime(200)
      expect(led.style.getPropertyValue('--b')).toBe('0')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('readout menus', () => {
  afterEach(() => {
    document.querySelector('.xd-menu')?.remove()
  })

  it('multi readout opens a grouped menu; picking switches engine + osc', () => {
    const { store, panel } = make()
    document.body.appendChild(panel.el)
    const readout = panel.el.querySelector('.xd-multi-display') as HTMLElement
    readout.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const menu = document.querySelector('.xd-menu')!
    expect(menu.querySelectorAll('.xd-menu-header').length).toBe(3) // NOISE/VPM/USR
    expect(menu.querySelectorAll('.xd-menu-item').length).toBe(24) // 4+16+4
    const items = [...menu.querySelectorAll('.xd-menu-item')] as HTMLButtonElement[]
    const throat = items.find((i) => i.textContent === 'Throat')!
    throat.click()
    expect(store.getParam(P.MULTI_TYPE)).toBe(1)
    expect(store.getParam(P.SELECT_VPM)).toBe(15)
    panel.el.remove()
  })

  it('fx readout lists the addressed section; picking sets the subtype', () => {
    const { store, panel } = make()
    document.body.appendChild(panel.el)
    const readout = panel.el.querySelector('.xd-fx-display') as HTMLElement
    readout.dispatchEvent(new MouseEvent('click', { bubbles: true })) // DEL by default
    const menu = document.querySelector('.xd-menu')!
    const items = [...menu.querySelectorAll('.xd-menu-item')] as HTMLButtonElement[]
    expect(items.length).toBe(12) // delay subtypes
    items.find((i) => i.textContent === 'Tape')!.click()
    expect(store.getParam(P.DELAY_SUB)).toBe(4)
    panel.el.remove()
  })

  it('program readout browses slots and offers rename', () => {
    const { store, panel } = make()
    document.body.appendChild(panel.el)
    const readout = panel.el.querySelector('.xd-prog-readout') as HTMLElement
    readout.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const menu = document.querySelector('.xd-menu')!
    const items = [...menu.querySelectorAll('.xd-menu-item')] as HTMLButtonElement[]
    expect(items.length).toBe(501) // Rename… + 500 slots
    expect(items[0].classList.contains('is-action')).toBe(true)
    items[3].click() // slot index 2 ("003 ...")
    expect(store.slot).toBe(2)
    // rename action goes through window.prompt
    readout.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const items2 = [...document.querySelectorAll('.xd-menu .xd-menu-item')] as HTMLButtonElement[]
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Renamed Prog')
    items2[0].click()
    expect(store.program.name).toBe('Renamed Prog')
    promptSpy.mockRestore()
    panel.el.remove()
  })
})
