/*
 * SERVICE MODE — diagnostic drawer (v1).
 *
 * Renders the engine's debug telemetry: the signal path as a mini block
 * diagram with live scopes at five taps (VCO1 / VCO2 / MIX / VCF / post-FX),
 * four voice-activity lanes with drift meters, and an audio-thread health
 * strip. Telemetry only streams while the drawer is open (the app sends
 * {t:'debug', on} on toggle), so it costs nothing when closed.
 */
import type { FromEngine } from '../shared/messages'
import type { Store } from '../state/store'
import { P } from '../synths/xd/params'
import { egIntToPercent, lfoIntTo01 } from '../synths/xd/curves'
import { fftMag } from './fft'

type DbgMsg = Extract<FromEngine, { t: 'dbg' }>

const SVG_NS = 'http://www.w3.org/2000/svg'
const TAP_LABELS = ['VCO 1', 'VCO 2', 'MULTI', 'MIX', 'VCF', 'VCA', 'MOD FX', 'DELAY', 'OUTPUT'] as const
/** Which telemetry tap(s) feed each scope cell; r set = stereo overlay. */
const CELL_TAPS: ReadonlyArray<{ l: number; r?: number }> = [
  { l: 0 },
  { l: 1 },
  { l: 2 },
  { l: 3 },
  { l: 4 },
  { l: 5 },
  { l: 6, r: 7 },
  { l: 8, r: 9 },
  { l: 10, r: 11 },
]
const R_COLOR = '#8fb8e0'
/** Per-voice trace colors (4-channel-scope mode); V1 matches the mono green. */
const VOICE_COLORS = ['#8fe0a0', '#8fb8e0', '#e0c98f', '#e08fa0'] as const
/** Silent-trace cutoff: skip drawing voices with no signal to reduce clutter. */
const SILENT_PEAK = 0.001
/** Cell positions in the 796x306 diagram (see the wire paths below). */
const CELLS = [
  { x: 8, y: 4 },
  { x: 8, y: 76 },
  { x: 8, y: 148 },
  { x: 260, y: 76 },
  { x: 480, y: 76 },
  { x: 8, y: 236 },
  { x: 248, y: 236 },
  { x: 444, y: 236 },
  { x: 626, y: 236 },
] as const
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const HISTORY = 128 // sparkline points (~4s at 30fps telemetry)
const MOD_SIGS = [
  { label: 'AMP EG', color: '#8fe0a0', bipolar: false },
  { label: 'MOD EG', color: '#e0c98f', bipolar: false },
  { label: 'LFO', color: '#8fb8e0', bipolar: true },
] as const

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

  private readonly canvases: HTMLCanvasElement[] = []
  private readonly ctxs: (CanvasRenderingContext2D | null)[] = []
  private readonly fftOn: boolean[] = TAP_LABELS.map(() => false)
  private readonly store?: Store
  private wireMultiPre!: SVGPathElement
  private wireMultiPost!: SVGPathElement
  private wireEgCut!: SVGPathElement
  private wireEgPitch!: SVGPathElement
  private wireLfoCut!: SVGPathElement
  private wireLfoOsc!: SVGPathElement
  private badgeEg!: HTMLElement
  private badgeLfo!: HTMLElement
  private badgeSync!: HTMLElement
  private badgeRing!: HTMLElement
  private badgeXmod!: HTMLElement

  /** 4-voice overlay mode; the app re-arms telemetry when this changes. */
  onVoicesMode?: (all: boolean) => void

  /* two flow views sharing the same scope cells */
  private voicesMode: 'tap' | 'all' = 'tap'
  private voiceBtns!: { tap: HTMLButtonElement; all: HTMLButtonElement }
  private view: 'diagram' | 'compact' = 'diagram'
  private diagramEl!: HTMLElement
  private compactEl!: HTMLElement
  private compactSlots: HTMLElement[] = []
  private viewBtns!: { diagram: HTMLButtonElement; compact: HTMLButtonElement }
  /** Cell indices shown in the compact view (VCA/FX taps are diagram-only). */
  private static readonly COMPACT_IDX = [0, 1, 2, 3, 4, 8]
  private readonly tapCells: HTMLElement[] = []
  private readonly modCanvases: HTMLCanvasElement[] = []
  private readonly modCtxs: (CanvasRenderingContext2D | null)[] = []
  /** Per-voice modulator histories [voice][signal] — every voice records
   *  continuously so switching the tap shows THAT voice's real past. */
  private readonly modHist: Float32Array[][] = [0, 1, 2, 3].map(() => [
    new Float32Array(HISTORY),
    new Float32Array(HISTORY),
    new Float32Array(HISTORY),
  ])
  private histW = 0
  private histFill = 0
  private shownVoice = 0
  private modLabelsAll = false
  /** Latest per-voice gate state; dims inactive voices' legend digits. */
  private readonly voiceOn = [false, false, false, false]
  private readonly modLabels: HTMLElement[] = []
  private readonly lanes: Lane[] = []
  private loadFill!: HTMLElement
  private loadText!: HTMLElement
  private voicesText!: HTMLElement
  private fg = '#8fe0a0'

  constructor(opts?: { store?: Store }) {
    this.store = opts?.store
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
    vseg.title = 'voice scopes: tapped voice only, or all four overlaid'
    const mkVoices = (m: 'tap' | 'all', label: string): HTMLButtonElement => {
      const b = document.createElement('button')
      b.className = 'xd-svc-seg-btn'
      b.textContent = label
      b.addEventListener('click', () => this.setVoicesMode(m))
      vseg.appendChild(b)
      return b
    }
    this.voiceBtns = { tap: mkVoices('tap', '1V'), all: mkVoices('all', '4V') }
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
      if (localStorage.getItem('xd-svc-voices') === 'all') this.voicesMode = 'all'
    } catch {
      /* no storage */
    }
    this.voiceBtns.tap.classList.toggle('is-active', this.voicesMode === 'tap')
    this.voiceBtns.all.classList.toggle('is-active', this.voicesMode === 'all')

    /* --- signal-flow block diagram -------------------------------------
     * Generators stack on the left and sum into MIX -> VCF; the FX chain
     * runs along the bottom. Wires are SVG paths over fixed cell positions;
     * mod-routing wires and the SYNC/RING/X-MOD badges follow the store. */
    const diagram = document.createElement('div')
    diagram.className = 'xd-svc-diagram'
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 796 306')
    svg.setAttribute('class', 'xd-svc-wires')
    diagram.appendChild(svg)
    const wire = (d: string, cls: string): SVGPathElement => {
      const p = document.createElementNS(SVG_NS, 'path')
      p.setAttribute('d', d)
      p.setAttribute('class', cls)
      svg.appendChild(p)
      return p
    }
    // Audio path.
    wire('M178 27 H219 V99 H260', 'xd-w')
    wire('M178 99 H260', 'xd-w')
    this.wireMultiPre = wire('M178 171 H219 V99', 'xd-w')
    this.wireMultiPost = wire('M178 171 H726 V212', 'xd-w')
    wire('M430 99 H480', 'xd-w')
    wire('M650 99 H726 V212 H93 V236', 'xd-w') // VCF down into the VCA
    wire('M178 259 H248', 'xd-w') // VCA -> (voice sum) -> MOD FX
    wire('M418 259 H444', 'xd-w')
    wire('M614 259 H626', 'xd-w')
    // Mod routing (visibility/opacity follow the current program).
    this.wireEgCut = wire('M360 17 H560 V76', 'xd-w xd-w-eg')
    this.wireEgPitch = wire('M300 17 H219 V90', 'xd-w xd-w-eg')
    this.wireLfoCut = wire('M360 197 H560 V140', 'xd-w xd-w-lfo')
    this.wireLfoOsc = wire('M300 197 H219 V180', 'xd-w xd-w-lfo')

    for (let i = 0; i < TAP_LABELS.length; i++) {
      const cell = document.createElement('div')
      cell.className = 'xd-svc-tap xd-svc-cell'
      cell.style.left = CELLS[i].x + 'px'
      cell.style.top = CELLS[i].y + 'px'
      const cv = document.createElement('canvas')
      cv.className = 'xd-svc-scope'
      cv.width = 170 * (window.devicePixelRatio || 1)
      cv.height = 46 * (window.devicePixelRatio || 1)
      const label = document.createElement('div')
      label.className = 'xd-svc-label'
      label.textContent = TAP_LABELS[i]
      cell.append(cv, label)
      cell.title = 'click: waveform / spectrum'
      const idx = i
      cv.addEventListener('click', () => {
        this.fftOn[idx] = !this.fftOn[idx]
        cell.classList.toggle('is-fft', this.fftOn[idx])
        label.textContent = TAP_LABELS[idx] + (this.fftOn[idx] ? ' · FFT' : '')
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

    // VCO1<->VCO2 relationship badges + EG/LFO routing badges.
    this.badgeSync = this.badge(diagram, 186, 36, 'SYNC', 'xd-svc-mini')
    this.badgeRing = this.badge(diagram, 186, 56, 'RING', 'xd-svc-mini')
    this.badgeXmod = this.badge(diagram, 186, 76, 'X-MOD', 'xd-svc-mini')
    // The xd mono-sums all four voices between the VCAs and the FX chain.
    // Centered on the VCA->MOD FX wire (gap midpoint x=213, wire y=259).
    const sum = this.badge(diagram, 213, 259, 'Σ ×4', 'xd-svc-mini')
    sum.style.transform = 'translate(-50%, -50%)'
    sum.title = 'all four voices are mono-summed here, before the effects'
    this.badgeEg = this.badge(diagram, 296, 6, 'EG', 'xd-svc-badge xd-svc-badge--eg')
    this.badgeLfo = this.badge(diagram, 296, 186, 'LFO', 'xd-svc-badge xd-svc-badge--lfo')

    if (this.store) {
      this.store.onParam(() => this.refreshRouting())
      this.store.onProgram(() => this.refreshRouting())
      this.refreshRouting()
    } else {
      this.badgeEg.style.display = 'none'
      this.badgeLfo.style.display = 'none'
    }
    this.diagramEl = diagram

    /* --- compact view (the original linear flow) ------------------ */
    const compact = document.createElement('div')
    compact.className = 'xd-svc-compact'
    const compactArrows = ['⊕', '⊕', '→', '→', '→']
    for (let k = 0; k < DebugPanel.COMPACT_IDX.length; k++) {
      const slot = document.createElement('div')
      slot.className = 'xd-svc-slot'
      compact.appendChild(slot)
      this.compactSlots.push(slot)
      if (k < compactArrows.length) {
        const arrow = document.createElement('div')
        arrow.className = 'xd-svc-arrow'
        arrow.textContent = compactArrows[k]
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
    for (let i = 0; i < MOD_SIGS.length; i++) {
      const cell = document.createElement('div')
      cell.className = 'xd-svc-mod'
      const cv = document.createElement('canvas')
      cv.className = 'xd-svc-mod-cv'
      cv.width = 236 * (window.devicePixelRatio || 1)
      cv.height = 34 * (window.devicePixelRatio || 1)
      const label = document.createElement('div')
      label.className = 'xd-svc-label'
      label.textContent = MOD_SIGS[i].label + ' · V1'
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
    lanes.className = 'xd-svc-lanes'
    for (let i = 0; i < 4; i++) {
      const row = document.createElement('div')
      row.className = 'xd-svc-lane'
      const led = document.createElement('span')
      led.className = 'xd-svc-led'
      const name = document.createElement('span')
      name.className = 'xd-svc-vname'
      name.textContent = 'V' + (i + 1)
      name.style.color = VOICE_COLORS[i] // matches the 4V trace colors
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
    this.voicesText.textContent = 'VOICES 0/4'
    health.append(loadLabel, loadBar, this.loadText, this.voicesText)

    this.el.append(head, diagram, compact, modRow, lanes, health)
    this.applyView()
  }

  /** Switch the voice scopes between tapped-only and 4-voice overlay. */
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
    if (compact) {
      // Move the shared cells into the compact slots (FX taps stay hidden in
      // the diagram); clear absolute positioning.
      for (let k = 0; k < DebugPanel.COMPACT_IDX.length; k++) {
        const cell = this.tapCells[DebugPanel.COMPACT_IDX[k]]
        cell.classList.remove('xd-svc-cell')
        cell.style.left = ''
        cell.style.top = ''
        this.compactSlots[k].appendChild(cell)
      }
    } else {
      for (let i = 0; i < this.tapCells.length; i++) {
        const cell = this.tapCells[i]
        cell.classList.add('xd-svc-cell')
        cell.style.left = CELLS[i].x + 'px'
        cell.style.top = CELLS[i].y + 'px'
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
    const egT = s.getParam(P.EG_TARGET) // 0 CUTOFF, 1 PITCH 2, 2 PITCH
    const egAmt = Math.abs(egIntToPercent(s.getParam(P.EG_INT))) / 100
    const lfoT = s.getParam(P.LFO_TARGET) // 0 CUTOFF, 1 SHAPE, 2 PITCH
    const lfoAmt = Math.abs(lfoIntTo01(s.getParam(P.LFO_INT)))
    const oscSel = ['ALL', 'VCO 1+2', 'VCO 2', 'MULTI'][s.getParam(P.LFO_TARGET_OSC)] ?? 'ALL'
    this.badgeEg.textContent = 'EG → ' + (['CUTOFF', 'PITCH 2', 'PITCH'][egT] ?? '')
    this.badgeLfo.textContent =
      'LFO → ' + (['CUTOFF', 'SHAPE', 'PITCH'][lfoT] ?? '') + (lfoT !== 0 ? ' · ' + oscSel : '')
    const show = (el: SVGPathElement, on: boolean, amt: number): void => {
      el.style.display = on && amt > 0.02 ? '' : 'none'
      el.style.opacity = String(Math.min(1, 0.15 + amt * 0.85))
    }
    show(this.wireEgCut, egT === 0, egAmt)
    show(this.wireEgPitch, egT !== 0, egAmt)
    show(this.wireLfoCut, lfoT === 0, lfoAmt)
    show(this.wireLfoOsc, lfoT !== 0, lfoAmt)
    this.badgeEg.style.opacity = egAmt > 0.02 ? '1' : '0.35'
    this.badgeLfo.style.opacity = lfoAmt > 0.02 ? '1' : '0.35'
    const post = s.getParam(P.MULTI_ROUTING) >= 0.5
    this.wireMultiPre.style.display = post ? 'none' : ''
    this.wireMultiPost.style.display = post ? '' : 'none'
    this.badgeSync.classList.toggle('is-on', s.getParam(P.SYNC) >= 0.5)
    this.badgeRing.classList.toggle('is-on', s.getParam(P.RING) >= 0.5)
    this.badgeXmod.classList.toggle('is-on', s.getParam(P.CROSS_MOD) > 8)
  }

  /** Apply one telemetry frame. */
  update(m: DbgMsg): void {
    for (let v = 0; v < this.voiceOn.length; v++) this.voiceOn[v] = m.voices[v]?.on === true

    const multi = this.voicesMode === 'all' && m.vtaps && m.vtaps.length >= 24
    for (let i = 0; i < CELL_TAPS.length; i++) {
      const t = CELL_TAPS[i]
      if (multi && t.r === undefined) {
        // Voice-path cell: overlay all four voices, 4-channel-scope style.
        const datas = [0, 1, 2, 3].map((v) => m.vtaps![v * 6 + t.l])
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
    if (shown !== this.shownVoice || allMode !== this.modLabelsAll) {
      this.shownVoice = shown
      this.modLabelsAll = allMode
      for (let s = 0; s < MOD_SIGS.length; s++) {
        this.modLabels[s].textContent = MOD_SIGS[s].label + (allMode ? '' : ' · V' + (shown + 1))
      }
    }
    for (let s = 0; s < MOD_SIGS.length; s++) this.drawSparkline(s)

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
    this.voicesText.textContent = 'VOICES ' + activeCount + '/4'
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
   * 4-channel-scope overlay for a voice-path cell. Each voice locks to its
   * OWN trigger (voices sit at unrelated pitches, so a shared trigger would
   * just scramble three of the four traces); silent voices are skipped.
   * Fixed V1..V4 draw order — 4V mode has no last-triggered priority.
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
      let trig = Math.floor(n / 2)
      for (let x = half + 1; x <= n - (win - half); x++) {
        if (data[x - 1] <= 0 && data[x] > 0) {
          trig = x
          break
        }
      }
      this.traceWave(ctx, data, trig, half, win, w, h, VOICE_COLORS[v], 0.85, 0.18)
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
      this.traceSpectrum(ctx, data, w, h, VOICE_COLORS[v], 0.85, 0.12)
      drewAny = true
    }
    if (drewAny) this.drawVoiceLegend(ctx, w)
  }

  /** Corner legend for the 4-voice overlay: colored 1 2 3 4, dimmed when idle. */
  private drawVoiceLegend(ctx: CanvasRenderingContext2D, w: number): void {
    ctx.font = '700 7px monospace'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    for (let v = 0; v < 4; v++) {
      ctx.globalAlpha = this.voiceOn[v] ? 0.9 : 0.28
      ctx.fillStyle = VOICE_COLORS[v]
      ctx.fillText(String(v + 1), w - 33 + v * 8, 3)
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
    const sig = MOD_SIGS[s]
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
      // 4-voice overlay: voice colors, fixed draw order, no tapped priority.
      for (let v = 0; v < this.modHist.length; v++) {
        this.traceSparkline(ctx, this.modHist[v][s], n, w, h, sig.bipolar, VOICE_COLORS[v], 0.85, 0.12)
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
    // Center-trigger: lock a rising zero crossing to the horizontal middle
    // (searching the middle third of the frame), so periodic waveforms hold
    // still with their trigger point centered; fall back to the frame center.
    // Stereo cells share the L channel's trigger so inter-channel timing
    // (ping-pong bounce, chorus width) stays honest.
    const n = dataL.length
    const win = n > 768 ? 512 : n - Math.floor(n / 3)
    const half = Math.floor(win / 2)
    let trig = Math.floor(n / 2)
    for (let x = half + 1; x <= n - (win - half); x++) {
      if (dataL[x - 1] <= 0 && dataL[x] > 0) {
        trig = x
        break
      }
    }
    if (dataR) this.traceWave(ctx, dataR, trig, half, win, w, h, R_COLOR, 0.9, 0.22)
    this.traceWave(ctx, dataL, trig, half, win, w, h, this.fg, dataR ? 0.9 : 1, dataR ? 0.22 : 0.38)
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
