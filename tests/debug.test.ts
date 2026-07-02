// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { Engine, DBG_TAP_SIZE } from '../src/dsp/engine'
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
    expect(Math.abs(info.drift)).toBeLessThan(6)
    e.noteOff(64)
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
        { note: 60, on: true, amp: 0.8, drift: 1.2 },
        { note: 64, on: true, amp: 0.5, drift: -2.4 },
        { note: 0, on: false, amp: 0, drift: 0 },
        { note: 0, on: false, amp: 0, drift: 0 },
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
    expect(drifts[0]).toBe('+1.2¢')
    expect(drifts[1]).toBe('-2.4¢')
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
