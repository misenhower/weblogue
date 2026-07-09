/*
 * Unified monitor: one long-running page (calib monitor) that shows the
 * realtime scope (30 fps WebSocket, same as calib scope), the current
 * calibration run (calib run POSTs its state here when the monitor holds
 * the port), and the session history from calib/sessions/ — so results
 * outlive the run and the tab. Dependency-free node http, like live/scope.
 */
import { createServer, type Server } from 'node:http'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ScopeState, attachScopeWs } from './scope'
import type { LiveState, LivePoint } from './live'
import { calibDir } from './rig'

export const MONITOR_PORT = 8077

interface SessionInfo {
  name: string
  jobId: string
  domain: string
  date: string
  points: number
}

export function startMonitorServer(
  root: string,
  state: ScopeState,
  port = MONITOR_PORT,
): Promise<{ url: string; close: () => void } | null> {
  let run: LiveState | null = null
  const sessionsDir = join(calibDir(root), 'sessions')
  const infoCache = new Map<string, SessionInfo>()

  const listSessions = (): SessionInfo[] => {
    if (!existsSync(sessionsDir)) return []
    return readdirSync(sessionsDir)
      .filter((n) => existsSync(join(sessionsDir, n, 'features.json')))
      .sort()
      .reverse()
      .map((name) => {
        const hit = infoCache.get(name)
        if (hit) return hit
        let info: SessionInfo = { name, jobId: name, domain: '', date: '', points: 0 }
        try {
          const job = JSON.parse(readFileSync(join(sessionsDir, name, 'job.json'), 'utf8'))
          const feats = JSON.parse(readFileSync(join(sessionsDir, name, 'features.json'), 'utf8'))
          info = { name, jobId: job.id, domain: job.domain, date: name.slice(0, 16), points: feats.results?.length ?? 0 }
        } catch {
          /* partial/foreign dir: keep placeholder */
        }
        infoCache.set(name, info)
        return info
      })
  }

  /** A finished session re-shaped into the same state the live view renders. */
  const sessionState = (name: string): LiveState | null => {
    if (!/^[\w.:-]+$/.test(name)) return null
    try {
      const dir = join(sessionsDir, name)
      const job = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8'))
      interface RawResult {
        point: number | null
        hw: { cents?: number; centsSpread?: number; peakDbfs: number; harmonicsDb?: number[]; waveSnap?: number[] }
        rep: { cents?: number; harmonicsDb?: number[]; waveSnap?: number[] }
      }
      const feats = JSON.parse(readFileSync(join(dir, 'features.json'), 'utf8')) as { results: RawResult[] }
      const points: LivePoint[] = feats.results.map((r) => ({
        label: r.point === null ? 'base patch' : `${job.sweep?.param}=${r.point}`,
        raw: r.point,
        status: 'done',
        // non-tonal sessions (noise/envelope kinds) lack these fields — the
        // page renders blanks for undefined
        hwCents: r.hw.cents,
        repCents: r.rep.cents,
        hwSpread: r.hw.centsSpread,
        peakDbfs: r.hw.peakDbfs,
        ladder: (r.hw.harmonicsDb ?? [])
          .map((db, k): [number, number, number] => [k + 1, db, r.rep.harmonicsDb?.[k] ?? NaN])
          .slice(1),
        waveHw: r.hw.waveSnap,
        waveRep: r.rep.waveSnap,
      }))
      return {
        job: { id: job.id, domain: job.domain, description: job.description },
        phase: 'done',
        points,
        reportPath: join(dir, 'report.md'),
        updatedAt: '',
      }
    } catch {
      return null
    }
  }

  const srv: Server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (req.method === 'POST' && url.startsWith('/run-state')) {
      let body = ''
      req.on('data', (d: Buffer) => {
        body += d.toString()
        if (body.length > 4_000_000) req.destroy()
      })
      req.on('end', () => {
        try {
          run = JSON.parse(body) as LiveState
        } catch {
          /* ignore malformed */
        }
        res.writeHead(204)
        res.end()
      })
      return
    }
    if (url.startsWith('/state.json')) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ run, sessions: listSessions() }))
    } else if (url.startsWith('/session/')) {
      const s = sessionState(decodeURIComponent(url.slice('/session/'.length)))
      res.writeHead(s ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(s))
    } else if (url.startsWith('/scope.json')) {
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

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>calib monitor</title><style>
  body { background:#14161a; color:#d6dae0; font:13px/1.5 ui-monospace,Menlo,monospace; margin:0; padding:24px; max-width:820px; }
  h1 { font-size:15px; margin:0 0 2px; color:#fff; }
  .badge { display:inline-block; padding:1px 8px; border-radius:9px; font-size:11px; margin-left:8px; vertical-align:2px; }
  .run { background:#1d3a5f; color:#7fb5ff; } .done { background:#1d3f2a; color:#7fd89a; }
  .abort { background:#4a1f22; color:#ff8f8f; } .wait { background:#3a3320; color:#e0c36a; }
  .sub { color:#8b93a0; } .readout { margin:8px 0 10px; } .readout span { margin-right:22px; }
  .v { color:#7fb5ff; } .warn { color:#ff8f8f; }
  canvas { background:#191c21; border-radius:6px; display:block; margin-bottom:10px; }
  table { border-collapse:collapse; margin:10px 0 14px; }
  td, th { padding:3px 12px 3px 0; text-align:left; white-space:nowrap; }
  th { color:#8b93a0; font-weight:normal; border-bottom:1px solid #2a2e35; }
  .pending { color:#565d68; } .running { color:#7fb5ff; } .retry { color:#e0c36a; }
  .failed { color:#ff8f8f; } .ok { color:#d6dae0; }
  .num { font-variant-numeric:tabular-nums; }
  svg { background:#191c21; border-radius:6px; margin-top:6px; }
  .msg { color:#e0c36a; } .report { color:#7fd89a; }
  .legend span { margin-right:16px; } .dot { font-size:15px; }
  select { background:#191c21; color:#d6dae0; border:1px solid #2a2e35; border-radius:5px; font:inherit; padding:2px 6px; margin:14px 0 2px; }
  .divider { border-top:1px solid #2a2e35; margin:16px 0 12px; }
</style></head><body>
<h1>calib monitor <span id="phase" class="badge wait">idle</span></h1>
<div class="readout">
  <span>peak <span class="v" id="peak">—</span></span>
  <span>rms <span class="v" id="rms">—</span></span>
  <span>pitch <span class="v" id="pitch">—</span></span>
  <span class="sub" id="status"></span>
</div>
<canvas id="wave" width="760" height="170"></canvas>
<canvas id="spec" width="760" height="130"></canvas>
<div class="divider"></div>
<select id="sess"><option value="live">live / latest run</option></select>
<div class="sub" id="sub"></div>
<div id="body"></div>
<script>
// ---- scope (WebSocket push, poll fallback) --------------------------------
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
function renderScope(d) {
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
    renderScope({ peakDb: f[0], rmsDb: f[1], f0: f[2], wave: f.subarray(5, 5 + waveLen), spec: f.subarray(5 + waveLen, 5 + waveLen + specLen) })
  }
  ws.onclose = ws.onerror = () => {
    usingWs = false
    document.getElementById('status').textContent = 'scope reconnecting…'
    setTimeout(connectWs, 2000)
  }
}
async function scopeTick() {
  if (!usingWs) {
    try { renderScope(await (await fetch('/scope.json', { cache: 'no-store' })).json()) } catch {}
  }
  setTimeout(scopeTick, 200)
}
// ---- run / history view ---------------------------------------------------
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))
const fc = (v) => v === undefined ? '' : (v >= 0 ? '+' : '') + v.toFixed(1) + '\\u00a2'
function renderRun(s, live) {
  const phaseEl = document.getElementById('phase')
  if (!s) {
    phaseEl.textContent = 'idle'; phaseEl.className = 'badge wait'
    document.getElementById('sub').textContent = 'no runs yet'
    document.getElementById('body').innerHTML = ''
    return
  }
  const cls = { running:'run', 'silence-check':'run', starting:'run', restoring:'run', done:'done', aborted:'abort' }[s.phase] || 'wait'
  phaseEl.textContent = live ? s.phase : 'viewing: ' + s.job.id
  phaseEl.className = 'badge ' + (live ? cls : 'done')
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
function ladder(points) {
  const p = [...points].reverse().find(p => p.status === 'done' && p.ladder && p.ladder.length)
  if (!p) return ''
  let h = '<div class="sub" style="margin-top:14px">harmonics (' + esc(p.label) + ', dB re H1)</div><table><tr><th></th><th>hw</th><th>replica</th><th>\\u0394</th></tr>'
  for (const [k, hw, rep] of p.ladder) {
    h += '<tr><td>H' + k + '</td><td class="num">' + hw.toFixed(1) + '</td><td class="num">' + rep.toFixed(1) + '</td><td class="num">' + (hw - rep >= 0 ? '+' : '') + (hw - rep).toFixed(1) + '</td></tr>'
  }
  return h + '</table>'
}
// ---- state polling + history selector -------------------------------------
const sessCache = new Map()
let sessions = []
let lastRun = null
async function fetchSession(name) {
  if (sessCache.has(name)) return sessCache.get(name)
  try {
    const s = await (await fetch('/session/' + encodeURIComponent(name), { cache: 'no-store' })).json()
    if (s) sessCache.set(name, s)
    return s
  } catch { return null }
}
function syncSelect() {
  const sel = document.getElementById('sess')
  const cur = sel.value
  while (sel.options.length > 1) sel.remove(1)
  for (const s of sessions) {
    const o = document.createElement('option')
    o.value = s.name
    o.textContent = s.date.replace('T', ' ') + '  ' + s.jobId + '  (' + s.points + ' pt)'
    sel.appendChild(o)
  }
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur
}
async function stateTick() {
  try {
    const st = await (await fetch('/state.json', { cache: 'no-store' })).json()
    sessions = st.sessions || []
    if (st.run) lastRun = st.run
    syncSelect()
    const sel = document.getElementById('sess').value
    if (sel === 'live') {
      if (lastRun) renderRun(lastRun, true)
      else if (sessions.length) renderRun(await fetchSession(sessions[0].name), false)
      else renderRun(null, false)
    } else {
      renderRun(await fetchSession(sel), false)
    }
  } catch {
    document.getElementById('status').textContent = 'monitor disconnected'
  }
  setTimeout(stateTick, 1000)
}
connectWs()
scopeTick()
stateTick()
</script></body></html>`
