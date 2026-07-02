// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import {
  Knob,
  SelectorSwitch,
  LedButton,
  StepButton,
  EncoderWheel,
  Led,
} from '../src/ui/components'

/* happy-dom may or may not expose PointerEvent — fall back to MouseEvent. */
function pev(
  type: string,
  opts: { clientY?: number; clientX?: number; shiftKey?: boolean; deltaY?: number } = {},
): Event {
  const Ctor: typeof MouseEvent =
    (globalThis as Record<string, unknown>)['PointerEvent'] as typeof MouseEvent | undefined ??
    MouseEvent
  return new Ctor(type, {
    bubbles: true,
    cancelable: true,
    ...opts,
    ...( { pointerId: 1 } as MouseEventInit),
  })
}

function mount(el: HTMLElement): void {
  document.body.appendChild(el)
}

describe('Knob', () => {
  function makeKnob(onInput?: (v: number) => void) {
    const k = new Knob({
      label: 'CUTOFF',
      size: 'xl',
      min: 0,
      max: 1023,
      value: 0,
      defaultValue: 512,
      onInput,
    })
    mount(k.el)
    return k
  }

  it('builds expected DOM structure', () => {
    const k = makeKnob()
    expect(k.el).toBeInstanceOf(HTMLElement)
    expect(k.el.classList.contains('xd-knob')).toBe(true)
    expect(k.el.classList.contains('xd-knob--xl')).toBe(true)
    expect(k.el.querySelector('svg.xd-knob-svg')).toBeTruthy()
    expect(k.el.querySelector('.xd-knob-rot')).toBeTruthy()
    expect(k.el.querySelector('.xd-knob-ptr')).toBeTruthy()
    expect(k.el.querySelector('.xd-knob-label')?.textContent).toBe('CUTOFF')
    expect(k.el.getAttribute('role')).toBe('slider')
  })

  it('vertical drag fires onInput with clamped values', () => {
    const spy = vi.fn()
    const k = makeKnob(spy)

    k.el.dispatchEvent(pev('pointerdown', { clientY: 200 }))
    // 80px up = half of the 160px full-range travel
    k.el.dispatchEvent(pev('pointermove', { clientY: 120 }))
    expect(spy).toHaveBeenCalled()
    expect(k.getValue()).toBe(512)

    // drag far beyond the top — must clamp to max
    k.el.dispatchEvent(pev('pointermove', { clientY: -2000 }))
    expect(k.getValue()).toBe(1023)
    for (const call of spy.mock.calls) {
      expect(call[0]).toBeGreaterThanOrEqual(0)
      expect(call[0]).toBeLessThanOrEqual(1023)
    }

    k.el.dispatchEvent(pev('pointerup', { clientY: -2000 }))
    // after pointerup further moves are ignored
    const n = spy.mock.calls.length
    k.el.dispatchEvent(pev('pointermove', { clientY: 500 }))
    expect(spy.mock.calls.length).toBe(n)
    expect(k.getValue()).toBe(1023)
  })

  it('SHIFT drag is fine (x0.1)', () => {
    const k = makeKnob()
    k.el.dispatchEvent(pev('pointerdown', { clientY: 200 }))
    // full 160px travel but with shift -> 10% of range
    k.el.dispatchEvent(pev('pointermove', { clientY: 40, shiftKey: true }))
    expect(k.getValue()).toBe(102) // round(1023 * 0.1)
    k.el.dispatchEvent(pev('pointerup', {}))
  })

  it('shows a formatted tooltip while dragging', () => {
    const k = new Knob({
      label: 'EG INT',
      min: 0,
      max: 1023,
      value: 0,
      format: (v) => `${v} units`,
    })
    mount(k.el)
    const tip = k.el.querySelector('.xd-knob-tip') as HTMLElement
    expect(tip.hidden).toBe(true)
    k.el.dispatchEvent(pev('pointerdown', { clientY: 100 }))
    expect(tip.hidden).toBe(false)
    k.el.dispatchEvent(pev('pointermove', { clientY: 20 }))
    expect(tip.textContent).toBe(`${k.getValue()} units`)
    k.el.dispatchEvent(pev('pointerup', {}))
    expect(tip.hidden).toBe(true)
  })

  it('setValue clamps/quantizes; silent skips the callback', () => {
    const spy = vi.fn()
    const k = makeKnob(spy)
    k.setValue(2000, { silent: true })
    expect(k.getValue()).toBe(1023)
    expect(spy).not.toHaveBeenCalled()
    k.setValue(100.4, { silent: true })
    expect(k.getValue()).toBe(100)
    expect(spy).not.toHaveBeenCalled()

    k.setValue(7) // non-silent fires
    expect(spy).toHaveBeenCalledWith(7)

    k.setValue(Number.NaN)
    expect(k.getValue()).toBe(7) // NaN ignored
  })

  it('double-click resets to defaultValue', () => {
    const spy = vi.fn()
    const k = makeKnob(spy)
    k.setValue(900, { silent: true })
    k.el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    expect(k.getValue()).toBe(512)
    expect(spy).toHaveBeenCalledWith(512)
  })

  it('wheel adjusts value', () => {
    const spy = vi.fn()
    const k = makeKnob(spy)
    k.el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }))
    expect(k.getValue()).toBeGreaterThan(0)
    k.el.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }))
    expect(k.getValue()).toBe(0)
    expect(spy).toHaveBeenCalled()
  })
})

describe('SelectorSwitch', () => {
  function makeSel(onInput?: (v: number) => void) {
    const s = new SelectorSwitch({
      label: 'MULTI ENGINE',
      positions: ['NOISE', 'VPM', 'USR'],
      value: 0,
      onInput,
    })
    mount(s.el)
    return s
  }

  it('builds slot, lever and one label per position', () => {
    const s = makeSel()
    expect(s.el.querySelector('.xd-selector-slot')).toBeTruthy()
    expect(s.el.querySelector('.xd-selector-lever')).toBeTruthy()
    const labels = s.el.querySelectorAll('.xd-selector-pos')
    expect(labels.length).toBe(3)
    expect(labels[1]!.textContent).toBe('VPM')
  })

  it('clicking a position label changes the value and fires onInput', () => {
    const spy = vi.fn()
    const s = makeSel(spy)
    const labels = s.el.querySelectorAll<HTMLButtonElement>('.xd-selector-pos')
    labels[2]!.click()
    expect(s.getValue()).toBe(2)
    expect(spy).toHaveBeenCalledWith(2)
    expect(labels[2]!.classList.contains('is-active')).toBe(true)
    expect(labels[0]!.classList.contains('is-active')).toBe(false)
  })

  it('clicking the lever cycles through positions', () => {
    const spy = vi.fn()
    const s = makeSel(spy)
    const lever = s.el.querySelector('.xd-selector-lever') as HTMLElement
    lever.click()
    expect(s.getValue()).toBe(1)
    lever.click()
    expect(s.getValue()).toBe(2)
    lever.click()
    expect(s.getValue()).toBe(0) // wraps
    expect(spy).toHaveBeenCalledTimes(3)
  })

  it('setValue silent does not fire; clamps to range', () => {
    const spy = vi.fn()
    const s = makeSel(spy)
    s.setValue(2, { silent: true })
    expect(s.getValue()).toBe(2)
    expect(spy).not.toHaveBeenCalled()
    s.setValue(99, { silent: true })
    expect(s.getValue()).toBe(2) // clamped to last index
  })
})

describe('LedButton', () => {
  it('latching toggles 0/1 on click and lights the LED', () => {
    const spy = vi.fn()
    const b = new LedButton({ label: 'VOICE MODE', latching: true, onInput: spy })
    mount(b.el)
    const key = b.el.querySelector('button.xd-ledbtn-key') as HTMLButtonElement
    const led = b.el.querySelector('.xd-ledbtn-led') as HTMLElement
    expect(key).toBeTruthy()
    expect(led).toBeTruthy()

    key.click()
    expect(b.getValue()).toBe(1)
    expect(spy).toHaveBeenLastCalledWith(1)
    expect(led.style.getPropertyValue('--b')).toBe('1')

    key.click()
    expect(b.getValue()).toBe(0)
    expect(spy).toHaveBeenLastCalledWith(0)
    expect(led.style.getPropertyValue('--b')).toBe('0')
  })

  it('momentary fires onPress/onRelease around pointer events', () => {
    const press = vi.fn()
    const release = vi.fn()
    const b = new LedButton({ label: 'SHIFT', onPress: press, onRelease: release })
    mount(b.el)
    const key = b.el.querySelector('button.xd-ledbtn-key') as HTMLButtonElement
    key.dispatchEvent(pev('pointerdown', {}))
    expect(press).toHaveBeenCalledTimes(1)
    expect(b.getValue()).toBe(1)
    key.dispatchEvent(pev('pointerup', {}))
    expect(release).toHaveBeenCalledTimes(1)
    expect(b.getValue()).toBe(0)
  })

  it('setLed sets brightness and setValue(_, silent) skips onInput', () => {
    const spy = vi.fn()
    const b = new LedButton({ label: 'REC', led: 'red', latching: true, onInput: spy })
    expect(b.el.classList.contains('xd-ledbtn--red')).toBe(true)
    b.setLed(0.5)
    const led = b.el.querySelector('.xd-ledbtn-led') as HTMLElement
    expect(led.style.getPropertyValue('--b')).toBe('0.5')
    b.setValue(1, { silent: true })
    expect(b.getValue()).toBe(1)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('StepButton', () => {
  it('setState toggles the state classes', () => {
    const s = new StepButton({ index: 4 })
    mount(s.el)
    expect(s.el.classList.contains('xd-step')).toBe(true)
    expect(s.el.classList.contains('xd-step--off')).toBe(true)
    expect(s.el.querySelector('.xd-step-led')).toBeTruthy()
    expect(s.el.querySelector('.xd-step-num')?.textContent).toBe('5')

    s.setState('playing')
    expect(s.el.classList.contains('xd-step--playing')).toBe(true)
    expect(s.el.classList.contains('xd-step--off')).toBe(false)

    s.setState('rec')
    expect(s.el.classList.contains('xd-step--rec')).toBe(true)
    expect(s.el.classList.contains('xd-step--playing')).toBe(false)

    s.setState('dim')
    expect(s.el.classList.contains('xd-step--dim')).toBe(true)
    expect(s.el.classList.contains('xd-step--rec')).toBe(false)
  })

  it('press/release callbacks carry the step index', () => {
    const press = vi.fn()
    const release = vi.fn()
    const s = new StepButton({ index: 7, onPress: press, onRelease: release })
    mount(s.el)
    s.el.dispatchEvent(pev('pointerdown', {}))
    expect(press).toHaveBeenCalledWith(7)
    s.el.dispatchEvent(pev('pointerup', {}))
    expect(release).toHaveBeenCalledWith(7)
  })
})

describe('EncoderWheel', () => {
  it('wheel emits detent steps in both directions', () => {
    const step = vi.fn()
    const e = new EncoderWheel({ label: 'PROGRAM', onStep: step })
    mount(e.el)
    e.el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }))
    expect(step).toHaveBeenLastCalledWith(1)
    e.el.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true, cancelable: true }))
    expect(step).toHaveBeenLastCalledWith(-1)
    expect(e.getValue()).toBe(0) // one up + one down
  })

  it('drag emits steps every detent; a tap fires onPress', () => {
    const step = vi.fn()
    const press = vi.fn()
    const e = new EncoderWheel({ label: 'PROGRAM', onStep: step, onPress: press })
    mount(e.el)

    // drag 48px up -> 4 detents (12px each)
    e.el.dispatchEvent(pev('pointerdown', { clientY: 100 }))
    e.el.dispatchEvent(pev('pointermove', { clientY: 52 }))
    e.el.dispatchEvent(pev('pointerup', { clientY: 52 }))
    expect(step).toHaveBeenCalledTimes(4)
    expect(step).toHaveBeenLastCalledWith(1)
    expect(press).not.toHaveBeenCalled()

    // tap without movement = push-enter
    e.el.dispatchEvent(pev('pointerdown', { clientY: 100 }))
    e.el.dispatchEvent(pev('pointerup', { clientY: 100 }))
    expect(press).toHaveBeenCalledTimes(1)
  })
})

describe('Led', () => {
  it('renders and sets brightness via setOn', () => {
    const led = new Led({ color: 'red' })
    mount(led.el)
    expect(led.el.classList.contains('xd-led')).toBe(true)
    expect(led.el.classList.contains('xd-led--red')).toBe(true)
    led.setOn(0.5)
    expect(led.el.style.getPropertyValue('--b')).toBe('0.5')
    expect(led.getValue()).toBe(0.5)
    led.setOn(5) // clamps
    expect(led.getValue()).toBe(1)
    led.setOn(Number.NaN) // NaN -> 0
    expect(led.getValue()).toBe(0)
  })
})
