// @vitest-environment happy-dom
/*
 * OLED Display tests: DOM structure (canvas + 5-button soft strip), the
 * param overlay lifecycle, menu paging across PROG EDIT / SEQ EDIT / motion
 * pages, soft-button editing through the Store, scope frames with and
 * without a 2d context, the MIDI indicator flash, and program loads.
 *
 * Rendering is rAF-driven, so requestAnimationFrame is stubbed to a manual
 * queue (pump()) and getContext is patched to hand out a recording mock ctx
 * (or null, to prove the module tolerates happy-dom's canvas).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/state/store'
import { FACTORY_PRESETS } from '../src/state/presets'
import { P, PARAMS, MOTION_PARAM_IDS, MOTION_GATE_TIME, formatParam } from '../src/shared/params'
import { NUM_MOTION_LANES } from '../src/shared/program'
import { Display } from '../src/ui/display'

/* ------------------------------------------------------------------ layout */

const MENU_COUNT = PARAMS.filter((p) => p.kind === 'menu').length
const SEQ_FIELD_COUNT = 5 // bpm, stepLength, stepResolution, swing, defaultGate
const SEQ_TOTAL = SEQ_FIELD_COUNT + NUM_MOTION_LANES
const TOTAL_PAGES = MENU_COUNT + SEQ_TOTAL
const FIRST_MENU_PARAM = PARAMS.filter((p) => p.kind === 'menu')[0]

/* --------------------------------------------------------------- rAF pump */

let rafQ: FrameRequestCallback[] = []

function pump(): void {
  for (let round = 0; round < 5 && rafQ.length > 0; round++) {
    const q = rafQ
    rafQ = []
    for (const cb of q) cb(0)
  }
}

/* ------------------------------------------------------------- mock 2d ctx */

interface MockCtx {
  ctx: CanvasRenderingContext2D
  texts: string[]
  calls: string[]
}

function makeCtx(): MockCtx {
  const texts: string[] = []
  const calls: string[] = []
  const log = (name: string) => (): void => {
    calls.push(name)
  }
  const target = {
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter',
    shadowColor: '',
    shadowBlur: 0,
    setTransform: log('setTransform'),
    fillRect: log('fillRect'),
    beginPath: log('beginPath'),
    moveTo: log('moveTo'),
    lineTo: log('lineTo'),
    stroke: log('stroke'),
    arc: log('arc'),
    fill: log('fill'),
    fillText: (s: string): void => {
      texts.push(s)
      calls.push('fillText')
    },
  }
  return { ctx: target as unknown as CanvasRenderingContext2D, texts, calls }
}

/* -------------------------------------------------------- test environment */

let nextCtx: CanvasRenderingContext2D | null = null

const canvasProto = HTMLCanvasElement.prototype as unknown as {
  getContext: (...args: unknown[]) => unknown
}
const origGetContext = canvasProto.getContext

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  rafQ = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    rafQ.push(cb)
    return rafQ.length
  })
  canvasProto.getContext = () => nextCtx
  try {
    localStorage.clear()
  } catch {
    /* no storage in this env: persist.ts falls back to factory data */
  }
  document.body.innerHTML = ''
})

afterEach(() => {
  canvasProto.getContext = origGetContext
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function make(withCtx = true): { store: Store; display: Display; texts: string[]; calls: string[] } {
  const m = makeCtx()
  nextCtx = withCtx ? m.ctx : null
  const store = new Store(FACTORY_PRESETS)
  const display = new Display({ store })
  document.body.appendChild(display.el)
  return { store, display, texts: m.texts, calls: m.calls }
}

function btn(display: Display, role: 'menu' | 'prev' | 'next' | 'minus' | 'plus'): HTMLButtonElement {
  const b = display.el.querySelector<HTMLButtonElement>('.xd-oled-softbtn--' + role)
  if (!b) throw new Error('missing soft button: ' + role)
  return b
}

function clickNext(display: Display, times: number): void {
  for (let i = 0; i < times; i++) btn(display, 'next').click()
}

/** Fresh texts from the next coalesced render. */
function renderTexts(texts: string[]): string[] {
  texts.length = 0
  pump()
  return texts
}

/* ================================================================== tests */

describe('Display DOM structure', () => {
  it('renders a canvas screen with glass inside the OLED root', () => {
    const { display } = make()
    expect(display.el.classList.contains('xd-oled')).toBe(true)
    const canvas = display.el.querySelector<HTMLCanvasElement>('.xd-oled-screen canvas.xd-oled-canvas')
    expect(canvas).not.toBeNull()
    expect(canvas!.width).toBeGreaterThan(0)
    expect(canvas!.height).toBeGreaterThan(0)
    expect(display.el.querySelector('.xd-oled-screen .xd-oled-glass')).not.toBeNull()
  })

  it('has a soft strip with the five buttons [MENU][◀][▶][−][+] in order', () => {
    const { display } = make()
    const strip = display.el.querySelector('.xd-oled-soft')
    expect(strip).not.toBeNull()
    const buttons = Array.from(strip!.querySelectorAll('button'))
    expect(buttons).toHaveLength(5)
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'menu',
      'prev',
      'next',
      'minus',
      'plus',
    ])
    expect(buttons.map((b) => b.textContent)).toEqual(['MENU', '◀', '▶', '−', '+'])
  })
})

describe('param overlay', () => {
  it('a ui-sourced param change raises the overlay and it expires back to home', () => {
    const { store, display, texts } = make()
    pump()
    store.setParam(P.CUTOFF, 500, 'ui')
    expect(display.debugState.screen).toBe('overlay')

    const drawn = renderTexts(texts)
    expect(drawn).toContain('CUTOFF')
    expect(drawn).toContain(formatParam(P.CUTOFF, store.getParam(P.CUTOFF)))

    vi.advanceTimersByTime(1099)
    expect(display.debugState.screen).toBe('overlay')
    vi.advanceTimersByTime(1)
    expect(display.debugState.screen).toBe('home')
  })

  it('midi-sourced changes also raise the overlay', () => {
    const { store, display } = make()
    store.setParam(P.RESONANCE, 300, 'midi')
    expect(display.debugState.screen).toBe('overlay')
  })

  it("sources 'load', 'motion' and 'engine' never raise the overlay", () => {
    const { store, display } = make()
    for (const source of ['load', 'motion', 'engine'] as const) {
      store.setParam(P.CUTOFF, 400, source)
      expect(display.debugState.screen).toBe('home')
    }
  })

  it('rapid successive moves keep resetting the expiry timer', () => {
    const { store, display } = make()
    store.setParam(P.CUTOFF, 500, 'ui')
    vi.advanceTimersByTime(600)
    store.setParam(P.CUTOFF, 520, 'ui')
    vi.advanceTimersByTime(600)
    expect(display.debugState.screen).toBe('overlay')
    vi.advanceTimersByTime(500)
    expect(display.debugState.screen).toBe('home')
  })
})

describe('menu mode', () => {
  it('MENU toggles menu mode and renders the first PROG EDIT page', () => {
    const { display, texts } = make()
    pump()
    btn(display, 'menu').click()
    expect(display.debugState).toEqual({ screen: 'menu', page: 0 })
    expect(btn(display, 'menu').classList.contains('is-active')).toBe(true)

    const drawn = renderTexts(texts)
    expect(drawn).toContain(`PROG EDIT  1/${MENU_COUNT}`)
    expect(drawn).toContain(FIRST_MENU_PARAM.label)

    btn(display, 'menu').click()
    expect(display.debugState.screen).toBe('home')
    expect(btn(display, 'menu').classList.contains('is-active')).toBe(false)
  })

  it('MENU pressed during an overlay cancels it and enters the menu', () => {
    const { store, display } = make()
    store.setParam(P.CUTOFF, 500, 'ui')
    expect(display.debugState.screen).toBe('overlay')
    btn(display, 'menu').click()
    expect(display.debugState.screen).toBe('menu')
    vi.advanceTimersByTime(1100) // stale overlay timer must not fire
    expect(display.debugState.screen).toBe('menu')
  })

  it('▶ pages through PROG EDIT and crosses into SEQ EDIT (BPM first)', () => {
    const { display, texts } = make()
    btn(display, 'menu').click()
    btn(display, 'next').click()
    expect(display.debugState.page).toBe(1)
    clickNext(display, MENU_COUNT - 1)
    expect(display.debugState.page).toBe(MENU_COUNT)

    const drawn = renderTexts(texts)
    expect(drawn).toContain(`SEQ EDIT  1/${SEQ_TOTAL}`)
    expect(drawn).toContain('BPM')
  })

  it('◀ from the first page wraps to the last motion page', () => {
    const { display, texts } = make()
    btn(display, 'menu').click()
    btn(display, 'prev').click()
    expect(display.debugState.page).toBe(TOTAL_PAGES - 1)
    const drawn = renderTexts(texts)
    expect(drawn).toContain(`SEQ EDIT  ${SEQ_TOTAL}/${SEQ_TOTAL}  MOTION ${NUM_MOTION_LANES}`)
  })

  it('nav and edit soft buttons are inert on the home screen', () => {
    const { store, display } = make()
    const bpm = store.program.seq.bpm
    const v = store.getParam(FIRST_MENU_PARAM.id)
    btn(display, 'next').click()
    btn(display, 'prev').click()
    btn(display, 'plus').click()
    btn(display, 'minus').click()
    expect(display.debugState).toEqual({ screen: 'home', page: 0 })
    expect(store.program.seq.bpm).toBe(bpm)
    expect(store.getParam(FIRST_MENU_PARAM.id)).toBe(v)
  })

  it('menu falls back to home after 8s idle', () => {
    const { display } = make()
    btn(display, 'menu').click()
    vi.advanceTimersByTime(7999)
    expect(display.debugState.screen).toBe('menu')
    vi.advanceTimersByTime(1)
    expect(display.debugState.screen).toBe('home')
  })

  it('param moves while the menu is open do not switch to the overlay', () => {
    const { store, display } = make()
    btn(display, 'menu').click()
    store.setParam(P.CUTOFF, 480, 'ui')
    expect(display.debugState.screen).toBe('menu')
  })
})

describe('menu editing', () => {
  it('PROG EDIT page: [−]/[+] change the param through the store', () => {
    const { store, display } = make()
    btn(display, 'menu').click() // page 0 = first menu param
    const before = store.getParam(FIRST_MENU_PARAM.id)
    btn(display, 'plus').click()
    expect(store.getParam(FIRST_MENU_PARAM.id)).toBe(before + 1)
    btn(display, 'minus').click()
    btn(display, 'minus').click()
    expect(store.getParam(FIRST_MENU_PARAM.id)).toBe(before - 1)
  })

  it('PROG EDIT edits emit source "menu" so bound panel controls resync', () => {
    const { store, display } = make()
    const sources: string[] = []
    store.onParam((_id, _v, source) => sources.push(source))
    btn(display, 'menu').click()
    btn(display, 'plus').click()
    expect(sources).toEqual(['menu'])
  })

  it('BPM page: [+]/[−] step store.program.seq.bpm by 0.5', () => {
    const { store, display } = make()
    btn(display, 'menu').click()
    clickNext(display, MENU_COUNT) // first SEQ EDIT page = BPM
    const before = store.program.seq.bpm
    btn(display, 'plus').click()
    expect(store.program.seq.bpm).toBe(before + 0.5)
    btn(display, 'minus').click()
    btn(display, 'minus').click()
    expect(store.program.seq.bpm).toBe(before - 0.5)
  })

  it('press-and-hold [+] repeats after 250ms and swallows the trailing click', () => {
    const { store, display } = make()
    btn(display, 'menu').click()
    clickNext(display, MENU_COUNT)
    const before = store.program.seq.bpm
    const plus = btn(display, 'plus')

    plus.dispatchEvent(new Event('pointerdown'))
    expect(store.program.seq.bpm).toBe(before + 0.5) // fires on press
    vi.advanceTimersByTime(250 + 120) // hold: repeats at +60ms and +120ms
    plus.dispatchEvent(new Event('pointerup'))
    expect(store.program.seq.bpm).toBe(before + 1.5)

    plus.click() // trailing click of the pointer press: no double count
    expect(store.program.seq.bpm).toBe(before + 1.5)
    plus.click() // a later plain click edits again
    expect(store.program.seq.bpm).toBe(before + 2)
  })

  it('an aborted press (release off-button) does not swallow the next click', () => {
    const { store, display } = make()
    btn(display, 'menu').click()
    clickNext(display, MENU_COUNT) // BPM page
    const before = store.program.seq.bpm
    const plus = btn(display, 'plus')

    plus.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(store.program.seq.bpm).toBe(before + 0.5)
    // pointer released off the button: no trailing click is generated
    window.dispatchEvent(new Event('pointerup', { bubbles: true }))
    plus.click() // keyboard/synthetic click must still edit
    expect(store.program.seq.bpm).toBe(before + 1)

    // pointercancel mid-press must not swallow the next click either
    plus.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(store.program.seq.bpm).toBe(before + 1.5)
    plus.dispatchEvent(new Event('pointercancel', { bubbles: true }))
    plus.click()
    expect(store.program.seq.bpm).toBe(before + 2)
  })

  it('editing DEFAULT GATE during realtime rec records a GATE TIME motion lane', () => {
    const { store, display } = make()
    store.setPlaying(true)
    store.setRecMode('realtime')
    store.setPlayhead(2)
    btn(display, 'menu').click()
    clickNext(display, MENU_COUNT + SEQ_FIELD_COUNT - 1) // DEFAULT GATE page
    const before = store.program.seq.defaultGate

    btn(display, 'plus').click()
    expect(store.program.seq.defaultGate).toBe(before + 1)
    const lane = store.findMotionLane(MOTION_GATE_TIME)
    expect(lane).toBeGreaterThanOrEqual(0)
    const l = store.program.seq.motion[lane]
    expect(l.on).toBe(true)
    expect(l.smooth).toBe(true)
    expect(l.data[2]).toEqual([before + 1, before + 1, before + 1, before + 1, before + 1])
    btn(display, 'minus').click() // same step: traces the movement
    expect(l.data[2]).toEqual([before + 1, before + 1, before + 1, before + 1, before])

    store.setRecMode('off') // not recording: [-]/[+] edit the field only
    btn(display, 'plus').click()
    expect(store.program.seq.defaultGate).toBe(before + 1)
    expect(l.data[2]).toEqual([before + 1, before + 1, before + 1, before + 1, before])
  })

  it('motion page ASSIGN cycles the lane paramId through the store', () => {
    const { store, display } = make()
    btn(display, 'menu').click()
    clickNext(display, MENU_COUNT + SEQ_FIELD_COUNT) // first motion lane page
    expect(display.debugState.page).toBe(MENU_COUNT + SEQ_FIELD_COUNT)
    expect(store.program.seq.motion[0].paramId).toBe(-1)

    btn(display, 'plus').click()
    expect(store.program.seq.motion[0].paramId).toBe(MOTION_PARAM_IDS[0])
    btn(display, 'plus').click()
    expect(store.program.seq.motion[0].paramId).toBe(MOTION_PARAM_IDS[1])
    btn(display, 'minus').click()
    btn(display, 'minus').click()
    expect(store.program.seq.motion[0].paramId).toBe(-1)
  })

  it('motion sub-fields: ON and SMOOTH toggle, CLEAR resets the lane', () => {
    const { store, display } = make()
    btn(display, 'menu').click()
    clickNext(display, MENU_COUNT + SEQ_FIELD_COUNT)
    const lane = store.program.seq.motion[0]

    btn(display, 'plus').click() // ASSIGN -> first motion param
    btn(display, 'next').click() // field ON
    btn(display, 'plus').click()
    expect(lane.on).toBe(true)
    btn(display, 'next').click() // field SMOOTH
    btn(display, 'plus').click()
    expect(lane.smooth).toBe(true)
    btn(display, 'next').click() // field CLEAR
    btn(display, 'minus').click() // [-] on CLEAR: no-op
    expect(lane.paramId).toBe(MOTION_PARAM_IDS[0])
    btn(display, 'plus').click() // [+] EXEC
    expect(lane.paramId).toBe(-1)
    expect(lane.on).toBe(false)
    expect(lane.smooth).toBe(false)
  })

  it('◀ inside a motion page walks sub-fields back, then leaves the page', () => {
    const { display } = make()
    btn(display, 'menu').click()
    clickNext(display, MENU_COUNT + SEQ_FIELD_COUNT)
    btn(display, 'next').click() // ASSIGN -> ON (stays on the page)
    expect(display.debugState.page).toBe(MENU_COUNT + SEQ_FIELD_COUNT)
    btn(display, 'prev').click() // ON -> ASSIGN
    expect(display.debugState.page).toBe(MENU_COUNT + SEQ_FIELD_COUNT)
    btn(display, 'prev').click() // off the page: back to the last seq field
    expect(display.debugState.page).toBe(MENU_COUNT + SEQ_FIELD_COUNT - 1)
  })
})

describe('scope, MIDI indicator, program loads', () => {
  it('scopeFrame never throws when getContext(2d) returned null', () => {
    const { display } = make(false)
    expect(() => {
      display.scopeFrame(new Float32Array(256))
      pump() // render with null ctx must be a no-op, not a crash
    }).not.toThrow()
  })

  it('scopeFrame draws the waveform when a 2d context exists', () => {
    const { display, calls } = make()
    pump()
    const data = new Float32Array(256)
    for (let i = 0; i < data.length; i++) data[i] = Math.sin((i / 256) * Math.PI * 8)
    calls.length = 0
    expect(() => {
      display.scopeFrame(data)
      display.scopeFrame(new Float32Array(256)) // silence: no zero crossing
      pump()
    }).not.toThrow()
    expect(calls).toContain('stroke')
  })

  it('setMidiActive(true) shows the MIDI dot and auto-clears after ~150ms', () => {
    const { display, texts } = make()
    pump()
    display.setMidiActive(true)
    expect(renderTexts(texts)).toContain('MIDI')
    vi.advanceTimersByTime(150)
    expect(renderTexts(texts)).not.toContain('MIDI')
  })

  it('setMidiActive(false) clears the indicator immediately', () => {
    const { display, texts } = make()
    display.setMidiActive(true)
    display.setMidiActive(false)
    expect(renderTexts(texts)).not.toContain('MIDI')
    vi.advanceTimersByTime(1000) // cancelled flash timer must not throw/fire
    expect(renderTexts(texts)).not.toContain('MIDI')
  })

  it('home screen shows the loaded slot number and program name', () => {
    const { store, display, texts } = make()
    void display
    const first = renderTexts(texts)
    expect(first).toContain('001')
    expect(first).toContain(FACTORY_PRESETS[0].name.toUpperCase())

    store.loadSlot(2)
    const after = renderTexts(texts)
    expect(after).toContain('003')
    expect(after).toContain(FACTORY_PRESETS[2].name.toUpperCase())
  })

  it("program loads while the menu is open keep the page and don't spawn overlays", () => {
    const { store, display } = make()
    btn(display, 'menu').click()
    clickNext(display, MENU_COUNT) // BPM page
    store.loadSlot(1) // emits 94 'load' param events + program/seq events
    expect(display.debugState).toEqual({ screen: 'menu', page: MENU_COUNT })
  })
})
