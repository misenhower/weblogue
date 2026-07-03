// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { Engine, DBG_TAP_SIZE } from '../src/dsp/engine'
import { P } from '../src/shared/params'
import { DebugPanel } from '../src/ui/debugpanel'
import type { FromEngine } from '../src/shared/messages'

const SR = 48000

function render(e: Engine, seconds: number): void {
  const l = new Float32Array(128)
  const r = new Float32Array(128)
  const blocks = Math.ceil((seconds * SR) / 128)
  for (let i = 0; i < blocks; i++) e.process(l, r, 128)
}

describe('engine SERVICE MODE taps', () => {
  it('rings stay silent while debug is off, fill once enabled', () => {
    const e = new Engine(SR)
    const dst = [0, 1, 2, 3].map(() => new Float32Array(DBG_TAP_SIZE))

    e.noteOn(60, 100)
    render(e, 0.1)
    e.copyDebugTaps(dst)
    expect(dst[0].every((v) => v === 0)).toBe(true) // off: nothing recorded

    e.setDebug(true)
    render(e, 0.1)
    e.copyDebugTaps(dst)
    const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length)
    expect(rms(dst[0])).toBeGreaterThan(0.001) // VCO1 tap sees the saw
    expect(rms(dst[2])).toBeGreaterThan(0.001) // mix tap
    expect(rms(dst[3])).toBeGreaterThan(0.0005) // post-filter tap
    for (const d of dst) for (const v of d) expect(Number.isFinite(v)).toBe(true)
    e.noteOff(60)
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
    const taps = [0, 1, 2, 3].map(() => {
      const a = new Float32Array(DBG_TAP_SIZE)
      for (let i = 0; i < a.length; i++) a[i] = Math.sin((i / a.length) * Math.PI * 6)
      return a
    })
    return {
      t: 'dbg',
      taps,
      postFx: new Float32Array(256),
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
    const p = new DebugPanel()
    expect(p.el.querySelectorAll('.xd-svc-scope').length).toBe(5)
    expect(p.el.querySelectorAll('.xd-svc-lane').length).toBe(4)
    expect(p.el.querySelector('.xd-svc-load')).toBeTruthy()
  })

  it('update() reflects voices, drift, load, and tapped lane', () => {
    const p = new DebugPanel()
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
    const p = new DebugPanel()
    p.update(fakeMsg())
    const freqs = [...p.el.querySelectorAll('.xd-svc-freq')].map((n) => n.textContent)
    expect(freqs[0]).toBe('262.1Hz +3¢') // 262.1 vs C4 = 261.63 -> +3.1 cents
    expect(freqs[2]).toBe('--')
  })

  it('clicking a scope toggles spectrum mode and update still renders', () => {
    const p = new DebugPanel()
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
    const p = new DebugPanel()
    for (let i = 0; i < 140; i++) p.update(fakeMsg()) // > HISTORY wraps the ring
    expect(p.el.querySelectorAll('.xd-svc-mod-cv').length).toBe(3)
  })

  it('MOD row follows the tapped voice (per-voice histories + label)', () => {
    const p = new DebugPanel()
    const labels = () => [...p.el.querySelectorAll('.xd-svc-mod .xd-svc-label')].map((n) => n.textContent)
    p.update(fakeMsg())
    expect(labels()[0]).toBe('AMP EG · V2') // fakeMsg taps voice index 1
    const m = fakeMsg()
    m.tapped = 3
    p.update(m)
    expect(labels()).toEqual(['AMP EG · V4', 'MOD EG · V4', 'LFO · V4'])
  })

  it('close button fires onClose; null 2d context never throws', () => {
    const p = new DebugPanel()
    let closed = false
    p.onClose = () => (closed = true)
    ;(p.el.querySelector('.xd-svc-close') as HTMLButtonElement).click()
    expect(closed).toBe(true)
    expect(() => p.update(fakeMsg())).not.toThrow()
  })
})
