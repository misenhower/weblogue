/*
 * Live run monitor: a dependency-free localhost server on a fixed port. The
 * page polls /state.json every second and keeps the last state client-side,
 * so one browser tab left open shows results as they land, survives the gap
 * between runs ("waiting"), and reconnects when the next run starts.
 */
import { createServer, type Server } from 'node:http'

export const LIVE_PORT = 8077

export interface LivePoint {
  label: string
  /** the swept raw value, or null for non-sweep jobs */
  raw: number | null
  status: 'pending' | 'running' | 'retry' | 'done' | 'failed'
  hwCents?: number
  repCents?: number
  hwSpread?: number
  peakDbfs?: number
  /** [harmonic index k (1-based), hw dB, rep dB] for the ladder view */
  ladder?: [number, number, number][]
  /** normalized ~2.5-cycle waveform snapshots for the per-point mini-scopes */
  waveHw?: number[]
  waveRep?: number[]
  note?: string
}

export interface LiveState {
  job: { id: string; domain: string; description?: string }
  phase: 'starting' | 'silence-check' | 'running' | 'restoring' | 'done' | 'aborted'
  message?: string
  reportPath?: string
  points: LivePoint[]
  updatedAt: string
}

export interface LiveServer {
  url: string
  update(state: LiveState): void
  close(): void
}

/** Start the monitor; returns null if the port is taken (run continues without). */
export function startLiveServer(port = LIVE_PORT): Promise<LiveServer | null> {
  let state: LiveState | null = null
  const srv: Server = createServer((req, res) => {
    if (req.url?.startsWith('/state.json')) {
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      })
      res.end(JSON.stringify(state))
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE)
    }
  })
  return new Promise((resolve) => {
    srv.once('error', () => resolve(null))
    srv.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${port}/`,
        update: (s) => {
          state = s
        },
        close: () => srv.close(),
      })
    })
  })
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>calib live</title><style>
  body { background:#14161a; color:#d6dae0; font:13px/1.5 ui-monospace,Menlo,monospace; margin:0; padding:24px; }
  h1 { font-size:15px; margin:0 0 2px; color:#fff; }
  .sub { color:#8b93a0; margin-bottom:14px; }
  .badge { display:inline-block; padding:1px 8px; border-radius:9px; font-size:11px; margin-left:8px; vertical-align:2px; }
  .run { background:#1d3a5f; color:#7fb5ff; } .done { background:#1d3f2a; color:#7fd89a; }
  .abort { background:#4a1f22; color:#ff8f8f; } .wait { background:#3a3320; color:#e0c36a; }
  table { border-collapse:collapse; margin:10px 0 18px; }
  td, th { padding:3px 12px 3px 0; text-align:left; white-space:nowrap; }
  th { color:#8b93a0; font-weight:normal; border-bottom:1px solid #2a2e35; }
  .pending { color:#565d68; } .running { color:#7fb5ff; } .retry { color:#e0c36a; }
  .failed { color:#ff8f8f; } .ok { color:#d6dae0; }
  .num { font-variant-numeric:tabular-nums; }
  svg { background:#191c21; border-radius:6px; margin-top:6px; }
  .msg { color:#e0c36a; } .report { color:#7fd89a; }
  .legend span { margin-right:16px; } .dot { font-size:15px; }
</style></head><body>
<h1>calib <span id="phase" class="badge wait">waiting</span></h1>
<div class="sub" id="sub">no run yet — leave this tab open</div>
<div id="body"></div>
<script>
let last = null, alive = false
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))
const fc = (v) => v === undefined ? '' : (v >= 0 ? '+' : '') + v.toFixed(1) + '\\u00a2'
function render() {
  const phaseEl = document.getElementById('phase')
  if (!last) { phaseEl.textContent = 'waiting'; phaseEl.className = 'badge wait'; return }
  const s = last
  const cls = { running:'run', 'silence-check':'run', starting:'run', restoring:'run', done:'done', aborted:'abort' }[s.phase] || 'wait'
  phaseEl.textContent = alive ? s.phase : s.phase + ' (disconnected)'
  phaseEl.className = 'badge ' + (alive ? cls : 'wait')
  document.getElementById('sub').textContent = s.job.id + ' \\u2014 ' + s.job.domain + (s.job.description ? ' \\u2014 ' + s.job.description : '')
  const done = s.points.filter(p => p.status === 'done').length
  let h = ''
  if (s.message) h += '<div class="msg">' + esc(s.message) + '</div>'
  if (s.reportPath) h += '<div class="report">report: ' + esc(s.reportPath) + '</div>'
  h += '<table><tr><th></th><th>point</th><th>hw</th><th>replica</th><th>\\u0394</th><th>spread</th><th>peak</th><th></th></tr>'
  for (const p of s.points) {
    const icon = { pending:'\\u00b7', running:'\\u25b6', retry:'\\u21bb', done:'\\u2713', failed:'\\u2717' }[p.status]
    const d = p.hwCents !== undefined && p.repCents !== undefined ? fc(p.hwCents - p.repCents) : ''
    h += '<tr class="' + (p.status === 'done' ? 'ok' : p.status) + '"><td class="dot">' + icon + '</td><td>' + esc(p.label) + '</td>'
      + '<td class="num">' + fc(p.hwCents) + '</td><td class="num">' + fc(p.repCents) + '</td><td class="num">' + d + '</td>'
      + '<td class="num">' + (p.hwSpread !== undefined ? p.hwSpread.toFixed(1) + '\\u00a2' : '') + '</td>'
      + '<td class="num">' + (p.peakDbfs !== undefined ? p.peakDbfs.toFixed(1) + ' dBFS' : '') + '</td>'
      + '<td>' + esc(p.note || '') + '</td></tr>'
  }
  h += '</table><div class="sub">' + done + '/' + s.points.length + ' points done</div>'
  h += chart(s.points)
  h += thumbs(s.points)
  h += ladder(s.points)
  document.getElementById('body').innerHTML = h
}
function thumbs(points) {
  const ds = points.filter(p => p.status === 'done' && p.waveHw && p.waveHw.length)
  if (!ds.length) return ''
  let h = '<div class="sub" style="margin-top:14px"><span style="color:#7fb5ff">\\u2014 hardware</span> <span style="color:#e0a06a">\\u2014 replica</span> waveform snapshots (~2.5 cycles, normalized)</div>'
    + '<div style="display:flex;flex-wrap:wrap;gap:10px">'
  for (const p of ds) {
    const W = 200, H = 64
    const path = (w, col) => '<polyline fill="none" stroke="' + col + '" stroke-width="1.2" points="'
      + w.map((v, i) => (i / (w.length - 1) * W).toFixed(1) + ',' + (H / 2 - v * (H / 2 - 4)).toFixed(1)).join(' ') + '"/>'
    h += '<div><svg width="' + W + '" height="' + H + '" style="background:#191c21;border-radius:5px">'
      + path(p.waveHw, '#7fb5ff') + (p.waveRep ? path(p.waveRep, '#e0a06a') : '')
      + '</svg><div class="sub" style="margin:0;font-size:11px">' + esc(p.label) + '</div></div>'
  }
  return h + '</div>'
}
function chart(points) {
  const ds = points.filter(p => p.status === 'done' && p.hwCents !== undefined)
  if (ds.length < 2) return ''
  const xs = ds.map((p, i) => p.raw !== null ? p.raw : i)
  const ys = ds.flatMap(p => [p.hwCents, p.repCents])
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
  const W = 640, H = 220, L = 46, B = 24, T = 12, R = 12
  const sx = (x) => L + (x - x0) / Math.max(1e-9, x1 - x0) * (W - L - R)
  const sy = (y) => H - B - (y - y0) / Math.max(1e-9, y1 - y0) * (H - B - T)
  const path = (key, col) => '<polyline fill="none" stroke="' + col + '" stroke-width="1.5" points="'
    + ds.map((p, i) => sx(xs[i]).toFixed(1) + ',' + sy(p[key]).toFixed(1)).join(' ') + '"/>'
    + ds.map((p, i) => '<circle cx="' + sx(xs[i]).toFixed(1) + '" cy="' + sy(p[key]).toFixed(1) + '" r="2.5" fill="' + col + '"/>').join('')
  return '<div class="legend sub"><span style="color:#7fb5ff">\\u25cf hardware</span><span style="color:#e0a06a">\\u25cf replica</span> (cents)</div>'
    + '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">'
    + '<text x="4" y="' + (T + 8) + '" fill="#8b93a0" font-size="10">' + y1.toFixed(1) + '</text>'
    + '<text x="4" y="' + (H - B) + '" fill="#8b93a0" font-size="10">' + y0.toFixed(1) + '</text>'
    + '<text x="' + L + '" y="' + (H - 6) + '" fill="#8b93a0" font-size="10">' + x0 + '</text>'
    + '<text x="' + (W - R - 30) + '" y="' + (H - 6) + '" fill="#8b93a0" font-size="10">' + x1 + '</text>'
    + path('hwCents', '#7fb5ff') + path('repCents', '#e0a06a') + '</svg>'
}
function ladder(points) {
  const p = [...points].reverse().find(p => p.status === 'done' && p.ladder && p.ladder.length)
  if (!p) return ''
  let h = '<div class="sub" style="margin-top:14px">harmonics (' + esc(p.label) + ', dB re H1)</div><table><tr><th></th><th>hw</th><th>replica</th><th>\\u0394</th></tr>'
  for (const [k, hw, rep] of p.ladder) {
    h += '<tr><td>H' + k + '</td><td class="num">' + hw.toFixed(1) + '</td><td class="num">' + rep.toFixed(1) + '</td><td class="num">' + (hw - rep >= 0 ? '+' : '') + (hw - rep).toFixed(1) + '</td></tr>'
  }
  return h + '</table>'
}
async function tick() {
  try {
    const r = await fetch('/state.json', { cache: 'no-store' })
    const s = await r.json()
    if (s) last = s
    alive = true
  } catch { alive = false }
  render()
  setTimeout(tick, 1000)
}
tick()
</script></body></html>`
