// @vitest-environment happy-dom
/*
 * OLED Display over the OG synth definition: the display is synth-agnostic
 * and takes an injected DisplayDef — construct it with OG_DISPLAY_DEF over an
 * OG Store, check the home screen shows the program name, and that the menu
 * pages are the OG's §11 set (og items present, no xd-only pages like
 * MICROTUNING or the joystick assigns).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreDef } from '../src/synths/def'
import { Store } from '../src/state/store'
import { PARAMS, PARAM_COUNT, clampParam } from '../src/synths/og/params'
import {
  initProgram,
  cloneProgram,
  serializeProgram,
  deserializeProgram,
} from '../src/synths/og/program'
import { OG_DISPLAY_DEF } from '../src/synths/og/display-def'
import { Display } from '../src/ui/display'

const OG_TEST_DEF: StoreDef = {
  id: 'og',
  params: PARAMS,
  paramCount: PARAM_COUNT,
  clampParam,
  initProgram,
  cloneProgram,
  serializeProgram,
  deserializeProgram,
  factoryPresets: [],
  bankKey: 'og-test-display',
  numSlots: 500,
}

const MENU_COUNT = PARAMS.filter((p) => p.kind === 'menu').length

/* ------------------------------------------------- rAF pump + mock 2d ctx */

let rafQ: FrameRequestCallback[] = []

function pump(): void {
  for (let round = 0; round < 5 && rafQ.length > 0; round++) {
    const q = rafQ
    rafQ = []
    for (const cb of q) cb(0)
  }
}

function makeCtx(): { ctx: CanvasRenderingContext2D; texts: string[] } {
  const texts: string[] = []
  const noop = (): void => {}
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
    setTransform: noop,
    fillRect: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    stroke: noop,
    arc: noop,
    fill: noop,
    fillText: (s: string): void => {
      texts.push(s)
    },
  }
  return { ctx: target as unknown as CanvasRenderingContext2D, texts }
}

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
    /* no storage in this env */
  }
  document.body.innerHTML = ''
})

afterEach(() => {
  canvasProto.getContext = origGetContext
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function make(): { store: Store; display: Display; texts: string[] } {
  const m = makeCtx()
  nextCtx = m.ctx
  const store = new Store(OG_TEST_DEF)
  const display = new Display({ store, def: OG_DISPLAY_DEF })
  document.body.appendChild(display.el)
  return { store, display, texts: m.texts }
}

function btn(display: Display, role: 'menu' | 'next'): HTMLButtonElement {
  const b = display.el.querySelector<HTMLButtonElement>('.xd-oled-softbtn--' + role)
  if (!b) throw new Error('missing soft button: ' + role)
  return b
}

/** Fresh texts from the next coalesced render. */
function renderTexts(texts: string[]): string[] {
  texts.length = 0
  pump()
  return texts.slice()
}

/* ================================================================== tests */

describe('Display with OG_DISPLAY_DEF', () => {
  it('constructs over an OG store and renders the program slot + name', () => {
    const { store, texts } = make()
    const drawn = renderTexts(texts)
    expect(drawn).toContain('001')
    expect(drawn).toContain(store.program.name.toUpperCase())
  })

  it('menu shows OG menu items and none of the xd-only pages', () => {
    const { display, texts } = make()
    btn(display, 'menu').click()
    expect(display.debugState).toEqual({ screen: 'menu', page: 0 })

    // First PROG EDIT page: the OG's first menu param (KBD OCTAVE).
    const first = renderTexts(texts)
    expect(first).toContain(`PROG EDIT  1/${MENU_COUNT}`)
    expect(first).toContain('KBD OCTAVE')

    // Walk every PROG EDIT page and collect all rendered labels.
    const all = [...first]
    for (let i = 1; i < MENU_COUNT; i++) {
      btn(display, 'next').click()
      all.push(...renderTexts(texts))
    }

    // og-spec.md §11 items are present...
    expect(all).toContain('SLIDER ASSIGN')
    expect(all).toContain('BEND RANGE +')
    expect(all).toContain('LFO BPM SYNC')
    expect(all).toContain('AMP VELOCITY')
    // ...and xd-only pages never appear.
    const joined = all.join('\n')
    expect(joined).not.toContain('MICROTUNING')
    expect(joined).not.toContain('JOYSTICK')
    expect(joined).not.toContain('MIDI AFTERTOUCH')
  })
})
