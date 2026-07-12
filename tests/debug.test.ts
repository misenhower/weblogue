// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Engine, DBG_TAP_SIZE } from '../src/synths/xd/engine'
import { P } from '../src/synths/xd/params'
import { Store } from '../src/state/store'
import { XD_DEF } from '../src/synths/xd/def'
import { DebugPanel } from '../src/ui/debugpanel'
import { XD_DEBUG_DEF } from '../src/synths/xd/debug-def'
import type { FromEngine } from '../src/shared/messages'
import { renderEngine as render, rms, SR } from './helpers/audio'
import { installLocalStorageMock } from './helpers/dom'

let restoreLocalStorage = (): void => {}
beforeEach(() => {
  restoreLocalStorage = installLocalStorageMock().restore
})
afterEach(() => restoreLocalStorage())

describe('engine SERVICE MODE taps', () => {
  it('rings stay silent while debug is off, fill once enabled', () => {
    const e = new Engine(SR)
    const dst = Array.from({ length: 12 }, () => new Float32Array(DBG_TAP_SIZE))

    e.noteOn(60, 100)
    render(e, 0.1)
    e.copyDebugTaps(dst)
    expect(dst[0].every((v) => v === 0)).toBe(true) // off: nothing recorded

    e.setDebug(true)
    render(e, 0.1)
    e.copyDebugTaps(dst)
    expect(rms(dst[0])).toBeGreaterThan(0.001) // VCO1 tap sees the saw
    expect(rms(dst[2])).toBeGreaterThan(0.001) // MULTI tap (VPM runs pre-mixer)
    expect(rms(dst[3])).toBeGreaterThan(0.001) // mix tap
    expect(rms(dst[4])).toBeGreaterThan(0.0005) // post-filter tap
    expect(rms(dst[5])).toBeGreaterThan(0.0005) // post-VCA (note held, EG up)
    expect(rms(dst[6])).toBeGreaterThan(0.0005) // post-mod-fx L
    expect(rms(dst[7])).toBeGreaterThan(0.0005) // post-mod-fx R
    expect(rms(dst[8])).toBeGreaterThan(0.0005) // post-delay L
    expect(rms(dst[10])).toBeGreaterThan(0.0005) // output L
    for (const d of dst) for (const v of d) expect(Number.isFinite(v)).toBe(true)
    e.noteOff(60)
  })

  it('4-voice taps record every voice separately in debugAll mode', () => {
    const e = new Engine(SR)
    e.setDebug(true)
    e.setDebugAll(true)
    e.noteOn(48, 100) // voice 0
    e.noteOn(72, 100) // voice 1, two octaves up
    render(e, 0.1)
    const v = Array.from({ length: 24 }, () => new Float32Array(DBG_TAP_SIZE))
    e.copyDebugVoiceTaps(v)
    expect(rms(v[0])).toBeGreaterThan(0.001) // v0 vco1
    expect(rms(v[6])).toBeGreaterThan(0.001) // v1 vco1
    expect(rms(v[12])).toBeLessThan(1e-6) // v2 idle -> silent ring
    // different pitches -> different waveform periods
    let diff = 0
    for (let i = 0; i < DBG_TAP_SIZE; i++) diff += (v[0][i] - v[6][i]) ** 2
    expect(Math.sqrt(diff / DBG_TAP_SIZE)).toBeGreaterThan(0.01)
    e.noteOff(48)
    e.noteOff(72)
    render(e, 0.5) // release tails die -> voices idle
    e.copyDebugVoiceTaps(v)
    // Idle voices write zeros, not frozen last samples (no phantom flat lines).
    expect(rms(v[0])).toBeLessThan(1e-6)
    expect(rms(v[6])).toBeLessThan(1e-6)
    e.setDebugAll(false)
    e.setDebug(false)
  })

  it('stereo FX taps diverge with a ping-pong delay', () => {
    const e = new Engine(SR)
    e.setDebug(true)
    e.setParam(P.DELAY_ON, 1)
    e.setParam(P.DELAY_SUB, 2) // PING PONG
    e.setParam(P.DELAY_TIME, 830) // ~350ms
    e.setParam(P.DELAY_DEPTH, 800)
    e.noteOn(60, 100)
    render(e, 0.15)
    e.noteOff(60)
    render(e, 0.3) // tap window lands inside the first echo (~350-500ms, L only)
    const dst = Array.from({ length: 12 }, () => new Float32Array(DBG_TAP_SIZE))
    e.copyDebugTaps(dst)
    let diff = 0
    for (let i = 0; i < DBG_TAP_SIZE; i++) diff += (dst[8][i] - dst[9][i]) ** 2
    expect(Math.sqrt(diff / DBG_TAP_SIZE)).toBeGreaterThan(1e-4) // delay L != R
    e.setDebug(false)
  })

  it('voice info reports the played note and drift within analog bounds', () => {
    const e = new Engine(SR)
    e.setDebug(true)
    e.noteOn(64, 100)
    render(e, 0.05)
    const tapped = e.debugVoice
    const info = e.debugVoiceInfo(tapped)
    expect(info.on).toBe(true)
    expect(info.note).toBe(64)
    expect(info.amp).toBeGreaterThan(0)
    expect(Math.abs(info.drift1)).toBeLessThan(6)
    expect(Math.abs(info.drift2)).toBeLessThan(6)
    // Independent per-VCO drift: distinct seeds must not track each other.
    expect(info.drift1).not.toBe(info.drift2)
    e.noteOff(64)
  })
})

describe('idle drift (analog VCOs free-run)', () => {
  it('drift keeps evolving while no voice is active', () => {
    const e = new Engine(SR)
    e.setDebug(true)
    render(e, 0.1) // never played a note
    const a1 = e.debugVoiceInfo(0).drift1
    const a2 = e.debugVoiceInfo(0).drift2
    render(e, 1.5)
    const b1 = e.debugVoiceInfo(0).drift1
    const b2 = e.debugVoiceInfo(0).drift2
    expect(e.debugVoiceInfo(0).on).toBe(false)
    expect(b1).not.toBe(a1)
    expect(b2).not.toBe(a2)
  })
})

describe('round-robin voice allocation (hardware cycles voices)', () => {
  it('repeated presses of the same key cycle through all four voices', () => {
    const e = new Engine(SR)
    const used: number[] = []
    for (let p = 0; p < 5; p++) {
      e.noteOn(60, 100)
      render(e, 0.05)
      used.push(e.debugVoice)
      e.noteOff(60)
      render(e, 0.4) // let the release tail fully die -> voice goes idle
    }
    expect(used).toEqual([0, 1, 2, 3, 0])
  })

  it('a held key keeps its voice while a tapped key cycles the others', () => {
    const e = new Engine(SR)
    e.noteOn(48, 100) // held
    render(e, 0.05)
    const held = e.debugVoice
    const tapped: number[] = []
    for (let p = 0; p < 4; p++) {
      e.noteOn(72, 100)
      render(e, 0.05)
      tapped.push(e.debugVoice)
      e.noteOff(72)
      render(e, 0.4)
    }
    expect(e.debugVoiceInfo(held).on).toBe(true) // held voice never disturbed
    for (const t of tapped) expect(t).not.toBe(held)
    expect(new Set(tapped).size).toBe(3) // cycles the three free voices
    e.noteOff(48)
  })

  it('CHORD strikes rotate to fresh voices between presses', () => {
    const e = new Engine(SR)
    e.setParam(P.VOICE_MODE, 1) // CHORD
    e.setParam(P.VM_DEPTH, 30) // 5th zone: 2 tones
    const strike = (): number[] => {
      e.noteOn(60, 100)
      render(e, 0.05)
      const on = [0, 1, 2, 3].filter((i) => e.debugVoiceInfo(i).on)
      e.noteOff(60)
      render(e, 0.4)
      return on
    }
    const first = strike()
    const second = strike()
    expect(first.length).toBe(2)
    expect(second.length).toBe(2)
    expect(second).not.toEqual(first) // rotated to a different voice set
  })
})

describe('DebugPanel', () => {
  function fakeMsg(): Extract<FromEngine, { t: 'dbg' }> {
    const taps = Array.from({ length: 12 }, () => 0).map(() => {
      const a = new Float32Array(DBG_TAP_SIZE)
      for (let i = 0; i < a.length; i++) a[i] = Math.sin((i / a.length) * Math.PI * 6)
      return a
    })
    return {
      t: 'dbg',
      taps,
      voices: [
        { note: 60, on: true, amp: 0.8, drift1: 1.2, drift2: -0.7, modEg: 0.4, lfo: 0.2, hz: 262.1 },
        { note: 64, on: true, amp: 0.5, drift1: -2.4, drift2: 0.3, modEg: 0.1, lfo: -0.6, hz: 329.6 },
        { note: 0, on: false, amp: 0, drift1: 0, drift2: 0, modEg: 0, lfo: 0, hz: 0 },
        { note: 0, on: false, amp: 0, drift1: 0, drift2: 0, modEg: 0, lfo: 0, hz: 0 },
      ],
      load: 0.31,
      tapped: 1,
    }
  }

  it('builds 5 scopes, 4 lanes, and a health strip', () => {
    const p = new DebugPanel({ def: XD_DEBUG_DEF })
    expect(p.el.querySelectorAll('.xd-svc-scope').length).toBe(9)
    expect(p.el.querySelectorAll('.xd-svc-lane').length).toBe(4)
    expect(p.el.querySelector('.xd-svc-load')).toBeTruthy()
  })

  it('update() reflects voices, drift, load, and tapped lane', () => {
    const p = new DebugPanel({ def: XD_DEBUG_DEF })
    p.update(fakeMsg())
    const notes = [...p.el.querySelectorAll('.xd-svc-note')].map((n) => n.textContent)
    expect(notes[0]).toBe('C4')
    expect(notes[1]).toBe('E4')
    expect(notes[2]).toBe('--')
    const leds = p.el.querySelectorAll('.xd-svc-led.is-on')
    expect(leds.length).toBe(2)
    expect(p.el.querySelectorAll('.xd-svc-lane')[1].classList.contains('is-tapped')).toBe(true)
    expect(p.el.querySelector('.xd-svc-htext')!.textContent).toBe('31%')
    const drifts = [...p.el.querySelectorAll('.xd-svc-drift-text')].map((n) => n.textContent)
    expect(drifts[0]).toBe('+1.2 -0.7¢')
    expect(drifts[1]).toBe('-2.4 +0.3¢')
  })

  it('lane shows the tuning readout (Hz + cents vs equal temperament)', () => {
    const p = new DebugPanel({ def: XD_DEBUG_DEF })
    p.update(fakeMsg())
    const freqs = [...p.el.querySelectorAll('.xd-svc-freq')].map((n) => n.textContent)
    expect(freqs[0]).toBe('262.1Hz +3¢') // 262.1 vs C4 = 261.63 -> +3.1 cents
    expect(freqs[2]).toBe('--')
  })

  it('clicking a scope toggles spectrum mode and update still renders', () => {
    const p = new DebugPanel({ def: XD_DEBUG_DEF })
    const cell = p.el.querySelector('.xd-svc-tap') as HTMLElement
    const cv = cell.querySelector('.xd-svc-scope') as HTMLCanvasElement
    cv.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(cell.classList.contains('is-fft')).toBe(true)
    expect(cell.querySelector('.xd-svc-label')!.textContent).toContain('FFT')
    expect(() => p.update(fakeMsg())).not.toThrow()
    cv.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(cell.classList.contains('is-fft')).toBe(false)
  })

  it('MOD sparklines accumulate history without throwing', () => {
    const p = new DebugPanel({ def: XD_DEBUG_DEF })
    for (let i = 0; i < 140; i++) p.update(fakeMsg()) // > HISTORY wraps the ring
    expect(p.el.querySelectorAll('.xd-svc-mod-cv').length).toBe(3)
  })

  it('MOD row follows the tapped voice (per-voice histories + label)', () => {
    const p = new DebugPanel({ def: XD_DEBUG_DEF })
    const labels = () => [...p.el.querySelectorAll('.xd-svc-mod .xd-svc-label')].map((n) => n.textContent)
    p.update(fakeMsg())
    expect(labels()[0]).toBe('AMP EG · V2') // fakeMsg taps voice index 1
    const m = fakeMsg()
    m.tapped = 3
    p.update(m)
    expect(labels()).toEqual(['AMP EG · V4', 'MOD EG · V4', 'LFO · V4'])
  })

  it('routing wires and badges follow the store', () => {
    const store = new Store(XD_DEF)
    store.initCurrent()
    const p = new DebugPanel({ store, def: XD_DEBUG_DEF })
    const eg = p.el.querySelector('.xd-svc-badge--eg') as HTMLElement
    store.setParam(P.EG_TARGET, 2, 'ui')
    expect(eg.textContent).toBe('EG → PITCH')
    store.setParam(P.EG_TARGET, 0, 'ui')
    expect(eg.textContent).toBe('EG → CUTOFF')
    const pre = p.el.querySelectorAll('.xd-svc-wires path')[2] as SVGPathElement
    const post = p.el.querySelectorAll('.xd-svc-wires path')[3] as SVGPathElement
    store.setParam(P.MULTI_ROUTING, 1, 'ui')
    expect(pre.style.display).toBe('none')
    expect(post.style.display).toBe('')
    store.setParam(P.SYNC, 1, 'ui')
    expect(p.el.querySelectorAll('.xd-svc-mini')[0].classList.contains('is-on')).toBe(true)
  })

  it('view toggle swaps between diagram and compact, sharing the scope cells', () => {
    const p = new DebugPanel({ def: XD_DEBUG_DEF })
    expect(p.currentView).toBe('diagram')
    const diagram = p.el.querySelector('.xd-svc-diagram') as HTMLElement
    const compact = p.el.querySelector('.xd-svc-compact') as HTMLElement
    expect(compact.style.display).toBe('none')
    const btns = [...p.el.querySelectorAll('.xd-svc-seg-btn')] as HTMLButtonElement[]
    const byLabel = (l: string): HTMLButtonElement => btns.find((b) => b.textContent === l)!
    byLabel('COMPACT').click()
    expect(p.currentView).toBe('compact')
    expect(diagram.style.display).toBe('none')
    expect(compact.style.display).toBe('')
    // 6 cells move into the compact row; the 2 FX taps stay in the hidden diagram.
    expect(compact.querySelectorAll('.xd-svc-tap').length).toBe(6)
    expect(diagram.querySelectorAll('.xd-svc-tap').length).toBe(3)
    expect(() => p.update(fakeMsg())).not.toThrow()
    byLabel('DIAGRAM').click()
    expect(diagram.querySelectorAll('.xd-svc-tap').length).toBe(9)
    expect(localStorage.getItem('xd-svc-view')).toBe('diagram')
  })

  it('1V/4V toggle fires onVoicesMode and persists', () => {
    localStorage.removeItem('xd-svc-voices')
    const p = new DebugPanel({ def: XD_DEBUG_DEF })
    expect(p.voicesAll).toBe(false)
    let last: boolean | null = null
    p.onVoicesMode = (all) => (last = all)
    const btns = [...p.el.querySelectorAll('.xd-svc-seg .xd-svc-seg-btn')] as HTMLButtonElement[]
    const btn4v = btns.find((b) => b.textContent === '4V')!
    btn4v.click()
    expect(p.voicesAll).toBe(true)
    expect(last).toBe(true)
    expect(localStorage.getItem('xd-svc-voices')).toBe('all')
    // 4-voice frame renders without throwing (two distinct voices)
    const m = fakeMsg()
    m.vtaps = Array.from({ length: 24 }, (_, k) => {
      const a = new Float32Array(DBG_TAP_SIZE)
      if (k < 12) for (let i = 0; i < a.length; i++) a[i] = Math.sin((i / a.length) * Math.PI * (4 + k))
      return a
    })
    expect(() => p.update(m)).not.toThrow()
    // 4V disables the last-triggered mechanism: no lane highlight, plain labels.
    expect(p.el.querySelectorAll('.xd-svc-lane.is-tapped').length).toBe(0)
    const labels = [...p.el.querySelectorAll('.xd-svc-mod .xd-svc-label')].map((n) => n.textContent)
    expect(labels).toEqual(['AMP EG', 'MOD EG', 'LFO'])
    // back to 1V: highlight and voice suffix return
    const btn1v = btns.find((b) => b.textContent === '1V')!
    btn1v.click()
    p.update(fakeMsg())
    expect(p.el.querySelectorAll('.xd-svc-lane.is-tapped').length).toBe(1)
    expect(p.el.querySelector('.xd-svc-mod .xd-svc-label')!.textContent).toBe('AMP EG · V2')
    localStorage.removeItem('xd-svc-voices')
  })

  it('dragging the header repositions the drawer and persists', () => {
    localStorage.removeItem('xd-svc-pos')
    const p = new DebugPanel({ def: XD_DEBUG_DEF })
    document.body.appendChild(p.el)
    const head = p.el.querySelector('.xd-svc-head') as HTMLElement
    head.dispatchEvent(new PointerEvent('pointerdown', { clientX: 400, clientY: 300, bubbles: true }))
    head.dispatchEvent(new PointerEvent('pointermove', { clientX: 340, clientY: 220, bubbles: true }))
    head.dispatchEvent(new PointerEvent('pointerup', { clientX: 340, clientY: 220, bubbles: true }))
    expect(p.el.style.left).not.toBe('')
    expect(p.el.style.right).toBe('auto')
    const saved = JSON.parse(localStorage.getItem('xd-svc-pos') ?? '{}')
    expect(Number.isFinite(saved.x)).toBe(true)
    expect(Number.isFinite(saved.y)).toBe(true)
    // a fresh panel restores the saved position
    const p2 = new DebugPanel({ def: XD_DEBUG_DEF })
    expect(p2.el.style.left).not.toBe('')
    p.el.remove()
    localStorage.removeItem('xd-svc-pos')
  })

  it('pointerdown on the view/close buttons does not start a drag', () => {
    localStorage.removeItem('xd-svc-pos')
    const p = new DebugPanel({ def: XD_DEBUG_DEF })
    const btn = p.el.querySelector('.xd-svc-seg-btn') as HTMLButtonElement
    btn.dispatchEvent(new PointerEvent('pointerdown', { clientX: 10, clientY: 10, bubbles: true }))
    const head = p.el.querySelector('.xd-svc-head') as HTMLElement
    head.dispatchEvent(new PointerEvent('pointermove', { clientX: 200, clientY: 200, bubbles: true }))
    head.dispatchEvent(new PointerEvent('pointerup', { clientX: 200, clientY: 200, bubbles: true }))
    expect(p.el.style.left).toBe('')
    localStorage.removeItem('xd-svc-pos')
  })

  it('close button fires onClose; null 2d context never throws', () => {
    const p = new DebugPanel({ def: XD_DEBUG_DEF })
    let closed = false
    p.onClose = () => (closed = true)
    ;(p.el.querySelector('.xd-svc-close') as HTMLButtonElement).click()
    expect(closed).toBe(true)
    expect(() => p.update(fakeMsg())).not.toThrow()
  })
})
