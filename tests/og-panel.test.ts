// @vitest-environment happy-dom
/*
 * OG Panel <-> Store binding tests (patterned on tests/panel.test.ts):
 * construction + public surface, knob edits reaching the store, voice-mode
 * buttons, silent program/param resync, slider assign spring/mod swap, and
 * the optional (hidden-by-default) 16-step strip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/state/store'
import { P } from '../src/synths/og/params'
import { OG_DEF } from '../src/synths/og/def'
import { Panel, type PanelOpts } from '../src/synths/og/panel'
import { makeStoreDef } from './helpers/audio'
import { installLocalStorageMock, pev } from './helpers/dom'

const OG_TEST_DEF = makeStoreDef(OG_DEF, { bankKey: 'og-test-bank' })

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
  const store = new Store(OG_TEST_DEF)
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

function stepsWrap(panel: Panel): HTMLElement {
  return panel.el.querySelector<HTMLElement>('.og-seq-steps')!
}

function stepsChip(panel: Panel): HTMLButtonElement {
  return panel.el.querySelector<HTMLButtonElement>('.og-steps-chip')!
}

function stepButtons(panel: Panel): HTMLElement[] {
  return Array.from(panel.el.querySelectorAll<HTMLElement>('.og-seq-steps .xd-step'))
}

function pressStep(panel: Panel, i: number): void {
  const s = stepButtons(panel)[i]
  s.dispatchEvent(pev('pointerdown'))
  s.dispatchEvent(pev('pointerup'))
}

function sliderEl(panel: Panel): HTMLElement {
  const el = panel.el.querySelector<HTMLElement>('.og-slider-block .xd-hslider')
  if (!el) throw new Error('slider not found')
  return el
}

function wheel(el: HTMLElement, deltaY: number): void {
  el.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }))
}

const flushMicrotasks = (): Promise<void> => Promise.resolve()

/* ---------------------------------------------------------------- tests */

describe('OG Panel: construction + public surface', () => {
  it('builds and exposes the xd-compatible public surface', () => {
    const { panel } = make()
    expect(panel.el).toBeInstanceOf(HTMLElement)
    expect(panel.displaySlot.classList.contains('xd-display-slot')).toBe(true)
    expect(panel.keyboard).toBeTruthy()
    expect(typeof panel.setPlayhead).toBe('function')
    expect(typeof panel.setVoices).toBe('function')
    expect(typeof panel.flashMidi).toBe('function')
    // hardware-faithful sections present
    for (const sel of [
      '.og-sec-master',
      '.og-sec-vco1',
      '.og-sec-vco2',
      '.og-sec-mixer',
      '.og-sec-filter',
      '.og-sec-amp',
      '.og-sec-eg',
      '.og-sec-lfo',
      '.og-sec-delay',
      '.og-sec-vm',
      '.og-sec-prog',
    ]) {
      expect(panel.el.querySelector(sel), sel).toBeTruthy()
    }
    // no xd-only concepts
    expect(panel.el.querySelector('.xd-sec-multi')).toBeNull()
    expect(panel.el.querySelector('.xd-sec-fx')).toBeNull()
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

describe('OG Panel: param knobs <-> store', () => {
  it('dragging the CUTOFF knob updates store P.CUTOFF', () => {
    const { store, panel } = make()
    const el = knob(panel, '.og-sec-filter', 'CUTOFF')
    dragToMin(el)
    expect(store.getParam(P.CUTOFF)).toBe(0)
    dragToMax(el)
    expect(store.getParam(P.CUTOFF)).toBe(1023)
  })

  it('dragging PITCH EG INT (VCO2 modulation) updates its param', () => {
    const { store, panel } = make()
    dragToMax(knob(panel, '.og-sec-vco2', 'PITCH EG INT'))
    expect(store.getParam(P.PITCH_EG_INT)).toBe(1023)
  })

  it('external (midi) param changes resync the knob silently', () => {
    const { store, panel } = make()
    const el = knob(panel, '.og-sec-filter', 'RESONANCE')
    const uiEvents: number[] = []
    store.onParam((id, _v, source) => {
      if (source === 'ui') uiEvents.push(id)
    })
    store.setParam(P.RESONANCE, 700, 'midi')
    expect(el.getAttribute('aria-valuenow')).toBe('700')
    expect(uiEvents.length).toBe(0) // silent resync: no ui echo back into store
    expect(store.getParam(P.RESONANCE)).toBe(700)
  })

  it('FILTER TYPE switch sets P.FILTER_TYPE', () => {
    const { store, panel } = make()
    const positions = panel.el.querySelectorAll<HTMLButtonElement>('.og-sec-filter .xd-selector-pos')
    const twoPole = Array.from(positions).find((b) => b.textContent === '2-POLE')!
    twoPole.click()
    expect(store.getParam(P.FILTER_TYPE)).toBe(0)
  })

  it('OCTAVE param moves the keybed octave shift', () => {
    const { store, panel } = make()
    store.setParam(P.OCTAVE, 4, 'midi')
    expect(panel.keyboard.octaveShift).toBe(2)
    store.setParam(P.OCTAVE, 0, 'midi')
    expect(panel.keyboard.octaveShift).toBe(-2)
  })

  it('MASTER knob drives onMaster with 0..1', () => {
    const { panel, opts } = make()
    const el = knob(panel, '.og-sec-master', 'MASTER')
    dragToMin(el)
    expect(opts.onMaster).toHaveBeenCalledWith(0)
    dragToMax(el)
    expect(opts.onMaster).toHaveBeenCalledWith(1)
  })

  it('TEMPO knob steps in 0.1 BPM increments and binds seq bpm', () => {
    const { store, panel } = make()
    const tempo = knob(panel, '.og-sec-master', 'TEMPO')
    const before = store.program.seq.bpm
    tempo.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
    )
    expect(store.program.seq.bpm).toBeCloseTo(before + 0.1, 5)
    expect(tempo.getAttribute('aria-valuetext')).toBe((before + 0.1).toFixed(1))
  })
})

describe('OG Panel: voice mode buttons', () => {
  it('pressing a voice-mode button switches P.VOICE_MODE and lights its LED', async () => {
    const { store, panel } = make()
    const unison = button(panel, 'UNISON')
    unison.dispatchEvent(pev('pointerdown'))
    unison.dispatchEvent(pev('pointerup'))
    await flushMicrotasks() // LED re-assert after the momentary release
    expect(store.getParam(P.VOICE_MODE)).toBe(2)
    expect(
      unison.querySelector<HTMLElement>('.xd-ledbtn-led')!.style.getPropertyValue('--b'),
    ).toBe('1')

    const side = button(panel, 'SIDE CHAIN')
    side.dispatchEvent(pev('pointerdown'))
    side.dispatchEvent(pev('pointerup'))
    await flushMicrotasks()
    expect(store.getParam(P.VOICE_MODE)).toBe(7)
    expect(
      unison.querySelector<HTMLElement>('.xd-ledbtn-led')!.style.getPropertyValue('--b'),
    ).toBe('0') // previous selection unlit
  })

  it('external voice-mode changes light the matching button', async () => {
    const { store, panel } = make()
    store.setParam(P.VOICE_MODE, 4, 'midi') // CHORD
    await flushMicrotasks()
    const chord = button(panel, 'CHORD')
    expect(
      chord.querySelector<HTMLElement>('.xd-ledbtn-led')!.style.getPropertyValue('--b'),
    ).toBe('1')
  })

  it('holding ARP >500ms toggles latch (blinking LED); a tap does not', () => {
    const { store, panel } = make()
    const arp = button(panel, 'ARP')
    const root = arp.parentElement!
    const nowSpy = vi.spyOn(Date, 'now')

    // quick tap: selects ARP, no latch
    nowSpy.mockReturnValue(1000)
    arp.dispatchEvent(pev('pointerdown'))
    nowSpy.mockReturnValue(1100)
    arp.dispatchEvent(pev('pointerup'))
    expect(store.getParam(P.VOICE_MODE)).toBe(6)
    expect(store.getParam(P.ARP_LATCH)).toBe(0)
    expect(root.classList.contains('xd-blink')).toBe(false)

    // long hold: latch on + blink
    nowSpy.mockReturnValue(2000)
    arp.dispatchEvent(pev('pointerdown'))
    nowSpy.mockReturnValue(2600)
    arp.dispatchEvent(pev('pointerup'))
    expect(store.getParam(P.ARP_LATCH)).toBe(1)
    expect(root.classList.contains('xd-blink')).toBe(true)

    // long hold again: latch off
    nowSpy.mockReturnValue(3000)
    arp.dispatchEvent(pev('pointerdown'))
    nowSpy.mockReturnValue(3600)
    arp.dispatchEvent(pev('pointerup'))
    expect(store.getParam(P.ARP_LATCH)).toBe(0)
    expect(root.classList.contains('xd-blink')).toBe(false)
    nowSpy.mockRestore()
  })
})

describe('OG Panel: program block', () => {
  it('program load resyncs knob values to the new program silently', () => {
    const { store, panel } = make()
    const el = knob(panel, '.og-sec-filter', 'CUTOFF')
    store.setParam(P.CUTOFF, 111, 'midi')
    expect(el.getAttribute('aria-valuenow')).toBe('111')
    const uiEvents: number[] = []
    store.onParam((id, _v, source) => {
      if (source === 'ui') uiEvents.push(id)
    })
    store.loadSlot(1)
    expect(el.getAttribute('aria-valuenow')).toBe(String(store.getParam(P.CUTOFF)))
    expect(store.getParam(P.CUTOFF)).not.toBe(111)
    expect(uiEvents.length).toBe(0) // resync did not echo back as ui edits
  })

  it('PROGRAM encoder steps slots with wraparound; readout follows', () => {
    const { store, panel } = make()
    const enc = panel.el.querySelector<HTMLElement>('.xd-encoder[aria-label="PROGRAM/VALUE"]')!
    wheel(enc, 1)
    expect(store.slot).toBe(499) // 0 - 1 wraps to the last slot
    wheel(enc, -1)
    expect(store.slot).toBe(0)
    expect(panel.el.querySelector('.xd-prog-num')!.textContent).toBe('001')
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

  it('EDIT opens the program browser; EXIT closes it', () => {
    const { panel } = make()
    const edit = button(panel, 'EDIT')
    edit.dispatchEvent(pev('pointerdown'))
    edit.dispatchEvent(pev('pointerup'))
    expect(document.querySelector('.xd-menu')).toBeTruthy()
    const exit = button(panel, 'EXIT')
    exit.dispatchEvent(pev('pointerdown'))
    exit.dispatchEvent(pev('pointerup'))
    expect(document.querySelector('.xd-menu')).toBeNull()
  })
})

describe('OG Panel: SLIDER assign', () => {
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
    store.setParam(P.SLIDER_ASSIGN, 11, 'menu') // CUTOFF
    const after = sliderEl(panel)
    expect(after).not.toBe(before) // rebuilt
    expect(after.querySelector('.xd-hslider-label')!.textContent).toBe('CUTOFF')
    wheel(after, -1)
    expect(opts.onJoyY).toHaveBeenCalledWith(0.05)
    expect(opts.onBend).not.toHaveBeenCalled()

    // back to PITCH BEND: rebuilt again, bend path restored
    store.setParam(P.SLIDER_ASSIGN, 0, 'menu')
    const again = sliderEl(panel)
    expect(again.querySelector('.xd-hslider-label')!.textContent).toBe('PITCH BEND')
    wheel(again, -1)
    expect(opts.onBend).toHaveBeenCalledWith(0.05)
  })

  it('spring vs hold: bend springs back to 0 after release, mod holds', async () => {
    const { store, panel, opts } = make()
    // spring (PITCH BEND): deflect programmatically (happy-dom rects are 0-size)
    let track = sliderEl(panel).querySelector<HTMLElement>('.xd-hslider-track')!
    track.dispatchEvent(pev('pointerdown', { clientX: 10 }))
    wheelDeflect(panel, 0.8)
    track.dispatchEvent(pev('pointerup'))
    await new Promise((r) => setTimeout(r, 400))
    const bendCalls = (opts.onBend as ReturnType<typeof vi.fn>).mock.calls as [number][]
    expect(bendCalls.at(-1)?.[0]).toBe(0) // sprung back to center

    // hold (mod assignment): value stays after release
    store.setParam(P.SLIDER_ASSIGN, 12, 'menu') // RESONANCE
    track = sliderEl(panel).querySelector<HTMLElement>('.xd-hslider-track')!
    track.dispatchEvent(pev('pointerdown', { clientX: 10 }))
    wheelDeflect(panel, 0.5)
    track.dispatchEvent(pev('pointerup'))
    await new Promise((r) => setTimeout(r, 250))
    const joyCalls = (opts.onJoyY as ReturnType<typeof vi.fn>).mock.calls as [number][]
    expect(joyCalls.at(-1)?.[0]).toBeCloseTo(0.5, 5) // held position
  })
})

/** Deflect the slider via wheel steps (0.05 each) — drag geometry is
 *  degenerate in happy-dom, and Slider.setValue is silent by design. */
function wheelDeflect(panel: Panel, target: number): void {
  const s = sliderEl(panel)
  const steps = Math.round(Math.abs(target) / 0.05)
  for (let i = 0; i < steps; i++) wheel(s, target > 0 ? -1 : 1)
}

describe('OG Panel: optional step strip', () => {
  it('is hidden by default; the STEPS chip toggles + persists it', () => {
    const { panel } = make()
    expect(stepsWrap(panel).hidden).toBe(true)
    expect(stepButtons(panel).length).toBe(16)
    const chip = stepsChip(panel)
    expect(chip.getAttribute('aria-pressed')).toBe('false')
    chip.click()
    expect(stepsWrap(panel).hidden).toBe(false)
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    expect(globalThis.localStorage.getItem('og-step-strip')).toBe('1')
    chip.click()
    expect(stepsWrap(panel).hidden).toBe(true)
    expect(globalThis.localStorage.getItem('og-step-strip')).toBe('0')
  })

  it('restores visibility from localStorage', () => {
    globalThis.localStorage.setItem('og-step-strip', '1')
    const { panel } = make()
    expect(stepsWrap(panel).hidden).toBe(false)
  })

  it('setPlayhead is safe while hidden and shows through once visible', () => {
    const { panel } = make()
    expect(stepsWrap(panel).hidden).toBe(true)
    expect(() => panel.setPlayhead(2)).not.toThrow()
    stepsChip(panel).click()
    expect(stepButtons(panel)[2].classList.contains('xd-step--playing')).toBe(true)
    panel.setPlayhead(-1)
    expect(stepButtons(panel)[2].classList.contains('xd-step--playing')).toBe(false)
  })

  it('step click toggles a step that has notes (strip visible)', () => {
    const { store, panel } = make()
    stepsChip(panel).click()
    store.setStep(0, [60], [100], [54])
    expect(store.program.seq.steps[0].on).toBe(true)
    pressStep(panel, 0)
    expect(store.program.seq.steps[0].on).toBe(false)
    pressStep(panel, 0)
    expect(store.program.seq.steps[0].on).toBe(true)
  })

  it('holding a step + knob move writes a motion lane, not the live param', () => {
    const { store, panel } = make()
    stepsChip(panel).click()
    const before = store.getParam(P.CUTOFF) // OG init cutoff = 1023
    const step = stepButtons(panel)[2]
    step.dispatchEvent(pev('pointerdown')) // hold
    dragToMin(knob(panel, '.og-sec-filter', 'CUTOFF'))
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

  it('holding a step + keyboard note writes the note into that step', () => {
    const { store, panel, opts } = make()
    stepsChip(panel).click()
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
    expect(opts.onNoteOn).toHaveBeenCalledWith(60, 90)
    expect(opts.onNoteOff).toHaveBeenCalledWith(64)
  })

  it('REC while stopped enters step rec; step press jumps the cursor', () => {
    const { store, panel } = make()
    stepsChip(panel).click()
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
