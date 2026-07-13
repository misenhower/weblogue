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
import { loadJob, jobPoints } from './job'
import { alignSnaps, alignedCycleSnaps } from './measure-shape'
import { renderJobPoint } from './render'
import { measureAny, summarize, jobKind, ATTACK_RISE_FACTOR } from './domains'
import type { PointFeatures } from './measure'
import {
  envReviewCurve,
  FIT_FLOOR_DB,
  DISPLAYED_TCS,
  type EnvPointFeatures,
  type EnvReviewCurve,
  type EnvSegment,
} from './measure-env'
import { readWav } from './wav'
import { detectOnset } from './onset'
import { XD_PROFILES, setXdProfile } from '../../../src/synths/xd/profiles'

export const MONITOR_PORT = 8077

interface SessionInfo {
  name: string
  jobId: string
  domain: string
  date: string
  points: number
  /** points that produced no measurement (features.json pointFailures) */
  failed?: number
  /** measurement kind — the page shows envelope curves for kind 'envelope' */
  kind?: string
  /**
   * The profile the page should re-render the replica under BY DEFAULT for
   * this session: verification captures exist to be compared against the
   * CANDIDATE profile, not their capture-time baseline (Matt, 2026-07-13).
   * Looked up from the calib/verifications pairing artifact; before one
   * exists, '-verify' jobs fall back to the newest procedure-declaring
   * profile. The dropdown still lets the user override.
   */
  defaultProfile?: string
}

export function startMonitorServer(
  root: string,
  state: ScopeState,
  port = MONITOR_PORT,
): Promise<{ url: string; close: () => void } | null> {
  let run: LiveState | null = null
  const sessionsDir = join(calibDir(root), 'sessions')
  const infoCache = new Map<string, SessionInfo>()

  const verificationsDir = join(calibDir(root), 'verifications')
  let pairingSig = ''
  let pairing = new Map<string, string>() // verification session name -> candidate profile id
  const verificationPairing = (): Map<string, string> => {
    const files = existsSync(verificationsDir)
      ? readdirSync(verificationsDir).filter((n) => n.endsWith('.json'))
      : []
    const sig = files.join('|')
    if (sig === pairingSig) return pairing
    pairingSig = sig
    pairing = new Map()
    for (const f of files) {
      try {
        const a = JSON.parse(readFileSync(join(verificationsDir, f), 'utf8')) as {
          profile?: string
          verificationEvidence?: string
        }
        const name = a.verificationEvidence?.split('/').pop()
        if (name && a.profile) pairing.set(name, a.profile)
      } catch {
        /* not an artifact */
      }
    }
    return pairing
  }

  const listSessions = (): SessionInfo[] => {
    if (!existsSync(sessionsDir)) return []
    const pairs = verificationPairing()
    const newestCandidate = [...XD_PROFILES].reverse().find((p) => p.procedure)?.id
    const withDefault = (info: SessionInfo): SessionInfo => {
      const fromArtifact = pairs.get(info.name)
      const fallback = info.jobId.endsWith('-verify') ? newestCandidate : undefined
      const defaultProfile = fromArtifact ?? fallback
      return defaultProfile ? { ...info, defaultProfile } : info
    }
    return readdirSync(sessionsDir)
      .filter((n) => existsSync(join(sessionsDir, n, 'features.json')))
      .sort()
      .reverse()
      .map((name) => {
        const hit = infoCache.get(name)
        if (hit) return withDefault(hit)
        let info: SessionInfo = { name, jobId: name, domain: '', date: '', points: 0 }
        try {
          const job = JSON.parse(readFileSync(join(sessionsDir, name, 'job.json'), 'utf8'))
          const feats = JSON.parse(readFileSync(join(sessionsDir, name, 'features.json'), 'utf8'))
          info = {
            name,
            jobId: job.id,
            domain: job.domain,
            date: name.slice(0, 16),
            points: feats.results?.length ?? 0,
            failed: feats.pointFailures?.length ?? 0,
            kind: feats.kind ?? job.features?.kind ?? 'tonal',
          }
        } catch {
          /* partial/foreign dir: keep placeholder */
        }
        infoCache.set(name, info)
        return withDefault(info)
      })
  }

  /**
   * A finished session re-shaped into the same state the live view renders.
   * With `profile` set (a profiles.ts id), the replica columns are re-rendered
   * live under that calibration profile instead of the values stored at
   * capture time — synchronous engine renders, so first view of a long job
   * stalls the monitor for a few seconds; cached per (session, profile).
   */
  const stateCache = new Map<string, LiveState | null>()
  const sessionState = (name: string, profile?: string | null, debow = true): LiveState | null => {
    if (!/^[\w.:-]+$/.test(name)) return null
    const cacheKey = `${name}|${profile ?? ''}|${debow ? 'd' : 'r'}`
    const hit = stateCache.get(cacheKey)
    if (hit !== undefined) return hit
    let out: LiveState | null = null
    try {
      const dir = join(sessionsDir, name)
      const job = loadJob(join(dir, 'job.json'))
      interface RawResult {
        point: number | null
        hw: { cents?: number; centsSpread?: number; peakDbfs: number; harmonicsDb?: number[]; waveSnap?: number[] }
        rep: { cents?: number; harmonicsDb?: number[]; waveSnap?: number[] }
      }
      const feats = JSON.parse(readFileSync(join(dir, 'features.json'), 'utf8')) as {
        results: RawResult[]
        pointFailures?: { label: string; raw: number | null; error: string }[]
      }
      const reRender = !!profile && setXdProfile(profile)
      const points: LivePoint[] = feats.results.map((r) => {
        let rep = r.rep
        let note = ''
        if (reRender) {
          const rend = renderJobPoint(job, r.point)
          const f = measureAny(rend.samples, rend.sr, rend.onsetSample, job)
          rep = f as RawResult['rep']
          if (jobKind(job) !== 'tonal') {
            // non-tonal LivePoints carry their comparison in the note text
            note = `hw ${summarize(job, r.hw as never)} | rep ${summarize(job, f)}`
          }
        }
        return {
          label: r.point === null ? 'base patch' : `${job.sweep?.param}=${r.point}`,
          raw: r.point,
          status: 'done' as const,
          note,
          // non-tonal sessions (noise/envelope kinds) lack these fields — the
          // page renders blanks for undefined
          hwCents: r.hw.cents,
          repCents: (rep as PointFeatures).cents,
          hwSpread: r.hw.centsSpread,
          peakDbfs: r.hw.peakDbfs,
          ladder: (r.hw.harmonicsDb ?? [])
            .map((db, k): [number, number, number] => [k + 1, db, rep.harmonicsDb?.[k] ?? NaN])
            .slice(1),
          ...(() => {
            const hwF = r.hw as PointFeatures
            const repF = rep as PointFeatures
            const cyc = alignedCycleSnaps(hwF.shapeCycle, repF.shapeCycle, 200, debow)
            if (cyc) return { waveHw: cyc.hw, waveRep: cyc.rep }
            const al = alignSnaps(r.hw.waveSnap, rep.waveSnap)
            return { waveHw: al.hw, waveRep: al.rep }
          })(),
        }
      })
      if (reRender) setXdProfile('v0') // the monitor's resting state
      // failed points render red in history just like in the live view
      for (const f of feats.pointFailures ?? []) {
        points.push({ label: f.label, raw: f.raw, status: 'failed', note: f.error })
      }
      out = {
        job: { id: job.id, domain: job.domain, description: job.description },
        phase: 'done',
        points,
        reportPath: join(dir, 'report.md'),
        updatedAt: '',
      }
    } catch {
      out = null
    }
    stateCache.set(cacheKey, out)
    return out
  }

  interface EnvChartPoint {
    raw: number | null
    label: string
    /** dBFS of the curve's 0 dB reference (held level / post-onset peak) */
    refDbfs: number
    /** the fitted segment seconds as measured (attack: raw 10-90 rise) */
    fitSec: number | null
    /** single-exponential time constant for the overlay: displayed/3 */
    tauSec: number | null
    curve: EnvReviewCurve
    rep?: { fitSec: number | null; tauSec: number | null; curve: EnvReviewCurve }
  }
  interface EnvChartData {
    seg: EnvSegment
    noteDurSec: number
    fitFloorDb: number
    /** silence.wav RMS re each point's reference, [min, max] across points */
    noiseBandDb: [number, number] | null
    points: EnvChartPoint[]
  }

  /**
   * dB-vs-time review curves for an envelope-kind session, recomputed from
   * the KEPT RAW WAVs (like remeasure — the raws are the durable artifact, so
   * this needs no hardware and always reflects the current extractor). With
   * `profile` set, each point also gets a replica curve rendered under that
   * profile — synchronous engine renders, same first-view stall and the same
   * cache shape as the profile re-render above (debow only affects waveform
   * snapshots, so it is not part of this key).
   */
  const envCache = new Map<string, EnvChartData | null>()
  const sessionEnv = (name: string, profile?: string | null): EnvChartData | null => {
    if (!/^[\w.:-]+$/.test(name)) return null
    const repProfile = profile && XD_PROFILES.some((p) => p.id === profile) ? profile : null
    const cacheKey = `${name}|${repProfile ?? ''}`
    const hit = envCache.get(cacheKey)
    if (hit !== undefined) return hit
    let out: EnvChartData | null = null
    try {
      const dir = join(sessionsDir, name)
      const job = loadJob(join(dir, 'job.json'))
      if (jobKind(job) === 'envelope') {
        const seg = job.features.env ?? 'attack'
        const note = job.notes[0]
        const fitOf = (f: EnvPointFeatures): number | null =>
          seg === 'attack' ? f.attackSec : seg === 'decay' ? f.decayTimeSec : seg === 'release' ? f.releaseTimeSec : null
        // attack displays as a 1.3-charge (eg.ts), so raw rise -> displayed first
        const tauOf = (fitSec: number | null): number | null =>
          fitSec === null ? null : (seg === 'attack' ? fitSec / ATTACK_RISE_FACTOR : fitSec) / DISPLAYED_TCS
        let noiseRms: number | null = null
        const silence = join(dir, 'raw', 'silence.wav')
        if (existsSync(silence)) {
          const sx = readWav(readFileSync(silence)).channels[0]
          let acc = 0
          for (let i = 0; i < sx.length; i++) acc += sx[i] * sx[i]
          noiseRms = sx.length ? Math.sqrt(acc / sx.length) : null
        }
        const floors: number[] = []
        const points: EnvChartPoint[] = []
        const planned = jobPoints(job)
        for (let i = 0; i < planned.length; i++) {
          const id = String(i).padStart(3, '0')
          const retry = join(dir, 'raw', `point-${id}-retry.wav`)
          const plain = join(dir, 'raw', `point-${id}.wav`)
          const file = existsSync(retry) ? retry : existsSync(plain) ? plain : null
          if (!file) continue
          const wav = readWav(readFileSync(file))
          const x = wav.channels[0]
          const o = detectOnset(x, wav.sr)
          if (!o) continue
          const curve = envReviewCurve(x, wav.sr, o.sample, job, seg)
          if (!curve) continue
          const fitSec = fitOf(measureAny(x, wav.sr, o.sample, job) as EnvPointFeatures)
          const point: EnvChartPoint = {
            raw: planned[i],
            label: planned[i] === null ? 'base patch' : `${job.sweep!.param}=${planned[i]}`,
            refDbfs: 20 * Math.log10(curve.refRms),
            fitSec,
            tauSec: tauOf(fitSec),
            curve,
          }
          if (repProfile) {
            const rend = renderJobPoint(job, planned[i], repProfile)
            const rc = envReviewCurve(rend.samples, rend.sr, rend.onsetSample, job, seg)
            if (rc) {
              const rSec = fitOf(measureAny(rend.samples, rend.sr, rend.onsetSample, job) as EnvPointFeatures)
              point.rep = { fitSec: rSec, tauSec: tauOf(rSec), curve: rc }
            }
          }
          if (noiseRms !== null) floors.push(20 * Math.log10(noiseRms / curve.refRms))
          points.push(point)
        }
        if (points.length) {
          out = {
            seg,
            noteDurSec: note.offSec - note.onSec,
            fitFloorDb: FIT_FLOOR_DB,
            noiseBandDb: floors.length ? [Math.min(...floors), Math.max(...floors)] : null,
            points,
          }
        }
      }
    } catch {
      out = null
    }
    envCache.set(cacheKey, out)
    return out
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
      res.end(
        JSON.stringify({
          run,
          sessions: listSessions(),
          profiles: XD_PROFILES.map((p) => ({ id: p.id, name: p.name })),
        }),
      )
    } else if (url.startsWith('/session/')) {
      const [path, query] = url.split('?')
      const q = new URLSearchParams(query ?? '')
      const profile = q.get('profile')
      const s = sessionState(decodeURIComponent(path.slice('/session/'.length)), profile, q.get('debow') !== '0')
      res.writeHead(s ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(s))
    } else if (url.startsWith('/env/')) {
      const [path, query] = url.split('?')
      const q = new URLSearchParams(query ?? '')
      const e = sessionEnv(decodeURIComponent(path.slice('/env/'.length)), q.get('profile'))
      res.writeHead(e ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(e))
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
<select id="prof" title="re-render the replica columns under a calibration profile (history views only)"><option value="">replica: as captured</option></select>
<label class="sub" style="margin-left:10px" title="thumbnails show the synth's waveform (capture coupling inverted); untick for the raw bowed capture"><input type="checkbox" id="debow" checked> de-bow</label>
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
// ---- envelope-session curves (dB vs time, recomputed from raw WAVs) --------
const fmtSec = (v) => v === null || v === undefined ? 'n/a' : v < 1 ? (v * 1000).toFixed(1) + ' ms' : v.toFixed(2) + ' s'
function envCharts(e) {
  const zeroRef = { attack: 't=0 note-on \\u00b7 0 dB = held peak', decay: 't=0 note-on \\u00b7 0 dB = post-onset peak',
    release: 't=0 note-off \\u00b7 0 dB = held level', sustain: 't=0 note-on \\u00b7 0 dB = post-onset peak' }
  const yTop = 6
  const yBot = Math.min(-48, e.noiseBandDb ? Math.floor(e.noiseBandDb[0]) - 8 : -48)
  let h = '<div class="sub" style="margin-top:14px">' + esc(e.seg) + ' envelopes \\u2014 RMS follower 25 ms \\u00b7 ' + zeroRef[e.seg] + '</div>'
    + '<div class="legend sub"><span style="color:#7fb5ff">\\u2014 hardware</span><span style="color:#e0a06a">\\u2014 replica</span>'
    + '<span style="color:#7fd89a">\\u254c fitted exp (displayed/3 = \\u03c4)</span>'
    + '<span style="color:#e0c36a">\\u254c ' + e.fitFloorDb + ' dB fit floor</span>'
    + (e.noiseBandDb ? '<span style="color:#8b93a0">\\u2591 noise floor</span>' : '') + '</div>'
    + '<div style="display:flex;flex-wrap:wrap;gap:10px">'
  for (const p of e.points) h += envChart(p, e, yTop, yBot)
  return h + '</div>'
}
function envChart(p, e, yTop, yBot) {
  const W = 250, H = 150, L = 34, B = 16, T = 6, R = 8
  const tLast = p.curve.t[p.curve.t.length - 1]
  const cut = Math.max(e.noiseBandDb ? e.noiseBandDb[1] + 3 : -45, yBot + 6)
  let xMax
  if (e.seg === 'attack') {
    const i = p.curve.db.findIndex(v => v >= -1)
    xMax = i >= 0 ? p.curve.t[i] * 1.4 : e.noteDurSec
  } else {
    const i = p.curve.db.findIndex(v => v <= cut)
    xMax = i >= 0 ? Math.max(p.curve.t[i], 0.05) * 1.25 : tLast
    if (e.seg !== 'release') xMax = Math.min(xMax, e.noteDurSec)
  }
  xMax = Math.min(Math.max(xMax, 0.15), tLast)
  const sx = (t) => L + t / xMax * (W - L - R)
  const sy = (v) => T + (yTop - Math.max(yBot, Math.min(yTop, v))) / (yTop - yBot) * (H - B - T)
  const poly = (pts, col, dash) => '<polyline fill="none" stroke="' + col + '" stroke-width="1.2"'
    + (dash ? ' stroke-dasharray="4 3"' : '') + ' points="' + pts.join(' ') + '"/>'
  const curvePts = (c) => {
    const s = []
    for (let i = 0; i < c.t.length && c.t[i] <= xMax; i++) s.push(sx(c.t[i]).toFixed(1) + ',' + sy(c.db[i]).toFixed(1))
    return s
  }
  let g = '<svg width="' + W + '" height="' + H + '" style="background:#191c21;border-radius:5px">'
  if (e.noiseBandDb) {
    const yn1 = sy(e.noiseBandDb[1]), yn0 = sy(e.noiseBandDb[0])
    g += '<rect x="' + L + '" y="' + yn1.toFixed(1) + '" width="' + (W - L - R) + '" height="' + Math.max(1.5, yn0 - yn1).toFixed(1) + '" fill="#8b93a0" opacity="0.16"/>'
  }
  g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + sy(0).toFixed(1) + '" y2="' + sy(0).toFixed(1) + '" stroke="#2a2e35"/>'
  g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + sy(e.fitFloorDb).toFixed(1) + '" y2="' + sy(e.fitFloorDb).toFixed(1) + '" stroke="#e0c36a" stroke-dasharray="3 4" opacity="0.55"/>'
  if (p.tauSec) {
    // the fitted model: straight -8.686 dB/tau line (decay/release); attack is
    // the replica's 1.3-charge clipped at the held peak
    const m = []
    for (let i = 0; i <= 80; i++) {
      const t = xMax * i / 80
      const v = e.seg === 'attack'
        ? 20 * Math.log10(Math.max(1e-9, Math.min(1, 1.3 * (1 - Math.exp(-t / p.tauSec)))))
        : -8.6859 * t / p.tauSec
      m.push(sx(t).toFixed(1) + ',' + sy(v).toFixed(1))
      if (e.seg !== 'attack' && v < yBot) break
    }
    g += poly(m, '#7fd89a', true)
  }
  g += poly(curvePts(p.curve), '#7fb5ff', false)
  if (p.rep) g += poly(curvePts(p.rep.curve), '#e0a06a', false)
  g += '<text x="2" y="' + (sy(0) + 3).toFixed(1) + '" fill="#8b93a0" font-size="9">0</text>'
    + '<text x="2" y="' + (sy(e.fitFloorDb) + 3).toFixed(1) + '" fill="#8b93a0" font-size="9">' + e.fitFloorDb + '</text>'
    + '<text x="' + (W - R) + '" y="' + (H - 4) + '" fill="#8b93a0" font-size="9" text-anchor="end">' + fmtSec(xMax) + '</text></svg>'
  return '<div>' + g + '<div class="sub" style="margin:0;font-size:11px">' + esc(p.label) + ' \\u00b7 fit ' + fmtSec(p.fitSec)
    + (p.rep ? ' \\u00b7 rep ' + fmtSec(p.rep.fitSec) : '') + '</div></div>'
}
// ---- state polling + history selector -------------------------------------
const sessCache = new Map()
let sessions = []
let lastRun = null
let profilesSig = ''
let sessionsSig = ''
let lastView = null // skip re-rendering an unchanged view: rebuilding the DOM
                    // every poll reset open dropdowns and text selection
async function fetchSession(name, profile, debow) {
  const key = name + '|' + (profile || '') + '|' + (debow ? 'd' : 'r')
  if (sessCache.has(key)) return sessCache.get(key)
  try {
    const s = await (await fetch('/session/' + encodeURIComponent(name)
      + '?debow=' + (debow ? '1' : '0') + (profile ? '&profile=' + encodeURIComponent(profile) : ''), { cache: 'no-store' })).json()
    if (s) sessCache.set(key, s)
    return s
  } catch { return null }
}
const envCache = new Map()
async function fetchEnv(name, profile) {
  const key = name + '|' + (profile || '')
  if (envCache.has(key)) return envCache.get(key)
  try {
    const e = await (await fetch('/env/' + encodeURIComponent(name)
      + (profile ? '?profile=' + encodeURIComponent(profile) : ''), { cache: 'no-store' })).json()
    if (e) envCache.set(key, e)
    return e
  } catch { return null }
}
// envelope-kind history sessions get dB-vs-time curves appended below the
// table — fetched separately because the server recomputes them from the raw
// WAVs (and re-renders the replica when a profile is selected), which can
// take a while on first view
async function appendEnvCharts(name, profile, view) {
  const info = sessions.find(s => s.name === name)
  if (!info || info.kind !== 'envelope') return
  const holder = document.createElement('div')
  holder.innerHTML = '<div class="sub" style="margin-top:14px">extracting envelope curves from raw WAVs\\u2026</div>'
  document.getElementById('body').appendChild(holder)
  const e = await fetchEnv(name, profile)
  if (lastView !== view) return // user moved on while we were extracting
  holder.innerHTML = e ? envCharts(e) : '<div class="sub" style="margin-top:14px">envelope curves unavailable (no raw WAVs on disk?)</div>'
}
function syncSelect(profiles) {
  const sel = document.getElementById('sess')
  const prof = document.getElementById('prof')
  const pSig = JSON.stringify(profiles || [])
  if (pSig !== profilesSig && document.activeElement !== prof) {
    profilesSig = pSig
    while (prof.options.length > 1) prof.remove(1)
    for (const p of profiles || []) {
      const o = document.createElement('option')
      o.value = p.id
      o.textContent = 'replica: ' + p.name
      prof.appendChild(o)
    }
  }
  // never mutate the options while the user has the dropdown open/focused,
  // and only rebuild when the list actually changed
  const sSig = JSON.stringify(sessions)
  if (sSig === sessionsSig || document.activeElement === sel) return
  sessionsSig = sSig
  const cur = sel.value
  while (sel.options.length > 1) sel.remove(1)
  for (const s of sessions) {
    const o = document.createElement('option')
    o.value = s.name
    o.textContent = s.date.replace('T', ' ') + '  ' + s.jobId + '  (' + s.points + ' pt'
      + (s.failed ? ', \\u2717' + s.failed + ' FAILED' : '') + ')'
    sel.appendChild(o)
  }
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur
}
async function stateTick() {
  try {
    const st = await (await fetch('/state.json', { cache: 'no-store' })).json()
    sessions = st.sessions || []
    if (st.run) lastRun = st.run
    syncSelect(st.profiles)
    const sel = document.getElementById('sess').value
    const prof = document.getElementById('prof').value
    const debow = document.getElementById('debow').checked
    if (sel === 'live') {
      // live view: profile re-render doesn't apply (data comes from the run)
      const view = 'live|' + (lastRun ? lastRun.updatedAt : sessions.length ? sessions[0].name : '')
      if (view !== lastView) {
        lastView = view
        if (lastRun) renderRun(lastRun, true)
        else if (sessions.length) {
          renderRun(await fetchSession(sessions[0].name, '', debow), false)
          await appendEnvCharts(sessions[0].name, '', view)
        } else renderRun(null, false)
      }
    } else {
      const view = 'sess|' + sel + '|' + prof + '|' + debow
      if (view !== lastView) {
        lastView = view
        renderRun(await fetchSession(sel, prof, debow), false)
        await appendEnvCharts(sel, prof, view)
      }
    }
  } catch {
    document.getElementById('status').textContent = 'monitor disconnected'
  }
  setTimeout(stateTick, 1000)
}
document.getElementById('sess').addEventListener('change', () => {
  // verification sessions default the replica render to their CANDIDATE
  // profile — comparing them against the capture-time baseline misses the
  // point of the verification step; the user can still override.
  const s = sessions.find(x => x.name === document.getElementById('sess').value)
  if (s && s.defaultProfile) document.getElementById('prof').value = s.defaultProfile
  lastView = null
})
document.getElementById('prof').addEventListener('change', () => { lastView = null })
connectWs()
scopeTick()
stateTick()
</script></body></html>`
