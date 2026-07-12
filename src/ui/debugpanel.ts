/*
 * SERVICE MODE — diagnostic drawer (v1).
 *
 * Renders the engine's debug telemetry: the signal path as a mini block
 * diagram with live scopes at every tap, per-voice activity lanes with
 * drift meters, and an audio-thread health strip. Telemetry only streams
 * while the drawer is open (the app sends {t:'debug', on} on toggle), so it
 * costs nothing when closed.
 *
 * Everything synth-specific — tap labels/positions, the block-diagram wires,
 * the routing badges and the store params/curves that drive them, and the
 * modulator lane labels — comes from an injected DebugDef (see
 * src/synths/<id>/debug-def.ts), mirroring the display's DisplayDef pattern.
 */
import type { FromEngine } from '../shared/messages'
import type { Store } from '../state/store'
import { fftMag } from '../dsp/fft'
import { ScopeLock } from './scopetrigger'

type DbgMsg = Extract<FromEngine, { t: 'dbg' }>

/**
 * One scope cell: tap label, the telemetry tap indices that feed it (r set =
 * stereo overlay), and its absolute position in the 796x306 diagram.
 */
export interface DebugStage {
  label: string
  l: number
  r?: number
  x: number
  y: number
}

/**
 * One diagram wire (SVG path data in the 796x306 viewBox). Plain entries are
 * the static audio path; `on` makes visibility follow the store (routing
 * toggles), and `amt` additionally drives opacity with a >0.02 display
 * cutoff (mod-intensity wires). Array order is the DOM order.
 */
export interface DebugWire {
  d: string
  /** Extra class beside the base 'xd-w' (e.g. 'xd-w-eg' / 'xd-w-lfo'). */
  cls?: string
  on?(store: Store): boolean
  amt?(store: Store): number // 0..1
}

/** Small toggle badge (SYNC / RING / X-MOD style): lit while on(store). */
export interface DebugToggleBadge {
  x: number
  y: number
  label: string
  on(store: Store): boolean
}

/**
 * Modulation-source badge ('EG → …' readouts): text follows the store,
 * dimmed while amt(store) <= 0.02. Hidden entirely without a store.
 */
export interface DebugModBadge {
  x: number
  y: number
  /** Color class, e.g. 'xd-svc-badge--eg'. */
  cls: string
  /** Static fallback text (store-less construction). */
  label: string
  text(store: Store): string
  amt(store: Store): number
}

/**
 * Modulator sparkline lane. The source order is fixed — lane 0 draws
 * DbgVoice.amp, lane 1 .modEg, lane 2 .lfo — the def only names/colors them.
 */
export interface DebugModSig {
  label: string
  color: string
  bipolar: boolean
}

/**
 * Synth-specific SERVICE MODE surface, injected by the synth app (see
 * src/synths/<id>/debug-def.ts). Everything else the drawer renders — voice
 * lanes, drift meters, sparkline mechanics, health strip — is synth-agnostic.
 */
export interface DebugDef {
  /** Engine polyphony: drives the voice lanes, overlay scopes, sparkline
   *  histories and the health strip (1 hides the 1V/all-V toggle). */
  numVoices: number
  /** Scope cells, telemetry-tap order (see shared/messages.ts dbg frame). */
  stages: readonly DebugStage[]
  /** Block-diagram wires; see DebugWire for static vs store-driven entries. */
  wires: readonly DebugWire[]
  /** Oscillator-relationship badges (SYNC/RING/X-MOD column). */
  toggleBadges: readonly DebugToggleBadge[]
  /** Voice-sum marker on the VCA -> FX wire. */
  sumBadge: { x: number; y: number; label: string; title: string }
  /** Modulation routing readouts (EG →/LFO → badges). */
  modBadges: readonly DebugModBadge[]
  /** Compact strip: stage indices shown + the separator glyphs between them. */
  compact: { indices: readonly number[]; arrows: readonly string[] }
  /** Sparkline lanes, fixed source order: DbgVoice.amp, .modEg, .lfo. */
  modSigs: readonly [DebugModSig, DebugModSig, DebugModSig]
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const R_COLOR = '#8fb8e0'
/** Per-voice trace colors (multi-channel-scope mode), cycled over numVoices
 *  (a 16-voice def — the prologue-16 — repeats the palette: V9 shares V1's
 *  color, disambiguated by the legend digits); V1 matches the mono green. */
const VOICE_COLORS = [
  '#8fe0a0', '#8fb8e0', '#e0c98f', '#e08fa0',
  '#b39fe0', '#8fdfe0', '#c8e08f', '#e0a08f',
] as const
/** Silent-trace cutoff: skip drawing voices with no signal to reduce clutter. */
const SILENT_PEAK = 0.001
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const HISTORY = 128 // sparkline points (~4s at 30fps telemetry)

function hexToRgba(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${a})`
}

/**
 * Fixed canvas-space glow gradient: transparent at the signal's zero line,
 * strongest at the extremes — so louder signals reach into brighter zones.
 * 'mirror' = bipolar (zero at h/2), 'up' = unipolar (zero at the bottom).
 */
function glowGradient(
  ctx: CanvasRenderingContext2D,
  h: number,
  color: string,
  mode: 'mirror' | 'up',
  peakAlpha: number,
): CanvasGradient {
  const g = ctx.createLinearGradient(0, 0, 0, h)
  if (mode === 'mirror') {
    // Peak brightness is reached at ~80% amplitude, not only at the edges,
    // so ordinary waveforms already glow visibly.
    g.addColorStop(0, hexToRgba(color, peakAlpha))
    g.addColorStop(0.1, hexToRgba(color, peakAlpha))
    g.addColorStop(0.5, hexToRgba(color, 0))
    g.addColorStop(0.9, hexToRgba(color, peakAlpha))
    g.addColorStop(1, hexToRgba(color, peakAlpha))
  } else {
    g.addColorStop(0, hexToRgba(color, peakAlpha))
    g.addColorStop(1, hexToRgba(color, 0))
  }
  return g
}

function noteName(n: number): string {
  if (!Number.isFinite(n)) return '--'
  const nn = Math.round(n)
  return NOTE_NAMES[((nn % 12) + 12) % 12] + String(Math.floor(nn / 12) - 1)
}

function fmtHzCents(hz: number, note: number): string {
  if (!(hz > 0)) return '--'
  const eq = 440 * Math.pow(2, (note - 69) / 12)
  const cents = 1200 * Math.log2(hz / eq)
  const hzStr = hz >= 1000 ? (hz / 1000).toFixed(2) + 'k' : hz.toFixed(1)
  return hzStr + 'Hz ' + (cents >= 0 ? '+' : '') + cents.toFixed(0) + '¢'
}

interface Lane {
  led: HTMLElement
  note: HTMLElement
  freq: HTMLElement
  ampFill: HTMLElement
  driftNeedle1: HTMLElement
  driftNeedle2: HTMLElement
  driftText: HTMLElement
  row: HTMLElement
}

export class DebugPanel {
  el: HTMLElement
  onClose?: () => void
  /** Set by the app once the AudioContext exists (spectrum frequency axis). */
  sampleRate = 48000

  private readonly def: DebugDef
  private readonly nv: number
  private readonly voiceColors: readonly string[]
  private readonly canvases: HTMLCanvasElement[] = []
  private readonly ctxs: (CanvasRenderingContext2D | null)[] = []
  private readonly fftOn: boolean[]
  private readonly store?: Store
  private readonly routedWires: Array<{
    el: SVGPathElement
    on(store: Store): boolean
    amt?(store: Store): number
  }> = []
  private readonly toggleBadgeEls: Array<{ el: HTMLElement; on(store: Store): boolean }> = []
  private readonly modBadgeEls: Array<{
    el: HTMLElement
    text(store: Store): string
    amt(store: Store): number
  }> = []

  /** All-voices overlay mode; the app re-arms telemetry when this changes. */
  onVoicesMode?: (all: boolean) => void

  /* two flow views sharing the same scope cells */
  private voicesMode: 'tap' | 'all' = 'tap'
  private voiceBtns!: { tap: HTMLButtonElement; all: HTMLButtonElement }
  private view: 'diagram' | 'compact' = 'diagram'
  private diagramEl!: HTMLElement
  private compactEl!: HTMLElement
  private compactSlots: HTMLElement[] = []
  private viewBtns!: { diagram: HTMLButtonElement; compact: HTMLButtonElement }
  private readonly tapCells: HTMLElement[] = []
  private readonly modCanvases: HTMLCanvasElement[] = []
  private readonly modCtxs: (CanvasRenderingContext2D | null)[] = []
  /** Per-voice modulator histories [voice][signal] — every voice records
   *  continuously so switching the tap shows THAT voice's real past. */
  private readonly modHist: Float32Array[][]
  private histW = 0
  private histFill = 0
  private shownVoice = 0
  private modLabelsAll = false
  /** Latest per-voice gate state; dims inactive voices' legend digits. */
  private readonly voiceOn: boolean[]
  private readonly modLabels: HTMLElement[] = []
  private readonly lanes: Lane[] = []
  private loadFill!: HTMLElement
  private loadText!: HTMLElement
  private voicesText!: HTMLElement
  private fg = '#8fe0a0'

  constructor(opts: { store?: Store; def: DebugDef }) {
    this.store = opts.store
    this.def = opts.def
    const def = this.def
    this.nv = Math.max(1, Math.round(def.numVoices))
    this.voiceColors = Array.from({ length: this.nv }, (_, i) => VOICE_COLORS[i % VOICE_COLORS.length])
    this.modHist = Array.from({ length: this.nv }, () => [
      new Float32Array(HISTORY),
      new Float32Array(HISTORY),
      new Float32Array(HISTORY),
    ])
    this.voiceOn = Array.from({ length: this.nv }, () => false)
    this.fftOn = def.stages.map(() => false)
    this.el = document.createElement('div')
    this.el.className = 'xd-svc'
    this.el.innerHTML = ''

    const head = document.createElement('div')
    head.className = 'xd-svc-head'
    const title = document.createElement('span')
    title.className = 'xd-svc-title'
    title.textContent = 'SERVICE MODE'
    const seg = document.createElement('div')
    seg.className = 'xd-svc-seg'
    const mkView = (v: 'compact' | 'diagram', label: string): HTMLButtonElement => {
      const b = document.createElement('button')
      b.className = 'xd-svc-seg-btn'
      b.textContent = label
      b.addEventListener('click', () => this.setView(v))
      seg.appendChild(b)
      return b
    }
    this.viewBtns = { compact: mkView('compact', 'COMPACT'), diagram: mkView('diagram', 'DIAGRAM') }
    const vseg = document.createElement('div')
    vseg.className = 'xd-svc-seg'
    vseg.title = `voice scopes: tapped voice only, or all ${this.nv} overlaid`
    const mkVoices = (m: 'tap' | 'all', label: string): HTMLButtonElement => {
      const b = document.createElement('button')
      b.className = 'xd-svc-seg-btn'
      b.textContent = label
      b.addEventListener('click', () => this.setVoicesMode(m))
      vseg.appendChild(b)
      return b
    }
    this.voiceBtns = { tap: mkVoices('tap', '1V'), all: mkVoices('all', this.nv + 'V') }
    // Single-voice defs have nothing to overlay: no 1V/NV mode toggle at all.
    if (this.nv === 1) vseg.style.display = 'none'
    const close = document.createElement('button')
    close.className = 'xd-svc-close'
    close.textContent = '✕'
    close.setAttribute('aria-label', 'close service mode')
    close.addEventListener('click', () => this.onClose?.())
    const right = document.createElement('div')
    right.className = 'xd-svc-head-right'
    right.append(vseg, seg, close)
    head.append(title, right)
    this.makeDraggable(head)
    try {
      if (this.nv > 1 && localStorage.getItem('xd-svc-voices') === 'all') this.voicesMode = 'all'
    } catch {
      /* no storage */
    }
    this.voiceBtns.tap.classList.toggle('is-active', this.voicesMode === 'tap')
    this.voiceBtns.all.classList.toggle('is-active', this.voicesMode === 'all')

    /* --- signal-flow block diagram -------------------------------------
     * Wires are SVG paths over fixed cell positions; the def declares the
     * audio path plus store-driven routing wires and badges. */
    const diagram = document.createElement('div')
    diagram.className = 'xd-svc-diagram'
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 796 306')
    svg.setAttribute('class', 'xd-svc-wires')
    diagram.appendChild(svg)
    for (const w of def.wires) {
      const p = document.createElementNS(SVG_NS, 'path')
      p.setAttribute('d', w.d)
      p.setAttribute('class', 'xd-w' + (w.cls ? ' ' + w.cls : ''))
      svg.appendChild(p)
      if (w.on) this.routedWires.push({ el: p, on: w.on, amt: w.amt })
    }

    for (let i = 0; i < def.stages.length; i++) {
      const stage = def.stages[i]
      const cell = document.createElement('div')
      cell.className = 'xd-svc-tap xd-svc-cell'
      cell.style.left = stage.x + 'px'
      cell.style.top = stage.y + 'px'
      const cv = document.createElement('canvas')
      cv.className = 'xd-svc-scope'
      cv.width = 170 * (window.devicePixelRatio || 1)
      cv.height = 46 * (window.devicePixelRatio || 1)
      const label = document.createElement('div')
      label.className = 'xd-svc-label'
      label.textContent = stage.label
      cell.append(cv, label)
      cell.title = 'click: waveform / spectrum'
      const idx = i
      cv.addEventListener('click', () => {
        this.fftOn[idx] = !this.fftOn[idx]
        cell.classList.toggle('is-fft', this.fftOn[idx])
        label.textContent = stage.label + (this.fftOn[idx] ? ' · FFT' : '')
      })
      this.tapCells.push(cell)
      diagram.appendChild(cell)
      let ctx: CanvasRenderingContext2D | null = null
      try {
        ctx = cv.getContext('2d')
      } catch {
        ctx = null
      }
      this.canvases.push(cv)
      this.ctxs.push(ctx)
    }

    // Oscillator-relationship badges + mod-routing badges (def-declared).
    for (const b of def.toggleBadges) {
      const el = this.badge(diagram, b.x, b.y, b.label, 'xd-svc-mini')
      this.toggleBadgeEls.push({ el, on: b.on })
    }
    // Voice-sum marker, centered on its wire.
    const sum = this.badge(diagram, def.sumBadge.x, def.sumBadge.y, def.sumBadge.label, 'xd-svc-mini')
    sum.style.transform = 'translate(-50%, -50%)'
    sum.title = def.sumBadge.title
    for (const b of def.modBadges) {
      const el = this.badge(diagram, b.x, b.y, b.label, 'xd-svc-badge ' + b.cls)
      this.modBadgeEls.push({ el, text: b.text, amt: b.amt })
    }

    if (this.store) {
      this.store.onParam(() => this.refreshRouting())
      this.store.onProgram(() => this.refreshRouting())
      this.refreshRouting()
    } else {
      for (const b of this.modBadgeEls) b.el.style.display = 'none'
    }
    this.diagramEl = diagram

    /* --- compact view (the original linear flow) ------------------ */
    const compact = document.createElement('div')
    compact.className = 'xd-svc-compact'
    for (let k = 0; k < def.compact.indices.length; k++) {
      const slot = document.createElement('div')
      slot.className = 'xd-svc-slot'
      compact.appendChild(slot)
      this.compactSlots.push(slot)
      if (k < def.compact.arrows.length) {
        const arrow = document.createElement('div')
        arrow.className = 'xd-svc-arrow'
        arrow.textContent = def.compact.arrows[k]
        compact.appendChild(arrow)
      }
    }
    this.compactEl = compact

    let savedView: string | null = null
    try {
      savedView = localStorage.getItem('xd-svc-view')
    } catch {
      /* no storage: keep default */
    }
    this.setView(savedView === 'compact' || savedView === 'strip' ? 'compact' : 'diagram', true)

    /* --- MOD row: tapped voice's modulator sparklines ------------------- */
    const modRow = document.createElement('div')
    modRow.className = 'xd-svc-mods'
    for (let i = 0; i < def.modSigs.length; i++) {
      const cell = document.createElement('div')
      cell.className = 'xd-svc-mod'
      const cv = document.createElement('canvas')
      cv.className = 'xd-svc-mod-cv'
      cv.width = 236 * (window.devicePixelRatio || 1)
      cv.height = 34 * (window.devicePixelRatio || 1)
      const label = document.createElement('div')
      label.className = 'xd-svc-label'
      label.textContent = def.modSigs[i].label + ' · V1'
      this.modLabels.push(label)
      cell.append(cv, label)
      modRow.appendChild(cell)
      let ctx: CanvasRenderingContext2D | null = null
      try {
        ctx = cv.getContext('2d')
      } catch {
        ctx = null
      }
      this.modCanvases.push(cv)
      this.modCtxs.push(ctx)
    }

    /* --- voice lanes ---------------------------------------------------- */
    const lanes = document.createElement('div')
    // >8 voices: two lane columns so the drawer height stays reasonable.
    lanes.className = 'xd-svc-lanes' + (this.nv > 8 ? ' xd-svc-lanes--2col' : '')
    for (let i = 0; i < this.nv; i++) {
      const row = document.createElement('div')
      row.className = 'xd-svc-lane'
      const led = document.createElement('span')
      led.className = 'xd-svc-led'
      const name = document.createElement('span')
      name.className = 'xd-svc-vname'
      name.textContent = 'V' + (i + 1)
      name.style.color = this.voiceColors[i] // matches the overlay trace colors
      const note = document.createElement('span')
      note.className = 'xd-svc-note'
      note.textContent = '--'
      const freq = document.createElement('span')
      freq.className = 'xd-svc-freq'
      freq.textContent = '--'
      const amp = document.createElement('div')
      amp.className = 'xd-svc-amp'
      const ampFill = document.createElement('div')
      ampFill.className = 'xd-svc-amp-fill'
      amp.appendChild(ampFill)
      const drift = document.createElement('div')
      drift.className = 'xd-svc-drift'
      const driftNeedle1 = document.createElement('div')
      driftNeedle1.className = 'xd-svc-drift-needle'
      const driftNeedle2 = document.createElement('div')
      driftNeedle2.className = 'xd-svc-drift-needle xd-svc-drift-needle--v2'
      drift.append(driftNeedle1, driftNeedle2)
      const driftText = document.createElement('span')
      driftText.className = 'xd-svc-drift-text'
      driftText.textContent = '+0.0 +0.0¢'
      row.append(led, name, note, freq, amp, drift, driftText)
      lanes.appendChild(row)
      this.lanes.push({ led, note, freq, ampFill, driftNeedle1, driftNeedle2, driftText, row })
    }

    /* --- health strip ---------------------------------------------------- */
    const health = document.createElement('div')
    health.className = 'xd-svc-health'
    const loadLabel = document.createElement('span')
    loadLabel.className = 'xd-svc-hlabel'
    loadLabel.textContent = 'DSP'
    const loadBar = document.createElement('div')
    loadBar.className = 'xd-svc-load'
    this.loadFill = document.createElement('div')
    this.loadFill.className = 'xd-svc-load-fill'
    loadBar.appendChild(this.loadFill)
    this.loadText = document.createElement('span')
    this.loadText.className = 'xd-svc-htext'
    this.loadText.textContent = '--%'
    this.voicesText = document.createElement('span')
    this.voicesText.className = 'xd-svc-htext'
    this.voicesText.textContent = 'VOICES 0/' + this.nv
    health.append(loadLabel, loadBar, this.loadText, this.voicesText)

    this.el.append(head, diagram, compact, modRow, lanes, health)
    this.applyView()
  }

  /** Switch the voice scopes between tapped-only and all-voices overlay. */
  setVoicesMode(m: 'tap' | 'all'): void {
    if (m === this.voicesMode) return
    this.voicesMode = m
    try {
      localStorage.setItem('xd-svc-voices', m)
    } catch {
      /* no storage */
    }
    this.voiceBtns.tap.classList.toggle('is-active', m === 'tap')
    this.voiceBtns.all.classList.toggle('is-active', m === 'all')
    this.onVoicesMode?.(m === 'all')
  }

  get voicesAll(): boolean {
    return this.voicesMode === 'all'
  }

  /** Switch between the block diagram and the compact view. */
  setView(v: 'diagram' | 'compact', silent = false): void {
    if (!silent && v === this.view) return
    this.view = v
    try {
      localStorage.setItem('xd-svc-view', v)
    } catch {
      /* no storage */
    }
    this.applyView()
  }

  get currentView(): 'diagram' | 'compact' {
    return this.view
  }

  private applyView(): void {
    const compact = this.view === 'compact'
    this.diagramEl.style.display = compact ? 'none' : ''
    this.compactEl.style.display = compact ? '' : 'none'
    this.viewBtns.compact.classList.toggle('is-active', compact)
    this.viewBtns.diagram.classList.toggle('is-active', !compact)
    const idx = this.def.compact.indices
    if (compact) {
      // Move the shared cells into the compact slots (the other taps stay
      // hidden in the diagram); clear absolute positioning.
      for (let k = 0; k < idx.length; k++) {
        const cell = this.tapCells[idx[k]]
        cell.classList.remove('xd-svc-cell')
        cell.style.left = ''
        cell.style.top = ''
        this.compactSlots[k].appendChild(cell)
      }
    } else {
      for (let i = 0; i < this.tapCells.length; i++) {
        const cell = this.tapCells[i]
        cell.classList.add('xd-svc-cell')
        cell.style.left = this.def.stages[i].x + 'px'
        cell.style.top = this.def.stages[i].y + 'px'
        this.diagramEl.appendChild(cell)
      }
    }
  }

  /**
   * Drag the drawer by its header. The drawer is CSS-anchored bottom-right;
   * the first drag switches it to explicit left/top positioning, clamped to
   * the viewport and persisted across sessions.
   */
  private makeDraggable(handle: HTMLElement): void {
    handle.classList.add('xd-svc-grab')
    try {
      const saved = localStorage.getItem('xd-svc-pos')
      if (saved) {
        const p = JSON.parse(saved)
        if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) this.moveTo(p.x, p.y)
      }
    } catch {
      /* no storage / corrupt: keep the default anchor */
    }
    let startX = 0
    let startY = 0
    let baseX = 0
    let baseY = 0
    let dragging = false
    handle.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.target instanceof HTMLButtonElement) return // seg/close buttons
      dragging = true
      startX = e.clientX
      startY = e.clientY
      const r = this.el.getBoundingClientRect()
      baseX = r.left
      baseY = r.top
      if (handle.setPointerCapture) handle.setPointerCapture(e.pointerId)
      e.preventDefault()
    })
    handle.addEventListener('pointermove', (e: PointerEvent) => {
      if (!dragging) return
      this.moveTo(baseX + e.clientX - startX, baseY + e.clientY - startY)
    })
    const end = (): void => {
      if (!dragging) return
      dragging = false
      try {
        const r = this.el.getBoundingClientRect()
        localStorage.setItem('xd-svc-pos', JSON.stringify({ x: r.left, y: r.top }))
      } catch {
        /* no storage */
      }
    }
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  private moveTo(x: number, y: number): void {
    const w = this.el.offsetWidth || 820
    const maxX = Math.max(0, (window.innerWidth || 1440) - Math.min(w, 200))
    const maxY = Math.max(0, (window.innerHeight || 900) - 40)
    const cx = Math.min(Math.max(x, -(w - 200)), maxX)
    const cy = Math.min(Math.max(y, 0), maxY)
    this.el.style.left = cx + 'px'
    this.el.style.top = cy + 'px'
    this.el.style.right = 'auto'
    this.el.style.bottom = 'auto'
  }

  private badge(parent: HTMLElement, x: number, y: number, text: string, cls: string): HTMLElement {
    const b = document.createElement('div')
    b.className = cls
    b.textContent = text
    b.style.left = x + 'px'
    b.style.top = y + 'px'
    parent.appendChild(b)
    return b
  }

  /** Re-derive mod wires + relationship badges from the current program. */
  private refreshRouting(): void {
    const s = this.store
    if (!s) return
    for (const w of this.routedWires) {
      const on = w.on(s)
      if (w.amt) {
        const amt = w.amt(s)
        w.el.style.display = on && amt > 0.02 ? '' : 'none'
        w.el.style.opacity = String(Math.min(1, 0.15 + amt * 0.85))
      } else {
        w.el.style.display = on ? '' : 'none'
      }
    }
    for (const b of this.toggleBadgeEls) b.el.classList.toggle('is-on', b.on(s))
    for (const b of this.modBadgeEls) {
      b.el.textContent = b.text(s)
      b.el.style.opacity = b.amt(s) > 0.02 ? '1' : '0.35'
    }
  }

  /** Apply one telemetry frame. */
  update(m: DbgMsg): void {
    for (let v = 0; v < this.voiceOn.length; v++) this.voiceOn[v] = m.voices[v]?.on === true

    const stages = this.def.stages
    const multi = this.voicesMode === 'all' && m.vtaps && m.vtaps.length >= this.nv * 6
    for (let i = 0; i < stages.length; i++) {
      const t = stages[i]
      if (multi && t.r === undefined) {
        // Voice-path cell: overlay every voice, multi-channel-scope style.
        const datas = Array.from({ length: this.nv }, (_, v) => m.vtaps![v * 6 + t.l])
        if (this.fftOn[i]) this.drawSpectrumVoices(i, datas)
        else this.drawScopeVoices(i, datas)
        continue
      }
      const dataL = m.taps[t.l]
      if (!dataL) continue
      const dataR = t.r !== undefined ? m.taps[t.r] : undefined
      if (this.fftOn[i]) this.drawSpectrum(i, dataL, dataR)
      else this.drawScope(i, dataL, dataR)
    }

    // MOD sparklines: every voice's modulators record continuously; the
    // canvases display the tapped voice's own history.
    const w = this.histW
    for (let vi = 0; vi < this.modHist.length && vi < m.voices.length; vi++) {
      const v = m.voices[vi]
      this.modHist[vi][0][w] = v.amp
      this.modHist[vi][1][w] = v.modEg
      this.modHist[vi][2][w] = v.lfo
    }
    this.histW = (w + 1) % HISTORY
    if (this.histFill < HISTORY) this.histFill++
    // In 4V mode the last-triggered mechanism is fully disabled: sparklines
    // show all voices and no lane is highlighted as "tapped".
    const allMode = this.voicesMode === 'all'
    const shown = Math.max(0, Math.min(this.modHist.length - 1, m.tapped))
    const modSigs = this.def.modSigs
    if (shown !== this.shownVoice || allMode !== this.modLabelsAll) {
      this.shownVoice = shown
      this.modLabelsAll = allMode
      for (let s = 0; s < modSigs.length; s++) {
        this.modLabels[s].textContent = modSigs[s].label + (allMode ? '' : ' · V' + (shown + 1))
      }
    }
    for (let s = 0; s < modSigs.length; s++) this.drawSparkline(s)

    let activeCount = 0
    for (let i = 0; i < this.lanes.length && i < m.voices.length; i++) {
      const lane = this.lanes[i]
      const v = m.voices[i]
      if (v.on) activeCount++
      lane.led.classList.toggle('is-on', v.on)
      lane.row.classList.toggle('is-tapped', i === m.tapped && !allMode)
      lane.note.textContent = v.on ? noteName(v.note) : '--'
      lane.freq.textContent = v.on ? fmtHzCents(v.hz, v.note) : '--'
      const amp = Math.max(0, Math.min(1, v.amp))
      lane.ampFill.style.width = (amp * 100).toFixed(1) + '%'
      const d1 = Math.max(-5, Math.min(5, v.drift1))
      const d2 = Math.max(-5, Math.min(5, v.drift2))
      lane.driftNeedle1.style.left = (50 + d1 * 10).toFixed(1) + '%'
      lane.driftNeedle2.style.left = (50 + d2 * 10).toFixed(1) + '%'
      lane.driftText.textContent =
        (v.drift1 >= 0 ? '+' : '') + v.drift1.toFixed(1) + ' ' + (v.drift2 >= 0 ? '+' : '') + v.drift2.toFixed(1) + '¢'
    }

    const pct = Math.round(m.load * 100)
    this.loadFill.style.width = pct + '%'
    this.loadFill.classList.toggle('is-hot', pct > 70)
    this.loadText.textContent = pct + '%'
    this.voicesText.textContent = 'VOICES ' + activeCount + '/' + this.nv
  }

  /** Log-frequency, log-magnitude spectrum (30 Hz .. 16 kHz, 0..-80 dB). */
  private drawSpectrum(i: number, dataL: Float32Array, dataR?: Float32Array): void {
    const ctx = this.ctxs[i]
    const cv = this.canvases[i]
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const w = cv.width / dpr
    const h = cv.height / dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    if (dataR) this.traceSpectrum(ctx, dataR, w, h, R_COLOR, 0.9, 0.14)
    this.traceSpectrum(ctx, dataL, w, h, this.fg, dataR ? 0.9 : 1, dataR ? 0.14 : 0.22)
    if (dataR) this.drawLrLegend(ctx, w)
  }

  private traceSpectrum(
    ctx: CanvasRenderingContext2D,
    data: Float32Array,
    w: number,
    h: number,
    color: string,
    alpha: number,
    fillAlpha = 0.22,
  ): void {
    const mag = fftMag(data)
    const nyq = this.sampleRate / 2
    const fLo = 30
    const fHi = Math.min(16000, nyq)
    const pointY = (px: number): number => {
      const f = fLo * Math.pow(fHi / fLo, px / (w - 1))
      const bin = (f / nyq) * (mag.length - 1)
      const b0 = Math.floor(bin)
      const frac = bin - b0
      const v = mag[b0] * (1 - frac) + (mag[b0 + 1] ?? 0) * frac
      const db = 20 * Math.log10(v + 1e-9)
      const t = Math.max(0, Math.min(1, (db + 80) / 80)) // -80..0 dB
      return h - 2 - t * (h - 5)
    }
    // Single anchored glow: -80 dB floor is the "zero", brightest at 0 dB.
    if (fillAlpha > 0) {
      ctx.fillStyle = glowGradient(ctx, h, color, 'up', fillAlpha)
      ctx.beginPath()
      ctx.moveTo(0, h - 2)
      for (let px = 0; px < w; px++) ctx.lineTo(px, pointY(px))
      ctx.lineTo(w - 1, h - 2)
      ctx.closePath()
      ctx.fill()
    }
    ctx.strokeStyle = color
    ctx.globalAlpha = alpha
    ctx.lineWidth = 1.2
    ctx.beginPath()
    for (let px = 0; px < w; px++) {
      const py = pointY(px)
      if (px === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  /**
   * Multi-channel-scope overlay for a voice-path cell. Each voice locks to
   * its OWN trigger (voices sit at unrelated pitches, so a shared trigger
   * would just scramble the other traces); silent voices are skipped.
   * Fixed V1..Vn draw order — all-voices mode has no last-triggered priority.
   */
  private drawScopeVoices(i: number, datas: Float32Array[]): void {
    const ctx = this.ctxs[i]
    const cv = this.canvases[i]
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const w = cv.width / dpr
    const h = cv.height / dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.globalAlpha = 0.25
    ctx.strokeStyle = this.fg
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, h / 2)
    ctx.lineTo(w, h / 2)
    ctx.stroke()
    ctx.globalAlpha = 1
    let drewAny = false
    for (let v = 0; v < datas.length; v++) {
      const data = datas[v]
      if (!data) continue
      let peak = 0
      for (let s = 0; s < data.length; s++) {
        const a = data[s] > -data[s] ? data[s] : -data[s]
        if (a > peak) peak = a
      }
      if (peak < SILENT_PEAK) continue
      const n = data.length
      const win = n > 768 ? 512 : n - Math.floor(n / 3)
      const half = Math.floor(win / 2)
      let lock = this.waveLocks.get(1000 + i * 32 + v)
      if (!lock) {
        lock = new ScopeLock()
        this.waveLocks.set(1000 + i * 32 + v, lock)
      }
      const pick = lock.pick(data, half, n - win + half + 1, half, win, (n - win) >> 1)
      const d = pick.frozen ?? data
      const trig = pick.frozen ? half : pick.start + half
      this.traceWave(ctx, d, trig, half, win, w, h, this.voiceColors[v], 0.85, 0.18)
      drewAny = true
    }
    if (drewAny) this.drawVoiceLegend(ctx, w)
  }

  private drawSpectrumVoices(i: number, datas: Float32Array[]): void {
    const ctx = this.ctxs[i]
    const cv = this.canvases[i]
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const w = cv.width / dpr
    const h = cv.height / dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    let drewAny = false
    for (let v = 0; v < datas.length; v++) {
      const data = datas[v]
      if (!data) continue
      let peak = 0
      for (let s = 0; s < data.length; s++) {
        const a = data[s] > -data[s] ? data[s] : -data[s]
        if (a > peak) peak = a
      }
      if (peak < SILENT_PEAK) continue
      this.traceSpectrum(ctx, data, w, h, this.voiceColors[v], 0.85, 0.12)
      drewAny = true
    }
    if (drewAny) this.drawVoiceLegend(ctx, w)
  }

  /** Corner legend for the voice overlay: colored 1..n, dimmed when idle.
   *  Wraps in right-aligned rows of 8 so 16-voice defs stay on-canvas
   *  (rows past the first carry two-digit labels, so they space wider). */
  private drawVoiceLegend(ctx: CanvasRenderingContext2D, w: number): void {
    ctx.font = '700 7px monospace'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    const perRow = 8
    for (let v = 0; v < this.nv; v++) {
      const row = (v / perRow) | 0
      const col = v % perRow
      const rowN = Math.min(perRow, this.nv - row * perRow)
      const sp = row === 0 ? 8 : 11
      ctx.globalAlpha = this.voiceOn[v] ? 0.9 : 0.28
      ctx.fillStyle = this.voiceColors[v]
      ctx.fillText(String(v + 1), w - (rowN * sp + 1) + col * sp, 3 + row * 8)
    }
    ctx.globalAlpha = 1
  }

  /** Tiny channel legend for stereo cells. */
  private drawLrLegend(ctx: CanvasRenderingContext2D, w: number): void {
    ctx.font = '700 7px monospace'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.globalAlpha = 0.9
    ctx.fillStyle = this.fg
    ctx.fillText('L', w - 17, 3)
    ctx.fillStyle = R_COLOR
    ctx.fillText('R', w - 9, 3)
    ctx.globalAlpha = 1
  }

  /** Rolling sparkline of one modulator signal. */
  private drawSparkline(s: number): void {
    const ctx = this.modCtxs[s]
    const cv = this.modCanvases[s]
    if (!ctx) return
    const sig = this.def.modSigs[s]
    const dpr = window.devicePixelRatio || 1
    const w = cv.width / dpr
    const h = cv.height / dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    if (sig.bipolar) {
      ctx.globalAlpha = 0.25
      ctx.strokeStyle = sig.color
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, h / 2)
      ctx.lineTo(w, h / 2)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    const n = this.histFill
    if (n < 2) return
    if (this.voicesMode === 'all') {
      // All-voices overlay: voice colors, fixed draw order, no tapped priority.
      for (let v = 0; v < this.modHist.length; v++) {
        this.traceSparkline(ctx, this.modHist[v][s], n, w, h, sig.bipolar, this.voiceColors[v], 0.85, 0.12)
      }
      this.drawVoiceLegend(ctx, w)
    } else {
      this.traceSparkline(ctx, this.modHist[this.shownVoice][s], n, w, h, sig.bipolar, sig.color, 1)
    }
  }

  private traceSparkline(
    ctx: CanvasRenderingContext2D,
    hist: Float32Array,
    n: number,
    w: number,
    h: number,
    bipolar: boolean,
    color: string,
    alpha: number,
    fillAlpha = 0.2,
  ): void {
    const pointXY = (k: number): [number, number] => {
      const idx = (this.histW - n + k + HISTORY) % HISTORY
      let v = hist[idx]
      if (!Number.isFinite(v)) v = 0
      const x = w - 1 - ((n - 1 - k) / (HISTORY - 1)) * w
      const y = bipolar
        ? h / 2 - Math.max(-1, Math.min(1, v)) * (h / 2 - 2)
        : h - 2 - Math.max(0, Math.min(1, v)) * (h - 4)
      return [x, y]
    }
    const base = bipolar ? h / 2 : h - 2
    if (fillAlpha > 0 && n > 1) {
      ctx.fillStyle = glowGradient(ctx, h, color, bipolar ? 'mirror' : 'up', fillAlpha)
      ctx.beginPath()
      const [x0] = pointXY(0)
      ctx.moveTo(x0, base)
      for (let k = 0; k < n; k++) {
        const [x, y] = pointXY(k)
        ctx.lineTo(x, y)
      }
      const [xn] = pointXY(n - 1)
      ctx.lineTo(xn, base)
      ctx.closePath()
      ctx.fill()
    }
    ctx.strokeStyle = color
    ctx.globalAlpha = alpha
    ctx.lineWidth = 1.3
    ctx.beginPath()
    for (let k = 0; k < n; k++) {
      const [x, y] = pointXY(k)
      if (k === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  /** Per-cell frame-coherent trigger locks (keys: cell i; 1000+i*32+v per voice). */
  private readonly waveLocks = new Map<number, ScopeLock>()

  private drawScope(i: number, dataL: Float32Array, dataR?: Float32Array): void {
    const ctx = this.ctxs[i]
    const cv = this.canvases[i]
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const w = cv.width / dpr
    const h = cv.height / dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.globalAlpha = 0.25
    ctx.strokeStyle = this.fg
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, h / 2)
    ctx.lineTo(w, h / 2)
    ctx.stroke()
    ctx.globalAlpha = 1
    // Frame-coherent trigger (ScopeLock): candidate crossings are scored
    // against the previous frame's view so multi-crossing waves — sync
    // ramps, ring products, period-doubled SHAPE teeth — hold still, and
    // frames whose locked crossing class doesn't fit the display range
    // freeze last frame's trace instead of unlocking. Stereo cells share
    // the L channel's lock so inter-channel timing stays honest.
    const n = dataL.length
    const win = n > 768 ? 512 : n - Math.floor(n / 3)
    const half = Math.floor(win / 2)
    let lock = this.waveLocks.get(i)
    if (!lock) {
      lock = new ScopeLock()
      this.waveLocks.set(i, lock)
    }
    const pick = lock.pick(dataL, half, n - win + half + 1, half, win, (n - win) >> 1, dataR)
    const dL = pick.frozen ?? dataL
    const dR = pick.frozen ? (pick.frozenR ?? undefined) : dataR
    const trig = pick.frozen ? half : pick.start + half
    if (dR) this.traceWave(ctx, dR, trig, half, win, w, h, R_COLOR, 0.9, 0.22)
    this.traceWave(ctx, dL, trig, half, win, w, h, this.fg, dR ? 0.9 : 1, dR ? 0.22 : 0.38)
    if (dataR) this.drawLrLegend(ctx, w)
  }

  private traceWave(
    ctx: CanvasRenderingContext2D,
    data: Float32Array,
    trig: number,
    half: number,
    win: number,
    w: number,
    h: number,
    color: string,
    alpha: number,
    fillAlpha = 0.38,
  ): void {
    const pointY = (x: number): number => {
      let s = data[trig - half + x]
      if (!Number.isFinite(s)) s = 0
      if (s > 1.4) s = 1.4
      else if (s < -1.4) s = -1.4
      return h / 2 - s * (h / 2 - 3) * 0.71
    }
    // Anchored glow: fill trace-to-centerline with a fixed vertical gradient.
    if (fillAlpha > 0) {
      ctx.fillStyle = glowGradient(ctx, h, color, 'mirror', fillAlpha)
      ctx.beginPath()
      ctx.moveTo(0, h / 2)
      for (let x = 0; x < win; x++) ctx.lineTo((x / (win - 1)) * w, pointY(x))
      ctx.lineTo(w, h / 2)
      ctx.closePath()
      ctx.fill()
    }
    ctx.strokeStyle = color
    ctx.globalAlpha = alpha
    ctx.lineWidth = 1.4
    ctx.beginPath()
    for (let x = 0; x < win; x++) {
      const px = (x / (win - 1)) * w
      const py = pointY(x)
      if (x === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.stroke()
    ctx.globalAlpha = 1
  }
}
