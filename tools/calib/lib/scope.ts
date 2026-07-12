/*
 * Realtime scope proof-of-concept: continuous PCM (capture.ts streamPcm)
 * feeds a ring buffer; a localhost page polls /scope.json at ~10 fps and
 * draws a center-triggered waveform, log-frequency spectrum, and level/pitch
 * readouts. Same dependency-free polling architecture as live.ts — if this
 * proves out, the transport can later become a WebSocket without touching
 * the analysis.
 */
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import type { Socket } from 'node:net'
import { fftMag } from '../../../src/dsp/fft'
import { fftPeakHz, goertzelC } from './features'

export const SCOPE_PORT = 8078

const RING_SEC = 2
const WAVE_N = 2048
const FFT_N = 8192
const SPEC_BINS = 240
const SPEC_LO = 30
const SPEC_HI = 16000

export class ScopeState {
  private readonly sr: number
  private readonly ring: Float32Array
  private w = 0
  private filled = 0

  constructor(sr = 48000) {
    this.sr = sr
    this.ring = new Float32Array(RING_SEC * sr)
  }

  push(chunk: Float32Array): void {
    for (let i = 0; i < chunk.length; i++) {
      this.ring[this.w] = chunk[i]
      this.w = (this.w + 1) % this.ring.length
    }
    this.filled = Math.min(this.ring.length, this.filled + chunk.length)
  }

  /** Last n samples in time order. */
  private tail(n: number): Float32Array {
    const count = Math.min(n, this.filled)
    const out = new Float32Array(count)
    let idx = (this.w - count + this.ring.length) % this.ring.length
    for (let i = 0; i < count; i++) {
      out[i] = this.ring[idx]
      idx = (idx + 1) % this.ring.length
    }
    return out
  }

  /**
   * One frame as a flat Float32Array for the WebSocket binary path:
   * [peakDb, rmsDb, f0, waveLen, specLen, ...wave, ...spec]
   */
  binFrame(): Float32Array {
    const f = this.frame() as { peakDb: number; rmsDb: number; f0: number; wave: number[]; spec: number[] }
    const out = new Float32Array(5 + f.wave.length + f.spec.length)
    out[0] = Number.isFinite(f.peakDb) ? f.peakDb : -160
    out[1] = Number.isFinite(f.rmsDb) ? f.rmsDb : -160
    out[2] = f.f0
    out[3] = f.wave.length
    out[4] = f.spec.length
    out.set(f.wave, 5)
    out.set(f.spec, 5 + f.wave.length)
    return out
  }

  /** One poll frame: triggered wave, log spectrum, level + pitch readouts. */
  frame(): object {
    const x = this.tail(FFT_N * 2)
    if (x.length < WAVE_N) return { sr: this.sr, wave: [], spec: [], peakDb: -Infinity, rmsDb: -Infinity, f0: 0 }

    let peak = 0
    let acc = 0
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i])
      if (a > peak) peak = a
      acc += x[i] * x[i]
    }
    const peakDb = 20 * Math.log10(peak + 1e-12)
    const rmsDb = 20 * Math.log10(Math.sqrt(acc / x.length) + 1e-12)

    // pitch first (the trigger needs the true period). Subharmonic descent as
    // in measure.ts: on period-doubled/folded waves a harmonic out-peaks H1 —
    // without it the readout shows the tooth rate, not the fundamental, and
    // the trigger locks to the wrong period.
    let f0 = peakDb > -60 ? fftPeakHz(x, x.length - FFT_N, FFT_N, this.sr) : 0
    if (f0 > 0) {
      const gFrom = x.length - FFT_N
      const powerAt = (f: number): number => goertzelC(x, gFrom, x.length, f, this.sr).power
      const peakPower = powerAt(f0)
      for (const div of [3, 2]) {
        const cand = f0 / div
        if (cand >= 25 && powerAt(cand) > 0.2 * peakPower) {
          f0 = cand
          break
        }
      }
    }

    // center trigger: phase-stable wave view. A bare "rising zero crossing"
    // hops between crossing classes on waves with several crossings per cycle
    // (period-doubled SAW teeth, folded TRI) — anchor at the cycle's global
    // minimum and take the first rising crossing after it, one canonical
    // trigger per cycle. Falls back to the last rising crossing when pitch is
    // unknown or the period doesn't fit the search window.
    const searchFrom = Math.max(WAVE_N / 2, x.length - WAVE_N * 2)
    const searchTo = x.length - WAVE_N / 2
    let trig = -1
    const period = f0 > 0 ? Math.round(this.sr / f0) : 0
    if (period > 0 && searchTo - 2 * period >= searchFrom) {
      let minI = searchTo - 2 * period
      for (let i = minI + 1; i < searchTo - period; i++) if (x[i] < x[minI]) minI = i
      trig = minI
      for (let i = minI + 1; i <= minI + period; i++) {
        if (x[i - 1] <= 0 && x[i] > 0) {
          trig = i
          break
        }
      }
    } else {
      for (let i = searchFrom + 1; i < searchTo; i++) {
        if (x[i - 1] <= 0 && x[i] > 0) trig = i // last crossing wins: freshest view
      }
    }
    const start = trig >= 0 ? trig - WAVE_N / 2 : x.length - WAVE_N
    const wave = Array.from(x.subarray(start, start + WAVE_N))

    // spectrum: FFT magnitudes -> SPEC_BINS log-spaced dB points 30 Hz..16 kHz
    const mags = fftMag(x.subarray(x.length - FFT_N))
    const spec: number[] = []
    const ratio = SPEC_HI / SPEC_LO
    for (let b = 0; b < SPEC_BINS; b++) {
      const fLo = SPEC_LO * Math.pow(ratio, b / SPEC_BINS)
      const fHi = SPEC_LO * Math.pow(ratio, (b + 1) / SPEC_BINS)
      const iLo = Math.max(1, Math.floor((fLo * FFT_N) / this.sr))
      const iHi = Math.max(iLo + 1, Math.ceil((fHi * FFT_N) / this.sr))
      let m = 0
      for (let i = iLo; i < Math.min(iHi, mags.length); i++) if (mags[i] > m) m = mags[i]
      spec.push(Math.round(20 * Math.log10(m + 1e-12) * 10) / 10)
    }

    return { sr: this.sr, wave, spec, specLo: SPEC_LO, specHi: SPEC_HI, peakDb, rmsDb, f0 }
  }
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const WS_FPS = 30

/**
 * Attach the scope's WebSocket push (RFC 6455 handshake + unmasked binary
 * frames at WS_FPS) to any http server. Returns a detach/cleanup fn.
 * Shared by the standalone scope and the unified monitor.
 */
export function attachScopeWs(srv: Server, state: ScopeState): () => void {
  const clients = new Set<Socket>()
  srv.on('upgrade', (req, socket: Socket) => {
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    socket.setNoDelay(true)
    clients.add(socket)
    const drop = (): void => {
      clients.delete(socket)
      socket.destroy()
    }
    socket.on('close', drop)
    socket.on('error', drop)
    socket.on('data', (d: Buffer) => {
      if (d.length && (d[0] & 0x0f) === 0x8) drop()
    })
  })
  const timer = setInterval(() => {
    if (clients.size === 0) return
    const f = state.binFrame()
    const frame = wsFrame(Buffer.from(f.buffer, f.byteOffset, f.byteLength))
    for (const c of clients) c.write(frame)
  }, Math.round(1000 / WS_FPS))
  return () => {
    clearInterval(timer)
    for (const c of clients) c.destroy()
  }
}

/** Server->client binary WebSocket frame (no masking server-side). */
function wsFrame(payload: Buffer): Buffer {
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.from([0x82, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x82
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x82
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

export function startScopeServer(state: ScopeState, port = SCOPE_PORT): Promise<{ url: string; close: () => void } | null> {
  const srv: Server = createServer((req, res) => {
    if (req.url?.startsWith('/scope.json')) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(state.frame()))
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE)
    }
  })
  const detachWs = attachScopeWs(srv, state)
  return new Promise((resolve) => {
    srv.once('error', () => resolve(null))
    srv.listen(port, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => {
          detachWs()
          srv.close()
        },
      }),
    )
  })
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>calib scope</title><style>
  body { background:#14161a; color:#d6dae0; font:13px/1.5 ui-monospace,Menlo,monospace; margin:0; padding:24px; }
  h1 { font-size:15px; margin:0 0 10px; color:#fff; }
  .readout { margin:8px 0 14px; } .readout span { margin-right:22px; }
  .v { color:#7fb5ff; } .warn { color:#ff8f8f; } .dim { color:#8b93a0; }
  canvas { background:#191c21; border-radius:6px; display:block; margin-bottom:12px; }
</style></head><body>
<h1>calib scope <span class="dim" id="status">connecting…</span></h1>
<div class="readout">
  <span>peak <span class="v" id="peak">—</span></span>
  <span>rms <span class="v" id="rms">—</span></span>
  <span>pitch <span class="v" id="pitch">—</span></span>
</div>
<canvas id="wave" width="760" height="240"></canvas>
<canvas id="spec" width="760" height="170"></canvas>
<script>
const NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
function noteName(f) {
  if (!f || f <= 0) return '—'
  const n = 69 + 12 * Math.log2(f / 440)
  const r = Math.round(n)
  const cents = Math.round((n - r) * 100)
  return NOTES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1) + ' ' + (cents >= 0 ? '+' : '') + cents + '\\u00a2'
}
const waveC = document.getElementById('wave'), specC = document.getElementById('spec')
const wctx = waveC.getContext('2d'), sctx = specC.getContext('2d')
function drawWave(w) {
  const W = waveC.width, H = waveC.height
  wctx.clearRect(0, 0, W, H)
  wctx.strokeStyle = '#2a2e35'; wctx.beginPath(); wctx.moveTo(0, H/2); wctx.lineTo(W, H/2); wctx.stroke()
  if (!w.length) return
  let m = 0.05
  for (const v of w) m = Math.max(m, Math.abs(v))
  wctx.strokeStyle = '#7fb5ff'; wctx.lineWidth = 1.4; wctx.beginPath()
  for (let i = 0; i < w.length; i++) {
    const x = i / (w.length - 1) * W
    const y = H/2 - (w[i] / m) * (H/2 - 8)
    i ? wctx.lineTo(x, y) : wctx.moveTo(x, y)
  }
  wctx.stroke()
  wctx.fillStyle = '#8b93a0'; wctx.font = '10px monospace'
  wctx.fillText('\\u00b1' + m.toFixed(3), 6, 12)
}
function drawSpec(s, lo, hi) {
  const W = specC.width, H = specC.height, TOP = -10, BOT = -90
  sctx.clearRect(0, 0, W, H)
  sctx.fillStyle = '#8b93a0'; sctx.font = '10px monospace'
  for (const f of [100, 1000, 10000]) {
    const x = Math.log(f / lo) / Math.log(hi / lo) * W
    sctx.fillRect(x, 0, 1, H)
    sctx.fillText(f >= 1000 ? (f/1000) + 'k' : f, x + 3, H - 4)
  }
  if (!s.length) return
  sctx.strokeStyle = '#e0a06a'; sctx.lineWidth = 1.3; sctx.beginPath()
  for (let i = 0; i < s.length; i++) {
    const x = i / (s.length - 1) * W
    const y = (TOP - Math.max(BOT, Math.min(TOP, s[i]))) / (TOP - BOT) * H
    i ? sctx.lineTo(x, y) : sctx.moveTo(x, y)
  }
  sctx.stroke()
}
function renderData(d) {
  const pk = document.getElementById('peak')
  pk.textContent = d.peakDb === null || d.peakDb < -120 ? '-inf' : d.peakDb.toFixed(1) + ' dBFS'
  pk.className = d.peakDb > -3 ? 'warn' : 'v'
  document.getElementById('rms').textContent = d.rmsDb < -120 ? '-inf' : d.rmsDb.toFixed(1) + ' dBFS'
  document.getElementById('pitch').textContent = d.f0 ? d.f0.toFixed(1) + ' Hz (' + noteName(d.f0) + ')' : '—'
  drawWave(d.wave)
  drawSpec(d.spec, d.specLo || 30, d.specHi || 16000)
}
let usingWs = false
function connectWs() {
  const ws = new WebSocket('ws://' + location.host + '/')
  ws.binaryType = 'arraybuffer'
  ws.onmessage = (e) => {
    usingWs = true
    document.getElementById('status').textContent = ''
    const f = new Float32Array(e.data)
    const waveLen = f[3], specLen = f[4]
    renderData({
      peakDb: f[0], rmsDb: f[1], f0: f[2],
      wave: f.subarray(5, 5 + waveLen),
      spec: f.subarray(5 + waveLen, 5 + waveLen + specLen),
    })
  }
  ws.onclose = ws.onerror = () => {
    usingWs = false
    document.getElementById('status').textContent = 'reconnecting…'
    setTimeout(connectWs, 2000)
  }
}
async function tick() {
  if (!usingWs) {
    try {
      const r = await fetch('/scope.json', { cache: 'no-store' })
      renderData(await r.json())
      document.getElementById('status').textContent = '(polling fallback)'
    } catch {
      document.getElementById('status').textContent = 'disconnected — is calib scope running?'
    }
  }
  setTimeout(tick, 100)
}
connectWs()
tick()
</script></body></html>`
