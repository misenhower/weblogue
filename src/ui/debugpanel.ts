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
import { P } from '../shared/params'
import { egIntToPercent, lfoIntTo01 } from '../shared/maps'
import { fftMag } from './fft'

type DbgMsg = Extract<FromEngine, { t: 'dbg' }>

const SVG_NS = 'http://www.w3.org/2000/svg'
const TAP_LABELS = ['VCO 1', 'VCO 2', 'MULTI', 'MIX', 'VCF', 'MOD FX', 'DELAY', 'OUTPUT'] as const
/** Cell positions in the 796x306 diagram (see the wire paths below). */
const CELLS = [
  { x: 8, y: 4 },
  { x: 8, y: 76 },
  { x: 8, y: 148 },
  { x: 260, y: 76 },
  { x: 480, y: 76 },
  { x: 140, y: 236 },
  { x: 370, y: 236 },
  { x: 600, y: 236 },
] as const
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const HISTORY = 128 // sparkline points (~4s at 30fps telemetry)
const MOD_SIGS = [
  { label: 'AMP EG', color: '#8fe0a0', bipolar: false },
  { label: 'MOD EG', color: '#e0c98f', bipolar: false },
  { label: 'LFO', color: '#8fb8e0', bipolar: true },
] as const

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

  /* two flow views sharing the same scope cells */
  private view: 'diagram' | 'compact' = 'diagram'
  private diagramEl!: HTMLElement
  private compactEl!: HTMLElement
  private compactSlots: HTMLElement[] = []
  private viewBtns!: { diagram: HTMLButtonElement; compact: HTMLButtonElement }
  /** Cell indices shown in the compact view (FX taps are diagram-only). */
  private static readonly COMPACT_IDX = [0, 1, 2, 3, 4, 7]
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
    const close = document.createElement('button')
    close.className = 'xd-svc-close'
    close.textContent = '✕'
    close.setAttribute('aria-label', 'close service mode')
    close.addEventListener('click', () => this.onClose?.())
    const right = document.createElement('div')
    right.className = 'xd-svc-head-right'
    right.append(seg, close)
    head.append(title, right)

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
    wire('M650 99 H726 V212 H110 V259 H140', 'xd-w')
    wire('M310 259 H370', 'xd-w')
    wire('M540 259 H600', 'xd-w')
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
    const scopes: (Float32Array | undefined)[] = [
      m.taps[0],
      m.taps[1],
      m.taps[2],
      m.taps[3],
      m.taps[4],
      m.taps[5],
      m.taps[6],
      m.postFx,
    ]
    for (let i = 0; i < scopes.length; i++) {
      const data = scopes[i]
      if (!data) continue
      if (this.fftOn[i]) this.drawSpectrum(i, data)
      else this.drawScope(i, data)
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
    const shown = Math.max(0, Math.min(this.modHist.length - 1, m.tapped))
    if (shown !== this.shownVoice) {
      this.shownVoice = shown
      for (let s = 0; s < MOD_SIGS.length; s++) {
        this.modLabels[s].textContent = MOD_SIGS[s].label + ' · V' + (shown + 1)
      }
    }
    for (let s = 0; s < MOD_SIGS.length; s++) this.drawSparkline(s)

    let activeCount = 0
    for (let i = 0; i < this.lanes.length && i < m.voices.length; i++) {
      const lane = this.lanes[i]
      const v = m.voices[i]
      if (v.on) activeCount++
      lane.led.classList.toggle('is-on', v.on)
      lane.row.classList.toggle('is-tapped', i === m.tapped)
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
  private drawSpectrum(i: number, data: Float32Array): void {
    const ctx = this.ctxs[i]
    const cv = this.canvases[i]
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const w = cv.width / dpr
    const h = cv.height / dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const mag = fftMag(data)
    const nyq = this.sampleRate / 2
    const fLo = 30
    const fHi = Math.min(16000, nyq)
    ctx.strokeStyle = this.fg
    ctx.globalAlpha = 1
    ctx.lineWidth = 1.2
    ctx.beginPath()
    for (let px = 0; px < w; px++) {
      const f = fLo * Math.pow(fHi / fLo, px / (w - 1))
      const bin = (f / nyq) * (mag.length - 1)
      const b0 = Math.floor(bin)
      const frac = bin - b0
      const v = mag[b0] * (1 - frac) + (mag[b0 + 1] ?? 0) * frac
      const db = 20 * Math.log10(v + 1e-9)
      const t = Math.max(0, Math.min(1, (db + 80) / 80)) // -80..0 dB
      const py = h - 2 - t * (h - 5)
      if (px === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.stroke()
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
    const hist = this.modHist[this.shownVoice][s]
    const n = this.histFill
    if (n < 2) return
    ctx.strokeStyle = sig.color
    ctx.lineWidth = 1.3
    ctx.beginPath()
    for (let k = 0; k < n; k++) {
      // oldest -> newest, right-aligned
      const idx = (this.histW - n + k + HISTORY) % HISTORY
      let v = hist[idx]
      if (!Number.isFinite(v)) v = 0
      const x = w - 1 - ((n - 1 - k) / (HISTORY - 1)) * w
      const y = sig.bipolar
        ? h / 2 - Math.max(-1, Math.min(1, v)) * (h / 2 - 2)
        : h - 2 - Math.max(0, Math.min(1, v)) * (h - 4)
      if (k === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }

  private drawScope(i: number, data: Float32Array): void {
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
    ctx.lineWidth = 1.4
    ctx.beginPath()
    // Center-trigger: lock a rising zero crossing to the horizontal middle
    // (searching the middle third of the frame), so periodic waveforms hold
    // still with their trigger point centered; fall back to the frame center.
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
    for (let x = 0; x < win; x++) {
      let s = data[trig - half + x]
      if (!Number.isFinite(s)) s = 0
      if (s > 1.4) s = 1.4
      else if (s < -1.4) s = -1.4
      const px = (x / (win - 1)) * w
      const py = h / 2 - s * (h / 2 - 3) * 0.71
      if (x === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.stroke()
  }
}
