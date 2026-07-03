/**
 * UI primitives for the Korg minilogue xd panel replica.
 *
 * Framework-free: every component builds its own DOM (document.createElement
 * + inline SVG) and exposes:
 *   el: HTMLElement
 *   getValue(): number
 *   setValue(v: number, opts?: { silent?: boolean }): void   // silent skips onInput
 *
 * Styling lives in src/ui/theme.css (all classes prefixed `xd-`). The
 * integrator must import that stylesheet once (e.g. from main.ts).
 */

export interface SetValueOpts {
  silent?: boolean
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

let uidCounter = 0

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

const SVG_NS = 'http://www.w3.org/2000/svg'

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag)
  for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]!)
  return el
}

function div(className: string, text?: string): HTMLDivElement {
  const d = document.createElement('div')
  d.className = className
  if (text !== undefined) d.textContent = text
  return d
}

/** Angle in degrees, 0 = straight up, positive clockwise. */
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)]
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r, a0)
  const [x1, y1] = polar(cx, cy, r, a1)
  const large = a1 - a0 > 180 ? 1 : 0
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
}

function radialTick(deg: number, r0: number, r1: number, cls: string): SVGLineElement {
  const [x0, y0] = polar(50, 50, r0, deg)
  const [x1, y1] = polar(50, 50, r1, deg)
  return svgEl('line', {
    x1: x0.toFixed(2),
    y1: y0.toFixed(2),
    x2: x1.toFixed(2),
    y2: y1.toFixed(2),
    class: cls,
  })
}

function capturePointer(target: EventTarget | null, e: PointerEvent): void {
  const t = target as HTMLElement | null
  if (t && typeof t.setPointerCapture === 'function' && e.pointerId !== undefined) {
    try {
      t.setPointerCapture(e.pointerId)
    } catch {
      /* happy-dom / stale pointer id — capture is an enhancement only */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Knob                                                                */
/* ------------------------------------------------------------------ */

export interface KnobOpts {
  label: string
  size?: 'xl' | 'l' | 'm'
  min: number
  max: number
  value: number
  defaultValue?: number
  step?: number
  bipolar?: boolean
  format?: (v: number) => string
  onInput?: (v: number) => void
}

const KNOB_SWEEP = 270 // degrees, -135..+135

export class Knob {
  el: HTMLElement

  private min: number
  private max: number
  private step: number
  private value: number
  private defaultValue: number
  private format: (v: number) => string
  private onInput: ((v: number) => void) | undefined

  private rot: SVGGElement
  private tip: HTMLDivElement

  private dragging = false
  private dragRaw = 0
  private lastY = 0
  private pid: number | undefined

  constructor(opts: KnobOpts) {
    this.min = opts.min
    this.max = opts.max
    this.step = opts.step !== undefined && opts.step > 0 ? opts.step : 1
    this.defaultValue = opts.defaultValue ?? opts.min
    this.format = opts.format ?? ((v: number) => String(v))
    this.onInput = opts.onInput
    this.value = this.quantize(Number.isFinite(opts.value) ? opts.value : this.min)

    const size = opts.size ?? 'm'
    const root = div(`xd-knob xd-knob--${size}`)
    root.tabIndex = 0
    root.setAttribute('role', 'slider')
    root.setAttribute('aria-label', opts.label)
    root.setAttribute('aria-orientation', 'vertical')
    root.setAttribute('aria-valuemin', String(this.min))
    root.setAttribute('aria-valuemax', String(this.max))

    /* --- SVG rotary ------------------------------------------------ */
    const svg = svgEl('svg', {
      viewBox: '0 0 100 100',
      class: 'xd-knob-svg',
      'aria-hidden': 'true',
    })

    const gid = `xd-knob-grad-${uidCounter++}`
    const defs = svgEl('defs')
    const grad = svgEl('radialGradient', { id: gid, cx: '50%', cy: '30%', r: '80%' })
    grad.append(
      svgEl('stop', { offset: '0%', style: 'stop-color: var(--xd-knob-hi, #3a3a40)' }),
      svgEl('stop', { offset: '55%', style: 'stop-color: var(--xd-knob, #141416)' }),
      svgEl('stop', { offset: '100%', style: 'stop-color: #060607' }),
    )
    defs.append(grad)

    // subtle tick arc behind the cap, plus end ticks (and center detent tick)
    const arc = svgEl('path', { d: arcPath(50, 50, 45, -135, 135), class: 'xd-knob-arc' })
    const tickMin = radialTick(-135, 41, 48.5, 'xd-knob-tick')
    const tickMax = radialTick(135, 41, 48.5, 'xd-knob-tick')

    const skirt = svgEl('circle', { cx: '50', cy: '50', r: '37', class: 'xd-knob-skirt' })
    const cap = svgEl('circle', {
      cx: '50',
      cy: '50',
      r: '32',
      fill: `url(#${gid})`,
      class: 'xd-knob-cap',
    })

    this.rot = svgEl('g', { class: 'xd-knob-rot' })
    this.rot.append(
      svgEl('line', { x1: '50', y1: '21', x2: '50', y2: '33', class: 'xd-knob-ptr' }),
    )

    svg.append(defs, arc, tickMin, tickMax)
    if (opts.bipolar) svg.append(radialTick(0, 41, 48.5, 'xd-knob-tick xd-knob-tick--center'))
    svg.append(skirt, cap, this.rot)

    /* --- tooltip + label ------------------------------------------- */
    this.tip = div('xd-knob-tip')
    this.tip.hidden = true
    const label = div('xd-legend xd-knob-label', opts.label)

    root.append(svg, this.tip, label)
    this.el = root

    root.addEventListener('pointerdown', this.onPointerDown)
    root.addEventListener('wheel', this.onWheel, { passive: false })
    root.addEventListener('dblclick', this.onDblClick)
    root.addEventListener('keydown', this.onKeyDown)

    this.render()
  }

  getValue(): number {
    return this.value
  }

  setValue(v: number, opts?: SetValueOpts): void {
    if (!Number.isFinite(v)) return
    const q = this.quantize(v)
    const changed = q !== this.value
    this.value = q
    this.dragRaw = q
    this.render()
    if (changed && !opts?.silent) this.onInput?.(q)
  }

  /** Re-range a dynamically re-addressed knob (silent; value is re-clamped). */
  setRange(min: number, max: number): void {
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return
    if (min === this.min && max === this.max) return
    this.min = min
    this.max = max
    this.el.setAttribute('aria-valuemin', String(min))
    this.el.setAttribute('aria-valuemax', String(max))
    this.value = this.quantize(this.value)
    this.dragRaw = this.value
    this.render()
  }

  /* --- internals --------------------------------------------------- */

  private quantize(v: number): number {
    const c = clamp(v, this.min, this.max)
    const q = this.min + Math.round((c - this.min) / this.step) * this.step
    // kill float noise (e.g. 0.30000000000000004) then re-clamp
    return clamp(Math.round(q * 1e9) / 1e9, this.min, this.max)
  }

  private norm(): number {
    const range = this.max - this.min
    return range > 0 ? (this.value - this.min) / range : 0.5
  }

  private render(): void {
    const deg = -135 + KNOB_SWEEP * this.norm()
    this.rot.setAttribute('transform', `rotate(${deg.toFixed(2)} 50 50)`)
    this.el.setAttribute('aria-valuenow', String(this.value))
    this.el.setAttribute('aria-valuetext', this.format(this.value))
    if (!this.tip.hidden) this.tip.textContent = this.format(this.value)
  }

  private apply(v: number): void {
    const q = this.quantize(v)
    if (q !== this.value) {
      this.value = q
      this.render()
      this.onInput?.(q)
    }
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== undefined && e.button !== 0) return
    e.preventDefault()
    this.dragging = true
    this.pid = e.pointerId
    this.dragRaw = this.value
    this.lastY = e.clientY
    this.el.classList.add('is-dragging')
    capturePointer(e.currentTarget, e)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerUp)
    this.tip.hidden = false
    this.tip.textContent = this.format(this.value)
    this.el.focus?.()
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return
    if (this.pid !== undefined && e.pointerId !== undefined && e.pointerId !== this.pid) return
    const range = this.max - this.min
    const mult = e.shiftKey ? 0.1 : 1 // SHIFT = fine
    const dy = this.lastY - e.clientY // drag up = increase
    this.lastY = e.clientY
    this.dragRaw = clamp(this.dragRaw + dy * (range / 160) * mult, this.min, this.max)
    this.apply(this.dragRaw)
    this.tip.textContent = this.format(this.value)
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (this.pid !== undefined && e.pointerId !== undefined && e.pointerId !== this.pid) return
    this.dragging = false
    this.pid = undefined
    this.el.classList.remove('is-dragging')
    this.tip.hidden = true
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerUp)
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const dir = e.deltaY < 0 ? 1 : e.deltaY > 0 ? -1 : 0
    if (dir === 0) return
    const range = this.max - this.min
    // coarse: ~1/50th of range snapped to step; SHIFT: single step
    const coarse = Math.max(this.step, Math.round(range / 50 / this.step) * this.step)
    const inc = e.shiftKey ? this.step : coarse
    this.dragRaw = clamp(this.value + dir * inc, this.min, this.max)
    this.apply(this.dragRaw)
  }

  private onDblClick = (e: MouseEvent): void => {
    e.preventDefault()
    this.dragRaw = this.defaultValue
    this.apply(this.defaultValue)
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    let d = 0
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        d = 1
        break
      case 'ArrowDown':
      case 'ArrowLeft':
        d = -1
        break
      case 'PageUp':
        d = 10
        break
      case 'PageDown':
        d = -10
        break
      case 'Home':
        e.preventDefault()
        this.dragRaw = this.min
        this.apply(this.min)
        return
      case 'End':
        e.preventDefault()
        this.dragRaw = this.max
        this.apply(this.max)
        return
      default:
        return
    }
    e.preventDefault()
    this.dragRaw = clamp(this.value + d * this.step, this.min, this.max)
    this.apply(this.dragRaw)
  }
}

/* ------------------------------------------------------------------ */
/* SelectorSwitch                                                      */
/* ------------------------------------------------------------------ */

export interface SelectorSwitchOpts {
  label: string
  positions: string[]
  value: number
  onInput?: (v: number) => void
}

const SELECTOR_ROW_PX = 22

export class SelectorSwitch {
  el: HTMLElement

  private value: number
  private n: number
  private onInput: ((v: number) => void) | undefined
  private lever: HTMLDivElement
  private slot: HTMLDivElement
  private posEls: HTMLButtonElement[] = []

  private leverMoved = 0
  private lastY = 0
  private draggingLever = false

  constructor(opts: SelectorSwitchOpts) {
    this.n = Math.max(1, opts.positions.length)
    this.onInput = opts.onInput
    this.value = clamp(Math.round(Number.isFinite(opts.value) ? opts.value : 0), 0, this.n - 1)

    const root = div('xd-selector')
    const row = div('xd-selector-row')

    this.slot = div('xd-selector-slot')
    this.slot.style.height = `${this.n * SELECTOR_ROW_PX}px`

    this.lever = div('xd-selector-lever')
    this.lever.setAttribute('role', 'button')
    this.lever.setAttribute('aria-label', `${opts.label} switch`)
    this.slot.append(this.lever)

    const labels = div('xd-selector-labels')
    for (let i = 0; i < this.n; i++) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'xd-legend xd-selector-pos'
      b.textContent = opts.positions[i] ?? ''
      b.addEventListener('click', () => this.setIndex(i, true))
      this.posEls.push(b)
      labels.append(b)
    }

    row.append(this.slot, labels)
    const label = div('xd-legend xd-selector-label', opts.label)
    root.append(row, label)
    this.el = root

    // lever: drag between positions, or click to cycle
    this.lever.addEventListener('pointerdown', this.onLeverDown)
    this.lever.addEventListener('click', () => {
      if (this.leverMoved < 4) this.setIndex((this.value + 1) % this.n, true)
    })

    this.renderPosition(false)
  }

  getValue(): number {
    return this.value
  }

  setValue(v: number, opts?: SetValueOpts): void {
    if (!Number.isFinite(v)) return
    this.setIndex(v, !opts?.silent)
  }

  /* --- internals --------------------------------------------------- */

  private setIndex(i: number, fire: boolean): void {
    const idx = clamp(Math.round(i), 0, this.n - 1)
    if (idx === this.value) return
    this.value = idx
    this.renderPosition(true)
    if (fire) this.onInput?.(idx)
  }

  private renderPosition(animate: boolean): void {
    if (!animate) this.lever.style.transition = 'none'
    this.lever.style.top = `${(this.value + 0.5) * SELECTOR_ROW_PX}px`
    if (!animate) {
      // restore snap animation on the next frame-ish tick
      this.lever.style.transition = ''
    }
    for (let i = 0; i < this.posEls.length; i++) {
      this.posEls[i]!.classList.toggle('is-active', i === this.value)
    }
    this.el.setAttribute('data-value', String(this.value))
  }

  private onLeverDown = (e: PointerEvent): void => {
    e.preventDefault()
    this.draggingLever = true
    this.leverMoved = 0
    this.lastY = e.clientY
    capturePointer(e.currentTarget, e)
    window.addEventListener('pointermove', this.onLeverMove)
    window.addEventListener('pointerup', this.onLeverUp)
    window.addEventListener('pointercancel', this.onLeverUp)
  }

  private onLeverMove = (e: PointerEvent): void => {
    if (!this.draggingLever) return
    this.leverMoved += Math.abs(e.clientY - this.lastY)
    this.lastY = e.clientY
    if (this.leverMoved < 4) return
    const rect = this.slot.getBoundingClientRect()
    if (rect.height > 0) {
      const idx = Math.floor(((e.clientY - rect.top) / rect.height) * this.n)
      this.setIndex(idx, true)
    }
  }

  private onLeverUp = (): void => {
    this.draggingLever = false
    window.removeEventListener('pointermove', this.onLeverMove)
    window.removeEventListener('pointerup', this.onLeverUp)
    window.removeEventListener('pointercancel', this.onLeverUp)
  }
}

/* ------------------------------------------------------------------ */
/* LedButton                                                           */
/* ------------------------------------------------------------------ */

export interface LedButtonOpts {
  label: string
  led?: 'white' | 'red'
  latching?: boolean
  onInput?: (v: number) => void
  onPress?: () => void
  onRelease?: () => void
}

export class LedButton {
  el: HTMLElement

  private value = 0
  private latching: boolean
  private onInput: ((v: number) => void) | undefined
  private onPress: (() => void) | undefined
  private onRelease: (() => void) | undefined
  private led: HTMLSpanElement
  private key: HTMLButtonElement
  private held = false

  constructor(opts: LedButtonOpts) {
    this.latching = opts.latching ?? false
    this.onInput = opts.onInput
    this.onPress = opts.onPress
    this.onRelease = opts.onRelease

    const root = div(`xd-ledbtn${opts.led === 'red' ? ' xd-ledbtn--red' : ''}`)

    this.key = document.createElement('button')
    this.key.type = 'button'
    this.key.className = 'xd-ledbtn-key'
    this.key.setAttribute('aria-label', opts.label)
    this.key.setAttribute('aria-pressed', 'false')

    this.led = document.createElement('span')
    this.led.className = 'xd-ledbtn-led'
    this.key.append(this.led)

    const label = div('xd-legend xd-ledbtn-label', opts.label)
    root.append(this.key, label)
    this.el = root

    this.key.addEventListener('pointerdown', this.onDown)
    this.key.addEventListener('pointerup', this.onUp)
    this.key.addEventListener('pointercancel', this.onUp)
    this.key.addEventListener('pointerleave', this.onUp)
    this.key.addEventListener('click', this.onClick)
    this.key.addEventListener('keydown', this.onKeyDown)
    this.key.addEventListener('keyup', this.onKeyUp)
  }

  getValue(): number {
    return this.value
  }

  setValue(v: number, opts?: SetValueOpts): void {
    if (!Number.isFinite(v)) return
    const nv = clamp(Math.round(v), 0, 1)
    const changed = nv !== this.value
    this.value = nv
    this.setLed(nv)
    this.key.setAttribute('aria-pressed', nv ? 'true' : 'false')
    if (changed && !opts?.silent) this.onInput?.(nv)
  }

  /** 0..1 LED brightness (independent of latched value, e.g. for blinking). */
  setLed(v: number): void {
    const b = clamp(Number.isFinite(v) ? v : 0, 0, 1)
    this.led.style.setProperty('--b', String(b))
  }

  /* --- internals --------------------------------------------------- */

  private onDown = (e: PointerEvent): void => {
    if (e.button !== undefined && e.button !== 0) return
    this.press()
  }

  /** Shared press path: pointerdown / Space / Enter keydown. */
  private press(): void {
    this.held = true
    this.onPress?.()
    if (!this.latching) this.setValue(1)
  }

  private onUp = (): void => {
    if (!this.held) return
    this.held = false
    this.onRelease?.()
    if (!this.latching) this.setValue(0)
  }

  private onClick = (): void => {
    if (this.latching) this.setValue(this.value ? 0 : 1)
  }

  // Space/Enter mirror the pointer path. No preventDefault: the browser's
  // synthesized click still lands in onClick, so a keyboard press runs the
  // same down -> up -> click(latch toggle) sequence as a pointer press.
  private onKeyDown = (e: KeyboardEvent): void => {
    if ((e.key !== ' ' && e.key !== 'Enter') || e.repeat || this.held) return
    this.press()
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.key !== ' ' && e.key !== 'Enter') return
    this.onUp()
  }
}

/* ------------------------------------------------------------------ */
/* StepButton                                                          */
/* ------------------------------------------------------------------ */

export type StepState = 'off' | 'dim' | 'on' | 'playing' | 'rec'

const STEP_STATES: readonly StepState[] = ['off', 'dim', 'on', 'playing', 'rec']

export interface StepButtonOpts {
  index: number
  onPress?: (index: number) => void
  onRelease?: (index: number) => void
}

export class StepButton {
  el: HTMLElement

  readonly index: number
  private value = 0
  private held = false
  private onPress: ((index: number) => void) | undefined
  private onRelease: ((index: number) => void) | undefined

  constructor(opts: StepButtonOpts) {
    this.index = opts.index
    this.onPress = opts.onPress
    this.onRelease = opts.onRelease

    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'xd-step xd-step--off'
    b.setAttribute('aria-label', `Step ${opts.index + 1}`)
    b.setAttribute('aria-pressed', 'false')

    const led = document.createElement('span')
    led.className = 'xd-step-led'
    const num = document.createElement('span')
    num.className = 'xd-step-num'
    num.textContent = String(opts.index + 1)
    b.append(led, num)
    this.el = b

    b.addEventListener('pointerdown', this.onDown)
    b.addEventListener('pointerup', this.onUp)
    b.addEventListener('pointercancel', this.onUp)
    b.addEventListener('pointerleave', this.onUp)
    b.addEventListener('keydown', this.onKeyDown)
    b.addEventListener('keyup', this.onKeyUp)
  }

  getValue(): number {
    return this.value
  }

  setValue(v: number, _opts?: SetValueOpts): void {
    if (!Number.isFinite(v)) return
    this.value = clamp(Math.round(v), 0, 1)
  }

  setState(s: StepState): void {
    for (const st of STEP_STATES) this.el.classList.toggle(`xd-step--${st}`, st === s)
    this.el.setAttribute('aria-pressed', s === 'off' ? 'false' : 'true')
  }

  /* --- internals --------------------------------------------------- */

  private onDown = (e: PointerEvent): void => {
    if (e.button !== undefined && e.button !== 0) return
    this.press()
  }

  /** Shared press path: pointerdown / Space / Enter keydown. */
  private press(): void {
    this.held = true
    this.value = 1
    this.el.classList.add('is-held')
    this.onPress?.(this.index)
  }

  private onUp = (): void => {
    if (!this.held) return
    this.held = false
    this.value = 0
    this.el.classList.remove('is-held')
    this.onRelease?.(this.index)
  }

  // Space/Enter mirror the pointer press/release path (no click handler here,
  // so the browser's synthesized click is harmless).
  private onKeyDown = (e: KeyboardEvent): void => {
    if ((e.key !== ' ' && e.key !== 'Enter') || e.repeat || this.held) return
    this.press()
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.key !== ' ' && e.key !== 'Enter') return
    this.onUp()
  }
}

/* ------------------------------------------------------------------ */
/* EncoderWheel                                                        */
/* ------------------------------------------------------------------ */

export interface EncoderWheelOpts {
  label: string
  onStep?: (dir: 1 | -1) => void
  onPress?: () => void
}

const ENCODER_DETENT_PX = 12
const ENCODER_DETENT_DEG = 18

export class EncoderWheel {
  el: HTMLElement

  private steps = 0 // accumulated detent count (endless)
  private angle = 0
  private acc = 0
  private moved = 0
  private lastY = 0
  private dragging = false
  private onStepCb: ((dir: 1 | -1) => void) | undefined
  private onPressCb: (() => void) | undefined
  private rot: SVGGElement

  constructor(opts: EncoderWheelOpts) {
    this.onStepCb = opts.onStep
    this.onPressCb = opts.onPress

    const root = div('xd-encoder')
    root.tabIndex = 0
    root.setAttribute('role', 'button')
    root.setAttribute('aria-label', opts.label)

    const svg = svgEl('svg', {
      viewBox: '0 0 100 100',
      class: 'xd-encoder-svg',
      'aria-hidden': 'true',
    })

    const gid = `xd-enc-grad-${uidCounter++}`
    const defs = svgEl('defs')
    const grad = svgEl('radialGradient', { id: gid, cx: '50%', cy: '32%', r: '80%' })
    grad.append(
      svgEl('stop', { offset: '0%', style: 'stop-color: var(--xd-knob-hi, #3a3a40)' }),
      svgEl('stop', { offset: '60%', style: 'stop-color: var(--xd-knob, #141416)' }),
      svgEl('stop', { offset: '100%', style: 'stop-color: #060607' }),
    )
    defs.append(grad)

    const rim = svgEl('circle', { cx: '50', cy: '50', r: '44', class: 'xd-encoder-rim' })
    this.rot = svgEl('g', { class: 'xd-encoder-rot' })
    // knurled edge: dashed thick stroke ring
    this.rot.append(
      svgEl('circle', { cx: '50', cy: '50', r: '39', class: 'xd-encoder-knurl' }),
    )
    const cap = svgEl('circle', {
      cx: '50',
      cy: '50',
      r: '30',
      fill: `url(#${gid})`,
      class: 'xd-encoder-cap',
    })

    svg.append(defs, rim, this.rot, cap)
    const label = div('xd-legend xd-encoder-label', opts.label)
    root.append(svg, label)
    this.el = root

    root.addEventListener('pointerdown', this.onDown)
    root.addEventListener('wheel', this.onWheel, { passive: false })
    root.addEventListener('keydown', this.onKeyDown)
  }

  /** Accumulated detent count since construction (endless encoder). */
  getValue(): number {
    return this.steps
  }

  setValue(v: number, _opts?: SetValueOpts): void {
    if (!Number.isFinite(v)) return
    this.steps = Math.round(v)
  }

  /* --- internals --------------------------------------------------- */

  private emit(dir: 1 | -1): void {
    this.steps += dir
    this.angle += dir * ENCODER_DETENT_DEG
    this.rot.setAttribute('transform', `rotate(${this.angle} 50 50)`)
    this.onStepCb?.(dir)
  }

  private onDown = (e: PointerEvent): void => {
    if (e.button !== undefined && e.button !== 0) return
    e.preventDefault()
    this.dragging = true
    this.acc = 0
    this.moved = 0
    this.lastY = e.clientY
    this.el.classList.add('is-dragging')
    capturePointer(e.currentTarget, e)
    window.addEventListener('pointermove', this.onMove)
    window.addEventListener('pointerup', this.onUp)
    window.addEventListener('pointercancel', this.onUp)
    this.el.focus?.()
  }

  private onMove = (e: PointerEvent): void => {
    if (!this.dragging) return
    const dy = this.lastY - e.clientY
    this.lastY = e.clientY
    this.moved += Math.abs(dy)
    this.acc += dy
    while (this.acc >= ENCODER_DETENT_PX) {
      this.acc -= ENCODER_DETENT_PX
      this.emit(1)
    }
    while (this.acc <= -ENCODER_DETENT_PX) {
      this.acc += ENCODER_DETENT_PX
      this.emit(-1)
    }
  }

  private onUp = (): void => {
    if (!this.dragging) return
    this.dragging = false
    this.el.classList.remove('is-dragging')
    window.removeEventListener('pointermove', this.onMove)
    window.removeEventListener('pointerup', this.onUp)
    window.removeEventListener('pointercancel', this.onUp)
    if (this.moved < 4) this.onPressCb?.() // tap = push-enter
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    if (e.deltaY < 0) this.emit(1)
    else if (e.deltaY > 0) this.emit(-1)
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        e.preventDefault()
        this.emit(1)
        break
      case 'ArrowDown':
      case 'ArrowLeft':
        e.preventDefault()
        this.emit(-1)
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        this.onPressCb?.()
        break
    }
  }
}

/* ------------------------------------------------------------------ */
/* Led                                                                 */
/* ------------------------------------------------------------------ */

export interface LedOpts {
  color?: 'white' | 'red'
}

export class Led {
  el: HTMLElement

  private brightness = 0

  constructor(opts?: LedOpts) {
    const s = document.createElement('span')
    s.className = `xd-led${opts?.color === 'red' ? ' xd-led--red' : ''}`
    s.setAttribute('aria-hidden', 'true')
    this.el = s
    this.setOn(0)
  }

  setOn(v: number): void {
    this.brightness = clamp(Number.isFinite(v) ? v : 0, 0, 1)
    this.el.style.setProperty('--b', String(this.brightness))
  }

  getValue(): number {
    return this.brightness
  }

  setValue(v: number, _opts?: SetValueOpts): void {
    this.setOn(v)
  }
}
