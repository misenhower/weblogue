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
import { fftMag } from './fft'

type DbgMsg = Extract<FromEngine, { t: 'dbg' }>

const TAP_LABELS = ['VCO 1', 'VCO 2', 'MIX', 'VCF', 'OUTPUT'] as const
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
  private readonly fftOn: boolean[] = [false, false, false, false, false]
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

  constructor() {
    this.el = document.createElement('div')
    this.el.className = 'xd-svc'
    this.el.innerHTML = ''

    const head = document.createElement('div')
    head.className = 'xd-svc-head'
    const title = document.createElement('span')
    title.className = 'xd-svc-title'
    title.textContent = 'SERVICE MODE'
    const close = document.createElement('button')
    close.className = 'xd-svc-close'
    close.textContent = '✕'
    close.setAttribute('aria-label', 'close service mode')
    close.addEventListener('click', () => this.onClose?.())
    head.append(title, close)

    /* --- block diagram row: scopes joined by arrows -------------------- */
    const flow = document.createElement('div')
    flow.className = 'xd-svc-flow'
    for (let i = 0; i < TAP_LABELS.length; i++) {
      const cell = document.createElement('div')
      cell.className = 'xd-svc-tap'
      const cv = document.createElement('canvas')
      cv.className = 'xd-svc-scope'
      cv.width = 132 * (window.devicePixelRatio || 1)
      cv.height = 52 * (window.devicePixelRatio || 1)
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
      flow.appendChild(cell)
      if (i < TAP_LABELS.length - 1) {
        const arrow = document.createElement('div')
        arrow.className = 'xd-svc-arrow'
        // VCO1 and VCO2 both feed MIX; mark the first joint accordingly.
        arrow.textContent = i === 0 ? '⊕' : '→'
        flow.appendChild(arrow)
      }
      let ctx: CanvasRenderingContext2D | null = null
      try {
        ctx = cv.getContext('2d')
      } catch {
        ctx = null
      }
      this.canvases.push(cv)
      this.ctxs.push(ctx)
    }

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

    this.el.append(head, flow, modRow, lanes, health)
  }

  /** Apply one telemetry frame. */
  update(m: DbgMsg): void {
    const scopes: (Float32Array | undefined)[] = [m.taps[0], m.taps[1], m.taps[2], m.taps[3], m.postFx]
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
