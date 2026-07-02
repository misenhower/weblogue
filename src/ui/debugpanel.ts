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

type DbgMsg = Extract<FromEngine, { t: 'dbg' }>

const TAP_LABELS = ['VCO 1', 'VCO 2', 'MIX', 'VCF', 'OUTPUT'] as const
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function noteName(n: number): string {
  if (!Number.isFinite(n)) return '--'
  const nn = Math.round(n)
  return NOTE_NAMES[((nn % 12) + 12) % 12] + String(Math.floor(nn / 12) - 1)
}

interface Lane {
  led: HTMLElement
  note: HTMLElement
  ampFill: HTMLElement
  driftNeedle: HTMLElement
  driftText: HTMLElement
  row: HTMLElement
}

export class DebugPanel {
  el: HTMLElement
  onClose?: () => void

  private readonly canvases: HTMLCanvasElement[] = []
  private readonly ctxs: (CanvasRenderingContext2D | null)[] = []
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
      const amp = document.createElement('div')
      amp.className = 'xd-svc-amp'
      const ampFill = document.createElement('div')
      ampFill.className = 'xd-svc-amp-fill'
      amp.appendChild(ampFill)
      const drift = document.createElement('div')
      drift.className = 'xd-svc-drift'
      const driftNeedle = document.createElement('div')
      driftNeedle.className = 'xd-svc-drift-needle'
      drift.appendChild(driftNeedle)
      const driftText = document.createElement('span')
      driftText.className = 'xd-svc-drift-text'
      driftText.textContent = '+0.0¢'
      row.append(led, name, note, amp, drift, driftText)
      lanes.appendChild(row)
      this.lanes.push({ led, note, ampFill, driftNeedle, driftText, row })
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

    this.el.append(head, flow, lanes, health)
  }

  /** Apply one telemetry frame. */
  update(m: DbgMsg): void {
    const scopes: (Float32Array | undefined)[] = [m.taps[0], m.taps[1], m.taps[2], m.taps[3], m.postFx]
    for (let i = 0; i < scopes.length; i++) {
      const data = scopes[i]
      if (data) this.drawScope(i, data)
    }

    let activeCount = 0
    for (let i = 0; i < this.lanes.length && i < m.voices.length; i++) {
      const lane = this.lanes[i]
      const v = m.voices[i]
      if (v.on) activeCount++
      lane.led.classList.toggle('is-on', v.on)
      lane.row.classList.toggle('is-tapped', i === m.tapped)
      lane.note.textContent = v.on ? noteName(v.note) : '--'
      const amp = Math.max(0, Math.min(1, v.amp))
      lane.ampFill.style.width = (amp * 100).toFixed(1) + '%'
      const drift = Math.max(-5, Math.min(5, v.drift))
      lane.driftNeedle.style.left = (50 + drift * 10).toFixed(1) + '%'
      lane.driftText.textContent = (v.drift >= 0 ? '+' : '') + v.drift.toFixed(1) + '¢'
    }

    const pct = Math.round(m.load * 100)
    this.loadFill.style.width = pct + '%'
    this.loadFill.classList.toggle('is-hot', pct > 70)
    this.loadText.textContent = pct + '%'
    this.voicesText.textContent = 'VOICES ' + activeCount + '/4'
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
