/*
 * OLED display module: canvas-drawn screen (HOME / param overlay / MENU)
 * plus a soft-button strip ([MENU] [◀] [▶] [−] [+], and a ⚙ settings-drawer
 * button when the app provides onSettings) replacing the hardware's
 * dedicated menu buttons.
 *
 * Rendering is requestAnimationFrame-driven but only when dirty (scope
 * frames arriving at ~20fps mark it dirty, so the scope animates without a
 * free-running loop). All state logic works without a 2d context so the
 * module stays fully testable under happy-dom.
 */
import type { Store, ParamSource } from '../state/store'
import { MOTION_GATE_TIME, type ParamMeta } from '../shared/paramdef'
import { NUM_MOTION_LANES } from '../shared/program'
import { bindHold } from './hold'
import { SEQ_FIELDS, type SeqFieldDef } from './seqfields'

/**
 * Synth-specific display surface, injected by the synth app (see
 * src/synths/<id>/display-def.ts). Everything else the OLED renders — seq
 * fields, motion lanes, scope, transport/MIDI indicators — is synth-agnostic.
 */
export interface DisplayDef {
  /** Parameter table (dense, id-indexed): overlay labels/ranges. */
  params: readonly ParamMeta[]
  formatParam(id: number, v: number): string
  /** PROG EDIT menu pages, in order. */
  menuParams: readonly ParamMeta[]
  /** Motion-lane ASSIGN cycle (recordable param ids + virtual targets). */
  motionParamIds: readonly number[]
  motionParamLabel(id: number): string
  /**
   * Transport surface. 'seq' = the full step-sequencer menu (SEQ EDIT fields
   * + motion-lane pages) and the REC status readouts. 'arp' = an arp-only
   * synth (the prologue has no sequencer): the menu keeps just a TEMPO
   * (seq.bpm) page and the REC affordances are hidden.
   */
  transport: 'seq' | 'arp'
  /** Status-line voice-mode readout (param id + short labels); optional. */
  voiceMode?: { id: number; labels: readonly string[] }
}

const SCREEN_W = 330
const SCREEN_H = 114

const OVERLAY_MS = 1100
const MENU_IDLE_MS = 8000
const MIDI_FLASH_MS = 150
const BLINK_MS = 320

const MONO = "ui-monospace, Menlo, Consolas, 'Courier New', monospace"

type Screen = 'home' | 'overlay' | 'menu'

const MOTION_FIELDS = ['ASSIGN', 'ON', 'SMOOTH', 'CLEAR'] as const

type Page =
  | { kind: 'prog'; i: number; meta: ParamMeta }
  | { kind: 'seq'; i: number; def: SeqFieldDef }
  | { kind: 'motion'; i: number; lane: number }

export class Display {
  el: HTMLElement

  private store: Store
  private def: DisplayDef
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D | null
  private dpr: number

  private menuBtn: HTMLButtonElement

  /* screen state */
  private screen: Screen = 'home'
  private page = 0
  private motionField = 0

  /* overlay */
  private overlayId = -1
  private overlayT: ReturnType<typeof setTimeout> | null = null

  /* timers / indicators */
  private idleT: ReturnType<typeof setTimeout> | null = null
  private midiOn = false
  private midiT: ReturnType<typeof setTimeout> | null = null
  private blinkOn = true
  private blinkIv: ReturnType<typeof setInterval> | null = null

  /* scope */
  private scope: Float32Array | null = null

  /* render scheduling */
  private dirty = false
  private rafPending = false

  /* cached theme colors (canvas cannot use CSS vars directly) */
  private fg = ''
  private bg = ''

  private menuParams: readonly ParamMeta[]
  /** SEQ EDIT fields shown ('arp' transport: TEMPO/bpm only). */
  private readonly seqFields: readonly SeqFieldDef[]
  /** Motion-lane pages shown ('arp' transport: none). */
  private readonly motionLanes: number

  constructor(opts: { store: Store; def: DisplayDef; onSettings?: () => void }) {
    this.store = opts.store
    this.def = opts.def
    this.menuParams = opts.def.menuParams
    const arpOnly = opts.def.transport === 'arp'
    this.seqFields = arpOnly ? SEQ_FIELDS.filter((f) => f.field === 'bpm') : SEQ_FIELDS
    this.motionLanes = arpOnly ? 0 : NUM_MOTION_LANES

    /* ---- DOM ------------------------------------------------------ */
    this.el = document.createElement('div')
    this.el.className = 'xd-oled'

    const screenWrap = document.createElement('div')
    screenWrap.className = 'xd-oled-screen'

    this.canvas = document.createElement('canvas')
    this.canvas.className = 'xd-oled-canvas'
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1
    this.dpr = dpr
    this.canvas.width = Math.round(SCREEN_W * dpr)
    this.canvas.height = Math.round(SCREEN_H * dpr)
    screenWrap.appendChild(this.canvas)

    const glass = document.createElement('div')
    glass.className = 'xd-oled-glass'
    screenWrap.appendChild(glass)

    const strip = document.createElement('div')
    strip.className = 'xd-oled-soft'
    this.menuBtn = this.softButton(strip, 'MENU', 'menu')
    const prevBtn = this.softButton(strip, '◀', 'prev')
    const nextBtn = this.softButton(strip, '▶', 'next')
    const minusBtn = this.softButton(strip, '−', 'minus')
    const plusBtn = this.softButton(strip, '+', 'plus')
    // Web-native settings drawer entry point (see src/ui/settings.ts).
    if (opts.onSettings) {
      const s = opts.onSettings
      const b = this.softButton(strip, '⚙', 'settings')
      b.title = 'Settings editor'
      this.onClick(b, s)
    }

    this.el.append(screenWrap, strip)

    /* getContext can return null under happy-dom: keep logic working. */
    let ctx: CanvasRenderingContext2D | null = null
    try {
      ctx = this.canvas.getContext('2d')
    } catch {
      ctx = null
    }
    this.ctx = ctx

    /* ---- soft-button behavior -------------------------------------- */
    this.onClick(this.menuBtn, () => this.toggleMenu())
    this.onClick(prevBtn, () => this.nav(-1))
    this.onClick(nextBtn, () => this.nav(1))
    bindHold(minusBtn, () => this.adjust(-1))
    bindHold(plusBtn, () => this.adjust(1))

    /* ---- store subscriptions (module lives for the page lifetime) -- */
    const store = this.store
    store.onParam((id, _v, source) => this.onParamEvent(id, source))
    store.onProgram(() => {
      this.clampPages()
      this.scheduleRender()
    })
    store.onSeq(() => this.scheduleRender())
    store.onPlayhead(() => {
      if (this.screen !== 'menu') this.scheduleRender()
    })
    store.onRecChange(() => this.onRecEvent())

    this.scheduleRender()
  }

  /* ---------------------------------------------------------------- */
  /* public API                                                        */
  /* ---------------------------------------------------------------- */

  /** Latest post-FX mono frame from the engine (~256 samples, ~20fps). */
  scopeFrame(data: Float32Array): void {
    this.scope = data
    // The param overlay renders on top of the home screen, scope included —
    // keep repainting for every frame unless the menu is open.
    if (this.screen !== 'menu') this.scheduleRender()
  }

  /** Small MIDI-activity dot on the status line; auto-clears (~150ms). */
  setMidiActive(on: boolean): void {
    if (this.midiT) {
      clearTimeout(this.midiT)
      this.midiT = null
    }
    this.midiOn = on === true
    if (this.midiOn) {
      this.midiT = setTimeout(() => {
        this.midiT = null
        this.midiOn = false
        this.scheduleRender()
      }, MIDI_FLASH_MS)
    }
    this.scheduleRender()
  }

  /** Minimal internal state, exposed for tests only. */
  get debugState(): { screen: 'home' | 'overlay' | 'menu'; page: number } {
    return { screen: this.screen, page: this.page }
  }

  /* ---------------------------------------------------------------- */
  /* DOM helpers                                                       */
  /* ---------------------------------------------------------------- */

  private softButton(parent: HTMLElement, label: string, role: string): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'xd-oled-softbtn xd-oled-softbtn--' + role
    b.textContent = label
    b.setAttribute('aria-label', role)
    parent.appendChild(b)
    return b
  }

  /** Click handler that also works from tests (element.click()). */
  private onClick(btn: HTMLButtonElement, fn: () => void): void {
    btn.addEventListener('click', fn)
  }

  /* ---------------------------------------------------------------- */
  /* menu paging model                                                 */
  /* ---------------------------------------------------------------- */

  private get totalPages(): number {
    return this.menuParams.length + this.seqFields.length + this.motionLanes
  }

  private clampPages(): void {
    const t = this.totalPages
    if (this.page < 0) this.page = 0
    if (this.page >= t) this.page = t - 1
    if (this.motionField < 0) this.motionField = 0
    if (this.motionField >= MOTION_FIELDS.length) this.motionField = MOTION_FIELDS.length - 1
  }

  private pageAt(n: number): Page {
    const pc = this.menuParams.length
    if (n < pc) return { kind: 'prog', i: n, meta: this.menuParams[n] }
    const sf = this.seqFields
    if (n < pc + sf.length) {
      const i = n - pc
      return { kind: 'seq', i, def: sf[i] }
    }
    // Unreachable with motionLanes = 0: clampPages keeps n < totalPages.
    const lane = Math.min(NUM_MOTION_LANES - 1, n - pc - sf.length)
    return { kind: 'motion', i: n - pc, lane }
  }

  private toggleMenu(): void {
    if (this.screen === 'menu') {
      this.exitMenu()
    } else {
      if (this.overlayT) {
        clearTimeout(this.overlayT)
        this.overlayT = null
      }
      this.screen = 'menu'
      this.clampPages()
      this.menuBtn.classList.add('is-active')
      this.touchIdle()
    }
    this.scheduleRender()
  }

  private exitMenu(): void {
    this.screen = 'home'
    this.menuBtn.classList.remove('is-active')
    if (this.idleT) {
      clearTimeout(this.idleT)
      this.idleT = null
    }
  }

  /** Long-idle (8s) inside the menu falls back to HOME. */
  private touchIdle(): void {
    if (this.idleT) clearTimeout(this.idleT)
    this.idleT = setTimeout(() => {
      this.idleT = null
      if (this.screen === 'menu') {
        this.exitMenu()
        this.scheduleRender()
      }
    }, MENU_IDLE_MS)
  }

  /** ◀ ▶: page traversal; inside a motion page, cycles sub-fields first. */
  private nav(dir: 1 | -1): void {
    if (this.screen !== 'menu') return
    this.touchIdle()
    this.clampPages()
    const p = this.pageAt(this.page)
    if (p.kind === 'motion') {
      const nf = this.motionField + dir
      if (nf >= 0 && nf < MOTION_FIELDS.length) {
        this.motionField = nf
        this.scheduleRender()
        return
      }
    }
    const t = this.totalPages
    this.page = (this.page + dir + t) % t
    // Entering a motion page while stepping backwards lands on its last
    // sub-field so ◀ walks sub-fields in reverse; otherwise start at ASSIGN.
    const np = this.pageAt(this.page)
    this.motionField = dir < 0 && np.kind === 'motion' ? MOTION_FIELDS.length - 1 : 0
    this.scheduleRender()
  }

  /** [−]/[+]: edit the current menu page value. */
  private adjust(dir: 1 | -1): void {
    if (this.screen !== 'menu') return
    this.touchIdle()
    this.clampPages()
    const p = this.pageAt(this.page)
    const store = this.store
    if (p.kind === 'prog') {
      // 'menu' (not 'ui'): the panel must resync statically bound controls
      // (PORTAMENTO knob, OCTAVE lever) that also expose these params.
      store.setParam(p.meta.id, store.getParam(p.meta.id) + dir, 'menu')
    } else if (p.kind === 'seq') {
      const cur = p.def.get(store.program.seq)
      store.setSeqField(p.def.field, cur + dir * p.def.step)
      // Spec §11: GATE TIME is motion-recordable — editing DEFAULT GATE
      // during realtime rec also writes the gate-time motion lane.
      if (p.def.field === 'defaultGate' && store.recMode === 'realtime' && store.playing) {
        store.recKnob(MOTION_GATE_TIME, store.program.seq.defaultGate)
      }
    } else {
      this.adjustMotion(p.lane, dir)
    }
    this.scheduleRender()
  }

  private adjustMotion(lane: number, dir: 1 | -1): void {
    const l = this.store.program.seq.motion[lane]
    if (!l) return
    switch (this.motionField) {
      case 0: {
        // ASSIGN: cycle through [-1 (unassigned), ...def.motionParamIds]
        const cycle = [-1, ...this.def.motionParamIds]
        let idx = cycle.indexOf(l.paramId)
        if (idx < 0) idx = 0
        const next = cycle[(idx + dir + cycle.length) % cycle.length]
        this.store.setMotionLane(lane, { paramId: next })
        break
      }
      case 1:
        this.store.setMotionLane(lane, { on: !l.on })
        break
      case 2:
        this.store.setMotionLane(lane, { smooth: !l.smooth })
        break
      case 3:
        if (dir > 0) this.store.clearMotionLane(lane)
        break
    }
  }

  /* ---------------------------------------------------------------- */
  /* store events                                                      */
  /* ---------------------------------------------------------------- */

  private onParamEvent(id: number, source: ParamSource): void {
    if (source !== 'ui' && source !== 'midi') {
      this.scheduleRender()
      return
    }
    if (this.screen === 'menu') {
      // Menu shows values in place; no overlay while it is open.
      this.scheduleRender()
      return
    }
    // Param overlay; rapid moves of the same (or another) param coalesce by
    // resetting the expiry timer — the value itself is read live at render.
    this.overlayId = id
    this.screen = 'overlay'
    if (this.overlayT) clearTimeout(this.overlayT)
    this.overlayT = setTimeout(() => {
      this.overlayT = null
      if (this.screen === 'overlay') this.screen = 'home'
      this.scheduleRender()
    }, OVERLAY_MS)
    this.scheduleRender()
  }

  private onRecEvent(): void {
    const stepRec = this.store.recMode === 'step'
    if (stepRec && !this.blinkIv) {
      this.blinkOn = true
      this.blinkIv = setInterval(() => {
        this.blinkOn = !this.blinkOn
        this.scheduleRender()
      }, BLINK_MS)
    } else if (!stepRec && this.blinkIv) {
      clearInterval(this.blinkIv)
      this.blinkIv = null
      this.blinkOn = true
    }
    this.scheduleRender()
  }

  /* ---------------------------------------------------------------- */
  /* rendering                                                         */
  /* ---------------------------------------------------------------- */

  private scheduleRender(): void {
    this.dirty = true
    if (this.rafPending) return
    this.rafPending = true
    const cb = (): void => {
      this.rafPending = false
      if (!this.dirty) return
      this.dirty = false
      this.render()
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cb)
    else setTimeout(cb, 16)
  }

  private colors(): { fg: string; bg: string } {
    if (!this.fg) {
      let fg = ''
      let bg = ''
      try {
        const cs = getComputedStyle(this.el)
        fg = cs.getPropertyValue('--xd-oled-fg').trim()
        bg = cs.getPropertyValue('--xd-oled').trim()
      } catch {
        /* detached / non-DOM: use fallbacks */
      }
      this.fg = fg || '#e8f4e8'
      this.bg = bg || '#0a0c0a'
    }
    return { fg: this.fg, bg: this.bg }
  }

  private render(): void {
    const ctx = this.ctx
    if (!ctx) return
    const { fg, bg } = this.colors()
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H)
    ctx.globalAlpha = 1
    ctx.shadowBlur = 0
    if (this.screen === 'menu') {
      this.renderMenu(ctx, fg, bg)
    } else {
      // 'overlay' renders as HOME with a param readout in the header, so the
      // oscilloscope stays visible while a value is being adjusted (as on
      // the hardware).
      this.renderHome(ctx, fg)
    }
  }

  /** Integer-snapped monospace text (pixel-font look, no external fonts). */
  private text(
    ctx: CanvasRenderingContext2D,
    s: string,
    x: number,
    y: number,
    size: number,
    opts?: { align?: CanvasTextAlign; alpha?: number; bold?: boolean; color?: string },
  ): void {
    ctx.font = `${opts?.bold === false ? 500 : 700} ${Math.round(size)}px ${MONO}`
    ctx.textAlign = opts?.align ?? 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.globalAlpha = opts?.alpha ?? 1
    if (opts?.color) ctx.fillStyle = opts.color
    ctx.fillText(s, Math.round(x), Math.round(y))
    ctx.globalAlpha = 1
  }

  /* ------------------------------- HOME ---------------------------- */

  private renderHome(ctx: CanvasRenderingContext2D, fg: string): void {
    const store = this.store
    ctx.fillStyle = fg

    /* header: program slot + name, or the param readout while adjusting */
    const overlayMeta = this.screen === 'overlay' ? this.def.params[this.overlayId] : undefined
    if (overlayMeta) {
      const v = store.getParam(overlayMeta.id)
      this.text(ctx, overlayMeta.label, 10, 25, 11, { alpha: 0.85 })
      this.text(ctx, this.def.formatParam(overlayMeta.id, v), SCREEN_W - 10, 26, 15, {
        align: 'right',
      })
      if (overlayMeta.kind === 'knob') {
        const span = overlayMeta.max - overlayMeta.min || 1
        const t = Math.max(0, Math.min(1, (v - overlayMeta.min) / span))
        ctx.globalAlpha = 0.25
        ctx.fillRect(8, 30, SCREEN_W - 16, 2)
        ctx.globalAlpha = 1
        ctx.fillStyle = fg
        ctx.fillRect(8, 30, Math.round((SCREEN_W - 16) * t), 2)
      }
    } else {
      const slotStr = String(store.slot + 1).padStart(3, '0')
      this.text(ctx, slotStr, 10, 26, 22)
      this.text(ctx, store.program.name.toUpperCase(), 62, 25, 15)
    }
    ctx.globalAlpha = 0.3
    ctx.fillRect(8, 33, SCREEN_W - 16, 1)
    ctx.globalAlpha = 1

    /* oscilloscope */
    this.drawScope(ctx, 8, 38, SCREEN_W - 16, 52, fg)

    /* status line */
    const y = 106
    ctx.globalAlpha = 0.3
    ctx.fillRect(8, 94, SCREEN_W - 16, 1)
    ctx.globalAlpha = 1
    const bpm = store.program.seq.bpm
    this.text(ctx, 'BPM ' + bpm.toFixed(1), 10, y, 10)
    const vmDef = this.def.voiceMode
    if (vmDef) {
      const vm = store.getParam(vmDef.id)
      const short = vmDef.labels[vm] ?? vmDef.labels[vmDef.labels.length - 1] ?? ''
      this.text(ctx, short, 96, y, 10, { alpha: 0.85 })
    }

    let x = 140
    if (store.playing) {
      this.text(ctx, '▶PLAY', x, y, 10)
      x += 46
    }
    // 'arp' transport: no sequencer, so no REC affordances on the display.
    if (this.def.transport !== 'arp') {
      const rec = store.recMode
      if (rec === 'realtime') {
        this.text(ctx, '●REC', x, y, 10)
      } else if (rec === 'step' && this.blinkOn) {
        const cur = store.stepRecCursor
        this.text(ctx, '●REC' + (cur >= 0 ? ' S' + (cur + 1) : ''), x, y, 10)
      }
    }

    /* MIDI dot, right end of the status line */
    if (this.midiOn) {
      ctx.beginPath()
      ctx.arc(306, y - 4, 3, 0, Math.PI * 2)
      ctx.fill()
      this.text(ctx, 'MIDI', 312, y, 7, { alpha: 0.8 })
    }
  }

  /** Line-only scope, center-triggered on a rising zero crossing. */
  private drawScope(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    fg: string,
  ): void {
    const mid = y + h / 2

    ctx.strokeStyle = fg
    ctx.globalAlpha = 0.18
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, Math.round(mid) + 0.5)
    ctx.lineTo(x + w, Math.round(mid) + 0.5)
    ctx.stroke()
    ctx.globalAlpha = 1

    const data = this.scope
    const half = h / 2 - 2
    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    ctx.shadowColor = fg
    ctx.shadowBlur = 4
    ctx.beginPath()
    if (!data || data.length < 16) {
      ctx.moveTo(x, mid)
      ctx.lineTo(x + w, mid)
    } else {
      const n = data.length
      const win = Math.max(16, n >> 1)
      // find a rising zero crossing that can sit at the window center
      const lo = win >> 1
      const hi = n - (win - (win >> 1))
      let trig = -1
      for (let i = Math.max(1, lo); i < hi; i++) {
        if (data[i - 1] <= 0 && data[i] > 0) {
          trig = i
          break
        }
      }
      const start = trig >= 0 ? trig - (win >> 1) : (n - win) >> 1
      for (let px = 0; px <= w; px++) {
        const f = start + (px / w) * (win - 1)
        const i0 = Math.floor(f)
        const t = f - i0
        const a = data[i0] ?? 0
        const b = data[i0 + 1] ?? a
        let v = a + (b - a) * t
        if (v > 1) v = 1
        else if (v < -1) v = -1
        const yy = mid - v * half
        if (px === 0) ctx.moveTo(x, yy)
        else ctx.lineTo(x + px, yy)
      }
    }
    ctx.stroke()
    ctx.shadowBlur = 0
  }

  /* ---------------------------- OVERLAY ----------------------------- */

  /* ------------------------------ MENU ------------------------------ */

  private renderMenu(ctx: CanvasRenderingContext2D, fg: string, bg: string): void {
    this.clampPages()
    const p = this.pageAt(this.page)
    const pc = this.menuParams.length
    const seqTotal = this.seqFields.length + this.motionLanes
    const arpOnly = this.def.transport === 'arp'

    /* inverse header strip */
    let header: string
    if (p.kind === 'prog') header = `PROG EDIT  ${p.i + 1}/${pc}`
    else if (p.kind === 'seq') header = arpOnly ? 'TEMPO' : `SEQ EDIT  ${p.i + 1}/${seqTotal}`
    else header = `SEQ EDIT  ${p.i + 1}/${seqTotal}  MOTION ${p.lane + 1}`
    ctx.fillStyle = fg
    ctx.fillRect(0, 0, SCREEN_W, 16)
    this.text(ctx, header, 8, 12, 10, { color: bg })
    ctx.fillStyle = fg

    if (p.kind === 'prog') {
      const v = this.store.getParam(p.meta.id)
      this.text(ctx, p.meta.label, SCREEN_W / 2, 46, 13, { align: 'center', alpha: 0.85 })
      this.text(ctx, this.def.formatParam(p.meta.id, v), SCREEN_W / 2, 84, 26, { align: 'center' })
    } else if (p.kind === 'seq') {
      const value = p.def.fmt(p.def.get(this.store.program.seq))
      this.text(ctx, p.def.label, SCREEN_W / 2, 46, 13, { align: 'center', alpha: 0.85 })
      this.text(ctx, value, SCREEN_W / 2, 84, 26, { align: 'center' })
    } else {
      this.renderMotionPage(ctx, fg, bg, p.lane)
    }

    this.text(ctx, '◀ ▶ PAGE   −/+ EDIT', SCREEN_W - 8, SCREEN_H - 4, 8, {
      align: 'right',
      alpha: 0.45,
    })
  }

  private renderMotionPage(
    ctx: CanvasRenderingContext2D,
    fg: string,
    bg: string,
    lane: number,
  ): void {
    const l = this.store.program.seq.motion[lane]
    if (!l) return
    const values = [
      l.paramId === -1 ? '---' : this.def.motionParamLabel(l.paramId),
      l.on ? 'ON' : 'OFF',
      l.smooth ? 'ON' : 'OFF',
      '[+] EXEC',
    ]
    const rowH = 20
    for (let i = 0; i < MOTION_FIELDS.length; i++) {
      const top = 22 + i * rowH
      const selected = i === this.motionField
      if (selected) {
        ctx.fillStyle = fg
        ctx.fillRect(6, top, SCREEN_W - 12, rowH - 2)
      }
      const color = selected ? bg : fg
      ctx.fillStyle = color
      this.text(ctx, MOTION_FIELDS[i], 14, top + 14, 11, { color, alpha: selected ? 1 : 0.75 })
      this.text(ctx, values[i], SCREEN_W - 14, top + 14, 11, { color, align: 'right' })
      ctx.fillStyle = fg
    }
  }
}
