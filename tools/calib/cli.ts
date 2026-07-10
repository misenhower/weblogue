/*
 * Calibration harness CLI (docs/hardware-calibration.md). Run from the repo
 * root via `npm run calib -- <command>`:
 *
 *   devices [--save]          list MIDI ports + audio devices; --save writes calib/rig.json
 *   check [--midi <match>] [--audio <match>] [--channel <1-16>] [--skip-audio]
 *                             rig smoke test: 6 steps, fail-fast with named fixes
 *
 * M1 scope: devices + check. Job runner / render / compare / fit land at M2+.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listPorts, MidiRig, sleep } from './lib/midi'
import { listAudioDevices, resolveAudioDevice, recordWav, streamPcm } from './lib/capture'
import { loadRig, saveRig, rigPath, calibDir, type RigConfig } from './lib/rig'
import {
  frameCurrentProgramDump,
  frameCurrentProgramRequest,
  parseXdSysex,
  FUNC_CURRENT_PROGRAM_DUMP,
  FUNC_ACK,
  FUNC_NAK_LOAD,
  FUNC_NAK_FORMAT,
} from './lib/sysex7'
import { readWav } from './lib/wav'
import { detectOnset, peakDbfs } from './lib/onset'
import { fftPeakHz, phasePitchTrack } from './lib/features'
import { initProgram } from '../../src/synths/xd/program'
import { P } from '../../src/synths/xd/params'
import { encodeProgBin, decodeProgBin, XD_PROG_BIN_SIZE } from '../../src/synths/xd/progbin'
import { loadJob, jobPoints, jobProgram, expandNotes, type CalibJob } from './lib/job'
import { type PointFeatures } from './lib/measure'
import { phaseJumps } from './lib/phasejump'
import { measureAny, buildProposals, sweepValues, summarize, jobKind, type AnyFeatures, type AnyResult } from './lib/domains'
import { renderJobPoint } from './lib/render'
import { createSession, saveJson, saveText } from './lib/session'
import { renderReport, type PointResult } from './lib/report'
import { startLiveServer, type LiveState } from './lib/live'
import { ScopeState, startScopeServer } from './lib/scope'
import { startMonitorServer, MONITOR_PORT } from './lib/monitor'

const ROOT = process.cwd()

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------
interface Args {
  cmd: string
  flags: Map<string, string | true>
  rest: string[]
}

function parseArgs(argv: string[]): Args {
  const cmd = argv[0] ?? 'help'
  const flags = new Map<string, string | true>()
  const rest: string[] = []
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      rest.push(a)
      continue
    }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(key, next)
      i++
    } else {
      flags.set(key, true)
    }
  }
  return { cmd, flags, rest }
}

function flagStr(args: Args, key: string): string | null {
  const v = args.flags.get(key)
  return typeof v === 'string' ? v : null
}

// ---------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------
const PASS = '✓'
const FAIL = '✗'
const SKIP = '−'

function step(n: number, total: number, label: string, status: string, detail: string): void {
  console.log(`${status} ${n}/${total} ${label.padEnd(16)} ${detail}`)
}

// ---------------------------------------------------------------------------
// devices
// ---------------------------------------------------------------------------
async function cmdDevices(args: Args): Promise<number> {
  const midi = listPorts()
  console.log('MIDI inputs: ', midi.inputs.length ? midi.inputs.join(' | ') : '(none)')
  console.log('MIDI outputs:', midi.outputs.length ? midi.outputs.join(' | ') : '(none)')
  const audio = await listAudioDevices()
  console.log(
    'Audio inputs:',
    audio.length ? audio.map((d) => `[${d.index}] ${d.name}`).join(' | ') : '(none)'
  )

  if (args.flags.has('save')) {
    const xdPort =
      midi.outputs.find((n) => /minilogue xd/i.test(n)) ??
      midi.outputs.find((n) => /minilogue|korg/i.test(n))
    if (!xdPort) {
      console.log(`\ncannot --save: no MIDI output matching "minilogue"/"korg" — plug the xd in first`)
      return 1
    }
    // store the device base name, not a full port name — MidiRig.open picks
    // the right SOUND/KBD-KNOB pair from it (Korg exposes 4 ports per device)
    const baseName = xdPort.replace(/\s+(SOUND|KBD\/KNOB|MIDI\s+(IN|OUT))\s*$/i, '')
    const iface = audio.find((d) =>
      /scarlett|focusrite|motu|umc|behringer|audient|steinberg|presonus|mackie|profx|interface/i.test(d.name)
    )
    const rig: RigConfig = {
      midiPort: baseName,
      midiChannel: 0,
      audioDevice: iface ? iface.name : null,
      notes: 'written by calib devices --save',
    }
    saveRig(ROOT, rig)
    console.log(`\nwrote ${rigPath(ROOT)}:`)
    console.log(JSON.stringify(rig, null, 2))
    if (!iface) console.log('audioDevice is null — set it once the interface is connected')
  }
  return 0
}

// ---------------------------------------------------------------------------
// check — the rig smoke test
// ---------------------------------------------------------------------------
async function cmdCheck(args: Args): Promise<number> {
  const rigCfg = loadRig(ROOT)
  const midiMatch = flagStr(args, 'midi') ?? rigCfg?.midiPort ?? 'minilogue xd'
  const audioMatch = flagStr(args, 'audio') ?? rigCfg?.audioDevice ?? null
  const chFlag = flagStr(args, 'channel')
  const ch = chFlag !== null ? Math.max(0, Math.min(15, Number(chFlag) - 1)) : (rigCfg?.midiChannel ?? 0)
  const skipAudio = args.flags.has('skip-audio')
  const TOTAL = 8
  let failures = 0

  // -- 1: MIDI port ----------------------------------------------------------
  let midi: MidiRig
  try {
    midi = MidiRig.open(midiMatch)
    step(1, TOTAL, 'MIDI port', PASS, `in "${midi.inName}", out "${midi.outName}", channel ${ch + 1}`)
  } catch (e) {
    step(1, TOTAL, 'MIDI port', FAIL, (e as Error).message)
    console.log('  fix: connect the xd over USB; check it appears in Audio MIDI Setup > MIDI Studio')
    return 1
  }

  // Edit-buffer backup: taken before anything is pushed, restored in finally
  // so the user's patch survives the check no matter which step fails.
  let backup: Uint8Array | null = null
  try {
    // -- 2: audible note -----------------------------------------------------
    midi.noteOn(60, 100, ch)
    await sleep(600)
    midi.noteOff(60, ch)
    step(2, TOTAL, 'test note', PASS, 'sent C4 for 600 ms — you should have heard the xd play')

    // -- 3: SysEx dump round-trip -------------------------------------------
    // Leaves the CALIB CHK test patch in the edit buffer for step 6.
    try {
      backup = await snapshotEditBuffer(midi, ch)
      const backupProg = decodeProgBin(backup)
      const prog = initProgram()
      prog.name = 'CALIB CHK'
      const sent = encodeProgBin(prog)
      const ackNote = await pushDump(midi, ch, sent)
      const read = await requestDump(midi, ch)
      let mismatches = 0
      const len = Math.max(read.length, sent.length)
      for (let i = 0; i < len; i++) if (read[i] !== sent[i]) mismatches++
      const readProg = decodeProgBin(read)
      const paramsEqual =
        !!readProg &&
        readProg.name === prog.name &&
        JSON.stringify(readProg.params) === JSON.stringify(prog.params)
      const sizes = `sent ${sent.length} B, got ${read.length} B (expected ${XD_PROG_BIN_SIZE})`
      const wasNote = backupProg ? `edit buffer was "${backupProg.name}"` : 'edit buffer decode failed'
      if (paramsEqual) {
        const byteNote = mismatches === 0 ? 'byte-identical' : `params identical, ${mismatches} non-param byte diffs`
        step(3, TOTAL, 'dump round-trip', PASS, `${sizes}; ${byteNote}; ${ackNote}; ${wasNote}`)
      } else {
        failures++
        step(3, TOTAL, 'dump round-trip', FAIL, `${sizes}; ${mismatches} byte mismatches, params differ; ${wasNote}`)
      }
    } catch (e) {
      failures++
      step(3, TOTAL, 'dump round-trip', FAIL, (e as Error).message)
      console.log('  fix: on the xd set GLOBAL > MIDI Route = USB, and check the global MIDI channel')
    }

    // -- 4: audio device -----------------------------------------------------
    if (skipAudio || !audioMatch) {
      step(4, TOTAL, 'audio device', SKIP, skipAudio ? '--skip-audio' : 'no audioDevice configured (calib/rig.json) — fine for M1')
      step(5, TOTAL, 'test capture', SKIP, 'needs the audio interface')
      step(6, TOTAL, 'note capture', SKIP, 'needs the audio interface')
      step(7, TOTAL, 'max level', SKIP, 'needs the audio interface')
      step(8, TOTAL, 'quartz integrity', SKIP, 'needs the audio interface')
      return failures ? 1 : 0
    }

    let deviceIndex: number
    try {
      const dev = await resolveAudioDevice(audioMatch)
      deviceIndex = dev.index
      step(4, TOTAL, 'audio device', PASS, `[${dev.index}] ${dev.name}`)
    } catch (e) {
      step(4, TOTAL, 'audio device', FAIL, (e as Error).message)
      console.log('  fix: connect the interface; check System Settings > Sound sees it')
      return 1
    }

    // -- 5: test capture ----------------------------------------------------
    const tmpDir = join(calibDir(ROOT), 'tmp')
    mkdirSync(tmpDir, { recursive: true })
    const silencePath = join(tmpDir, 'check-capture.wav')
    await recordWav({ deviceIndex, seconds: 3, outPath: silencePath })
    const silence = readWav(new Uint8Array(readFileSync(silencePath)))
    const floorDb = peakDbfs(silence.channels[0])
    const okFloor = floorDb < -40
    step(
      5,
      TOTAL,
      'test capture',
      okFloor ? PASS : FAIL,
      `3 s recorded at ${silence.sr} Hz, ${silence.channels.length} ch; peak ${floorDb.toFixed(1)} dBFS ${okFloor ? '(quiet, good)' : ''}`
    )
    if (!okFloor) {
      failures++
      console.log('  fix: expected near-silence with no note playing — lower the input gain or check for hum/bleed')
    }

    // -- 6: note through the capture path ------------------------------------
    const notePath = join(tmpDir, 'check-note.wav')
    const rec = recordWav({
      deviceIndex,
      seconds: 2.5,
      outPath: notePath,
      onRecording: () => {
        void (async () => {
          await sleep(400) // pre-roll for the noise floor
          midi.noteOn(69, 100, ch) // A4
          await sleep(1200)
          midi.noteOff(69, ch)
        })()
      },
    })
    await rec
    const note = readWav(new Uint8Array(readFileSync(notePath)))
    const x = note.channels[0]
    const onset = detectOnset(x, note.sr)
    if (!onset) {
      failures++
      step(6, TOTAL, 'note capture', FAIL, 'no onset detected — the note never reached the capture')
      console.log('  fix: xd OUTPUT -> interface line-in cable, input gain up, master volume up')
    } else {
      // the CALIB CHK init patch from step 3 is still loaded: saw at 8',
      // kbd octave centered, full sustain — note 69 must sound near 440 Hz
      const from = onset.sample + Math.floor(0.2 * note.sr)
      const coarse = fftPeakHz(x, from, 8192, note.sr)
      const track = phasePitchTrack(x, note.sr, coarse, { from, to: from + Math.floor(0.6 * note.sr) })
      const hz = median(Array.from(track.v))
      const cents = 1200 * Math.log2(hz / 440)
      const okPitch = Math.abs(cents) < 75
      step(
        6,
        TOTAL,
        'note capture',
        okPitch ? PASS : FAIL,
        `onset at ${((onset.sample / note.sr) * 1000).toFixed(0)} ms, peak ${onset.peakDbfs.toFixed(1)} dBFS, ` +
          `A4 via test patch: ${hz.toFixed(2)} Hz (${cents >= 0 ? '+' : ''}${cents.toFixed(1)} cents vs 440)`
      )
      if (!okPitch) {
        failures++
        console.log('  fix: pitch is far off the test patch expectation — check Master Tune / Program Tuning on the xd')
      }
    }

    // -- 7: max-level capture -------------------------------------------------
    // The loudest patch the protocol will ever play: UNISON stacks all 4
    // voices, every source at full level, drive 100%, filter open, low note
    // at full velocity. If this doesn't clip, no sweep will.
    const loud = initProgram()
    loud.name = 'CALIB MAX'
    const lp = loud.params
    lp[P.VOICE_MODE] = 2 // UNISON
    lp[P.VM_DEPTH] = 1023 // full unison detune — beat peaks are the worst case
    lp[P.VCO1_LEVEL] = 1023
    lp[P.VCO2_LEVEL] = 1023
    lp[P.VCO2_WAVE] = 2 // saw
    lp[P.MULTI_LEVEL] = 1023
    lp[P.DRIVE] = 2 // 100%
    lp[P.CUTOFF] = 1023
    lp[P.RESONANCE] = 0
    await pushDump(midi, ch, encodeProgBin(loud))
    const loudPath = join(tmpDir, 'check-loud.wav')
    await recordWav({
      deviceIndex,
      seconds: 2.5,
      outPath: loudPath,
      onRecording: () => {
        void (async () => {
          await sleep(400)
          midi.noteOn(36, 127, ch) // C2, full velocity
          await sleep(1200)
          midi.noteOff(36, ch)
        })()
      },
    })
    const loudWav = readWav(new Uint8Array(readFileSync(loudPath)))
    let clipped = 0
    let loudPeak = -Infinity
    for (const chan of loudWav.channels) {
      for (let i = 0; i < chan.length; i++) if (Math.abs(chan[i]) >= 0.999) clipped++
      loudPeak = Math.max(loudPeak, peakDbfs(chan))
    }
    const okLoud = clipped === 0 && loudPeak <= -1
    const lowNote = loudPeak < -18 ? ' — plenty of headroom; more gain would improve SNR' : ''
    step(
      7,
      TOTAL,
      'max level',
      okLoud ? PASS : FAIL,
      `UNISON 4-voice, all sources, drive 100%, C2 vel 127: peak ${loudPeak.toFixed(1)} dBFS, ` +
        `${clipped} clipped samples${okLoud ? `, ${(-loudPeak).toFixed(1)} dB headroom${lowNote}` : ''}`
    )
    if (!okLoud) {
      failures++
      console.log('  fix: this level would clip during sweeps — back the mixer input gain down and re-run')
    }

    // -- 8: quartz integrity ----------------------------------------------
    // The multiengine's VPM Sin1 is digitally clocked: ANY phase jump or
    // pitch wander in its capture is capture-path corruption. This is the
    // step that catches a lossy capture backend or USB path — median-pitch
    // checks (step 6) are blind to splices (learned 2026-07-10).
    const sinProg = initProgram()
    sinProg.name = 'CALIB SIN'
    const SIN1: ReadonlyArray<readonly [keyof typeof P, number]> = [
      ['VCO1_LEVEL', 0], ['VCO2_LEVEL', 0], ['MULTI_LEVEL', 1023],
      ['MULTI_TYPE', 1], ['SELECT_VPM', 0], ['SHAPE_VPM', 0], ['SHIFTSHAPE_VPM', 512],
      ['CUTOFF', 1023], ['RESONANCE', 0], ['DRIVE', 0],
      ['AMP_ATTACK', 0], ['AMP_SUSTAIN', 1023], ['AMP_RELEASE', 100],
      ['EG_INT', 512], ['LFO_INT', 512], ['AMP_VELOCITY', 0],
    ]
    for (const [k, v] of SIN1) sinProg.params[P[k]] = v
    await pushDump(midi, ch, encodeProgBin(sinProg))
    const sinPath = join(tmpDir, 'check-sin.wav')
    midi.noteOn(69, 100, ch)
    await sleep(200)
    await recordWav({ deviceIndex, seconds: 6, outPath: sinPath })
    midi.noteOff(69, ch)
    const sinWav = readWav(new Uint8Array(readFileSync(sinPath)))
    const sx = sinWav.channels[0]
    const sFrom = Math.round(0.5 * sinWav.sr)
    const sTo = sx.length - Math.round(0.2 * sinWav.sr)
    const sF0 = fftPeakHz(sx, sFrom, 16384, sinWav.sr)
    const sTrack = phasePitchTrack(sx, sinWav.sr, sF0, { from: sFrom, to: sTo })
    const sCents = Array.from(sTrack.v, (v) => 1200 * Math.log2(v / sF0))
    const sMean = sCents.reduce((a, b) => a + b, 0) / sCents.length
    const sSd = Math.sqrt(sCents.reduce((a, c) => a + (c - sMean) ** 2, 0) / sCents.length)
    const sPj = phaseJumps(sx, sinWav.sr, sF0, sFrom, sTo)
    const okSin = sPj.count <= 2 && sSd < 0.3
    step(
      8,
      TOTAL,
      'quartz integrity',
      okSin ? PASS : FAIL,
      `digital Sin1: f0 ${sF0.toFixed(2)} Hz, pitch sd ${sSd.toFixed(3)}¢, phase jumps ${sPj.count} in ${((sTo - sFrom) / sinWav.sr).toFixed(1)}s`
    )
    if (!okSin) {
      failures++
      console.log('  fix: capture path is corrupting audio — check USB path/adapter; never capture via ffmpeg avfoundation')
    }
    return failures ? 1 : 0
  } finally {
    midi.allNotesOff(ch)
    if (backup) {
      try {
        await pushDump(midi, ch, backup)
      } catch {
        console.log(
          `${FAIL} failed to restore the original edit buffer — it's saved in calib/backups/; ` +
            `re-push with: npm run calib -- restore`
        )
      }
    }
    midi.close()
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// ---------------------------------------------------------------------------
// scope — realtime waveform/spectrum monitor (PoC; ctrl-C to stop)
// ---------------------------------------------------------------------------
async function cmdScope(args: Args): Promise<number> {
  const rigCfg = loadRig(ROOT)
  const audioMatch = flagStr(args, 'audio') ?? rigCfg?.audioDevice
  if (!audioMatch) {
    console.log('no audio device configured — run: npm run calib -- devices --save')
    return 1
  }
  const dev = await resolveAudioDevice(audioMatch)
  const state = new ScopeState(48000)
  const srv = await startScopeServer(state)
  if (!srv) {
    console.log(`${FAIL} scope port already in use — is another calib scope running?`)
    return 1
  }
  const stream = streamPcm(dev.index, (chunk) => state.push(chunk))
  console.log(`scope on [${dev.index}] ${dev.name} — open ${srv.url}  (ctrl-C to stop)`)
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      stream.stop()
      srv.close()
      resolve()
    })
  })
  return 0
}

// ---------------------------------------------------------------------------
// compare — re-render the replica against a stored session's hardware
// features (run after hand-applying proposed values to curves.ts: residuals
// should collapse). accept — archive the session's proposals as the
// provenance record in calib/results/<domain>.json.
// ---------------------------------------------------------------------------
function resolveSession(name: string | undefined): string | null {
  if (!name) return null
  if (existsSync(join(name, 'features.json'))) return name
  const dir = join(calibDir(ROOT), 'sessions', name)
  return existsSync(join(dir, 'features.json')) ? dir : null
}

async function cmdCompare(args: Args): Promise<number> {
  const dir = resolveSession(args.rest[0])
  if (!dir) {
    console.log('usage: npm run calib -- compare <session-dir-or-name>  (must contain features.json)')
    return 1
  }
  const job = loadJob(join(dir, 'job.json'))
  const feats = JSON.parse(readFileSync(join(dir, 'features.json'), 'utf8')) as { results: AnyResult[] }
  const stored = feats.results
  // fresh replica render of every stored point with CURRENT curves.ts values
  const fresh: AnyResult[] = stored.map((r) => {
    const rend = renderJobPoint(job, r.point)
    return { point: r.point, hw: r.hw, rep: measureAny(rend.samples, rend.sr, rend.onsetSample, job) }
  })
  const { unit, values: hwV } = sweepValues(job, fresh, 'hw')
  const { values: nowV } = sweepValues(job, fresh, 'rep')
  const { values: thenV } = sweepValues(job, stored, 'rep')
  console.log(`\n${job.id} — replica vs stored hardware (${unit}); before = at capture time, after = current curves.ts\n`)
  console.log('| point | hardware | replica before | replica after | Δ before | Δ after |')
  console.log('|---|---|---|---|---|---|')
  const dev: { before: number; after: number }[] = []
  for (let i = 0; i < fresh.length; i++) {
    const [h, b, a] = [hwV[i], thenV[i], nowV[i]]
    if (h === null || b === null || a === null) continue
    const d = (r: number): string =>
      unit === '¢' ? `${r >= 0 ? '+' : ''}${r.toFixed(1)}¢` : `${r >= 0 ? '+' : ''}${(r * 100).toFixed(1)}%`
    const delta = (v: number): number => (unit === '¢' ? v - h : v / h - 1)
    dev.push({ before: delta(b), after: delta(a) })
    const fmt = (v: number): string => (unit === '¢' ? v.toFixed(1) : v.toPrecision(4))
    console.log(
      `| ${fresh[i].point ?? 'base'} | ${fmt(h)} | ${fmt(b)} | ${fmt(a)} | ${d(delta(b))} | ${d(delta(a))} |`,
    )
  }
  const rms = (xs: number[]): number => Math.sqrt(xs.reduce((s, v) => s + v * v, 0) / Math.max(1, xs.length))
  const before = rms(dev.map((d) => d.before))
  const after = rms(dev.map((d) => d.after))
  const p = (v: number): string => (unit === '¢' ? `${v.toFixed(1)}¢` : `${(v * 100).toFixed(1)}%`)
  console.log(`\nRMS deviation vs hardware: before ${p(before)} -> after ${p(after)} ${after < before ? '✓ closer' : '✗ NOT closer'}`)
  return after < before ? 0 : 1
}

async function cmdAccept(args: Args): Promise<number> {
  const dir = resolveSession(args.rest[0])
  if (!dir) {
    console.log('usage: npm run calib -- accept <session-dir-or-name>')
    return 1
  }
  const feats = JSON.parse(readFileSync(join(dir, 'features.json'), 'utf8')) as {
    domain: string
    proposals?: unknown[]
    measuredDate?: string
  }
  if (!feats.proposals?.length) {
    console.log(`${FAIL} session has no proposals to accept`)
    return 1
  }
  const outDir = join(calibDir(ROOT), 'results')
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, `${feats.domain}.json`)
  writeFileSync(
    outPath,
    JSON.stringify(
      { domain: feats.domain, measuredDate: feats.measuredDate, acceptedAt: new Date().toISOString(), session: dir, proposals: feats.proposals },
      null,
      2,
    ) + '\n',
  )
  console.log(`${PASS} accepted -> ${outPath} (commit this as the provenance record)`)
  return 0
}

// ---------------------------------------------------------------------------
// monitor — persistent scope + run dashboard + session history (ctrl-C stops)
// ---------------------------------------------------------------------------
async function cmdMonitor(args: Args): Promise<number> {
  const state = new ScopeState(48000)
  const srv = await startMonitorServer(ROOT, state)
  if (!srv) {
    console.log(`${FAIL} port ${MONITOR_PORT} already in use — another monitor or a run's dashboard is up`)
    return 1
  }
  // --no-audio: results/history/run views only (e.g. inside an IDE preview,
  // where macOS denies capture permission); the scope stays flatlined.
  let stream: { stop: () => void } | null = null
  if (!args.flags.has('no-audio')) {
    const rigCfg = loadRig(ROOT)
    const audioMatch = flagStr(args, 'audio') ?? rigCfg?.audioDevice
    if (!audioMatch) {
      console.log('no audio device configured — run: npm run calib -- devices --save')
      srv.close()
      return 1
    }
    const dev = await resolveAudioDevice(audioMatch)
    stream = streamPcm(dev.index, (chunk) => state.push(chunk))
    console.log(`monitor on [${dev.index}] ${dev.name} — open ${srv.url}  (ctrl-C to stop)`)
  } else {
    console.log(`monitor (no audio) — open ${srv.url}  (ctrl-C to stop)`)
  }
  console.log('runs started while the monitor is up appear on this page automatically')
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      stream?.stop()
      srv.close()
      resolve()
    })
  })
  return 0
}

// ---------------------------------------------------------------------------
// restore — push a saved edit-buffer snapshot back to the synth
// ---------------------------------------------------------------------------
async function cmdRestore(args: Args): Promise<number> {
  const rigCfg = loadRig(ROOT)
  const midiMatch = flagStr(args, 'midi') ?? rigCfg?.midiPort ?? 'minilogue xd'
  const chFlag = flagStr(args, 'channel')
  const ch = chFlag !== null ? Math.max(0, Math.min(15, Number(chFlag) - 1)) : (rigCfg?.midiChannel ?? 0)

  let file = flagStr(args, 'file')
  if (!file) {
    const dir = join(calibDir(ROOT), 'backups')
    const bins = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith('.bin'))
          .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)
      : []
    if (bins.length === 0) {
      console.log('no snapshots in calib/backups/ — nothing to restore')
      return 1
    }
    file = bins[0].path
  }
  const blob = new Uint8Array(readFileSync(file))
  const prog = decodeProgBin(blob)
  console.log(`pushing ${file} (${blob.length} B${prog ? `, "${prog.name}"` : ''}) to the edit buffer`)
  const midi = MidiRig.open(midiMatch)
  try {
    const ack = await pushDump(midi, ch, blob)
    const read = await requestDump(midi, ch)
    const same = read.length === blob.length && read.every((b, i) => b === blob[i])
    console.log(`${same ? PASS : FAIL} ${ack}; read-back ${same ? 'byte-identical' : 'DIFFERS'}`)
    return same ? 0 : 1
  } finally {
    midi.close()
  }
}

/** Request the edit buffer and persist it to calib/backups/ before any push. */
async function snapshotEditBuffer(midi: MidiRig, ch: number): Promise<Uint8Array> {
  const blob = await requestDump(midi, ch)
  const dir = join(calibDir(ROOT), 'backups')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  writeFileSync(join(dir, `edit-buffer-${stamp}.bin`), blob)
  return blob
}

/** Fire the job's note plan over MIDI (async, detached — timing from audio). */
function playNotes(midi: MidiRig, ch: number, job: CalibJob): void {
  const events: { at: number; on: boolean; midi: number; vel: number }[] = []
  for (const n of expandNotes(job)) {
    events.push({ at: n.onSec, on: true, midi: n.midi, vel: n.vel })
    events.push({ at: n.offSec, on: false, midi: n.midi, vel: 0 })
  }
  events.sort((a, b) => a.at - b.at)
  void (async () => {
    let prev = 0
    for (const e of events) {
      await sleep(Math.max(0, (e.at - prev) * 1000))
      prev = e.at
      if (e.on) midi.noteOn(e.midi, e.vel, ch)
      else midi.noteOff(e.midi, ch)
    }
  })()
}

// ---------------------------------------------------------------------------
// run — execute a measurement job: hardware capture + replica render + report
// ---------------------------------------------------------------------------
async function cmdRun(args: Args): Promise<number> {
  const name = args.rest[0]
  if (!name) {
    console.log('usage: npm run calib -- run <job|all> [--dry] [--midi m] [--audio a]')
    return 1
  }
  const jobsDir = join(ROOT, 'tools/calib/jobs')
  if (name === 'all') {
    let worst = 0
    for (const f of readdirSync(jobsDir).filter((f) => f.endsWith('.json')).sort()) {
      const path = join(jobsDir, f)
      const job = loadJob(path)
      console.log(`\n=== ${job.id} ===`)
      if (job.disabled) {
        console.log(`${SKIP} skipped: ${job.disabled}`)
        continue
      }
      try {
        worst = Math.max(worst, await runOneJob(args, path))
      } catch (err) {
        // a transient crash (e.g. a SysEx timeout) must not kill the suite
        console.log(`${FAIL} ${job.id} crashed: ${err instanceof Error ? err.message : err} — continuing`)
        worst = Math.max(worst, 1)
      }
    }
    return worst
  }
  const jobPath = existsSync(name) ? name : join(jobsDir, name.endsWith('.json') ? name : `${name}.json`)
  return runOneJob(args, jobPath)
}

async function runOneJob(args: Args, jobPath: string): Promise<number> {
  const job = loadJob(jobPath)
  if (job.disabled) {
    console.log(`${FAIL} job "${job.id}" is disabled: ${job.disabled}`)
    return 1
  }
  const points = jobPoints(job)
  const noteStr = job.notes.map((n) => `${n.midi}@${n.onSec}-${n.offSec}s`).join(', ')

  if (args.flags.has('dry')) {
    console.log(`job ${job.id} (${job.domain}): ${points.length} point(s), ${job.captureSec}s capture each`)
    for (const [i, pt] of points.entries()) {
      const label = pt === null ? 'base patch' : `${job.sweep!.param}=${pt}`
      console.log(`  ${i + 1}/${points.length}  push full patch (${label}) -> notes ${noteStr} -> record`)
    }
    console.log(`estimated wall-clock ~${Math.ceil(points.length * (job.captureSec + 2.5))}s + replica renders`)
    return 0
  }

  const rigCfg = loadRig(ROOT)
  const midiMatch = flagStr(args, 'midi') ?? rigCfg?.midiPort ?? 'minilogue xd'
  const ch = rigCfg?.midiChannel ?? 0
  const audioMatch = flagStr(args, 'audio') ?? rigCfg?.audioDevice
  if (!audioMatch) {
    console.log('no audio device configured — run: npm run calib -- devices --save')
    return 1
  }
  const dev = await resolveAudioDevice(audioMatch)
  const session = createSession(ROOT, job)
  console.log(`session ${session.dir}`)

  // live view: host our own dashboard on 8077, or — when a calib monitor
  // already owns that port — POST run state to it instead.
  const live = await startLiveServer()
  if (live) console.log(`live monitor: ${live.url}`)
  else console.log(`monitor detected on port ${MONITOR_PORT} — pushing run state there`)
  const liveState: LiveState = {
    job: { id: job.id, domain: job.domain, description: job.description },
    phase: 'silence-check',
    points: points.map((pt) => ({
      label: pt === null ? 'base patch' : `${job.sweep!.param}=${pt}`,
      raw: pt,
      status: 'pending',
    })),
    updatedAt: '',
  }
  const pushLive = (): void => {
    liveState.updatedAt = new Date().toISOString()
    const snap = { ...liveState, points: liveState.points.map((p) => ({ ...p })) }
    if (live) live.update(snap)
    else
      void fetch(`http://127.0.0.1:${MONITOR_PORT}/run-state`, {
        method: 'POST',
        body: JSON.stringify(snap),
      }).catch(() => {})
  }
  pushLive()

  // pre-run silence check: the capture bus must be quiet before we measure
  const silPath = join(session.rawDir, 'silence.wav')
  await recordWav({ deviceIndex: dev.index, seconds: 1.0, outPath: silPath })
  const sil = readWav(new Uint8Array(readFileSync(silPath)))
  const silPeak = peakDbfs(sil.channels[0])
  if (silPeak < -90) {
    console.log(`${FAIL} capture input is digitally silent (peak ${silPeak === -Infinity ? '-inf' : silPeak.toFixed(1)} dBFS)`)
    console.log('  fix: wrong audio device, muted USB send, or macOS denied capture permission to this terminal')
    liveState.phase = 'aborted'
    liveState.message = 'capture input digitally silent — device/permission problem'
    pushLive()
    await sleep(2500)
    live?.close()
    return 1
  }
  if (silPeak > -45) {
    console.log(`${FAIL} capture bus is not quiet: peak ${silPeak.toFixed(1)} dBFS with nothing playing (want < -45)`)
    console.log('  fix: mute other channels/sources on the mixer, stop any playback, then re-run')
    liveState.phase = 'aborted'
    liveState.message = `capture bus not quiet: ${silPeak.toFixed(1)} dBFS — mute other sources and re-run`
    pushLive()
    await sleep(2500)
    live?.close()
    return 1
  }
  console.log(`silence floor ${silPeak.toFixed(1)} dBFS peak — ok`)
  liveState.phase = 'running'
  pushLive()

  const midi = MidiRig.open(midiMatch)
  let backup: Uint8Array | null = null
  const results: AnyResult[] = []
  try {
    backup = await snapshotEditBuffer(midi, ch)
    for (const [i, pt] of points.entries()) {
      const label = pt === null ? 'base' : `${job.sweep!.param}=${pt}`
      const lp = liveState.points[i]
      lp.status = 'running'
      pushLive()
      await pushDump(midi, ch, encodeProgBin(jobProgram(job, pt)))
      const wavPath = join(session.rawDir, `point-${String(i).padStart(3, '0')}.wav`)
      const kind = jobKind(job)

      let hw: AnyFeatures | null = null
      for (let attempt = 1; hw === null; attempt++) {
        await recordWav({
          deviceIndex: dev.index,
          seconds: job.captureSec,
          outPath: wavPath,
          onRecording: () => playNotes(midi, ch, job),
        })
        try {
          const wav = readWav(new Uint8Array(readFileSync(wavPath)))
          const x = wav.channels[0]
          const onset = detectOnset(x, wav.sr)
          let onsetSample: number
          if (onset) {
            onsetSample = onset.sample
          } else if (kind === 'noise') {
            // a noise point can be legitimately near-silent (cutoff ~0):
            // fall back to the scheduled note time; window margins absorb
            // the capture-start skew and the PSD needs no ms precision
            onsetSample = Math.min(x.length - 1, Math.round((0.2 + job.notes[0].onSec) * wav.sr))
          } else {
            throw new Error('no onset found (silent capture?)')
          }
          if (onset && onset.peakDbfs > -1) throw new Error(`clipping: peak ${onset.peakDbfs.toFixed(1)} dBFS`)
          if (onset && onset.peakDbfs < -45 && kind !== 'noise')
            throw new Error(`very low signal: peak ${onset.peakDbfs.toFixed(1)} dBFS`)
          hw = measureAny(x, wav.sr, onsetSample, job)
          // phase-jump corruption gate (tonal only: needs a stable tone; the
          // envelope kind's amplitude ramps would starve the probes)
          if (kind === 'tonal') {
            const t = hw as PointFeatures
            const wFrom = onsetSample + Math.round(0.15 * wav.sr)
            const wTo = Math.min(x.length, onsetSample + Math.round((job.notes[0].offSec - job.notes[0].onSec - 0.1) * wav.sr))
            if (wTo - wFrom > 0.3 * wav.sr) {
              // strict gate: the CoreAudio backend captures a quartz source
              // with ZERO events (2026-07-10) — any events now are real
              // corruption. (The old ffmpeg/avfoundation backend dropped
              // chunks continuously; a looser rate gate briefly papered over
              // it. Never capture through avfoundation.)
              const pj = phaseJumps(x, wav.sr, t.f0Hz, wFrom, wTo)
              if (pj.count > 2) {
                hw = null
                throw new Error(`${pj.count} phase jumps — capture corruption (drops/splices)`)
              }
            }
            // analog voice spread is ~1-3 cents; far beyond that means the
            // capture timeline itself is broken (sample drops / rate conflict)
            if (hw && t.strikes.length > 1 && t.centsSpread > 8) {
              const spread = t.centsSpread.toFixed(1)
              hw = null
              throw new Error(`strike spread ${spread}¢ — capture dropouts suspected (device rate conflict? other apps on the interface?)`)
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (attempt >= 2) {
            // a failed point is data too (e.g. hardware silent at a SHAPE
            // endpoint) — record it and keep sweeping
            console.log(`${FAIL} point ${i + 1}/${points.length} ${label} failed twice: ${msg}`)
            lp.status = 'failed'
            lp.note = msg
            pushLive()
            break
          }
          console.log(`  point ${i + 1}: ${msg} — retrying once`)
          lp.status = 'retry'
          lp.note = msg
          pushLive()
        }
      }
      if (hw === null) continue

      const rep = renderJobPoint(job, pt)
      const repF = measureAny(rep.samples, rep.sr, rep.onsetSample, job)
      results.push({ point: pt, hw, rep: repF })
      lp.status = 'done'
      lp.note = ''
      lp.peakDbfs = hw.peakDbfs
      if (kind === 'tonal') {
        const t = hw as PointFeatures
        const tr = repF as PointFeatures
        lp.hwCents = t.cents
        lp.repCents = tr.cents
        lp.hwSpread = t.centsSpread
        lp.ladder = t.harmonicsDb
          .map((db, k): [number, number, number] => [k + 1, db, tr.harmonicsDb[k] ?? NaN])
          .slice(1)
        lp.waveHw = t.waveSnap
        lp.waveRep = tr.waveSnap
      } else {
        lp.note = `hw ${summarize(job, hw)} | rep ${summarize(job, repF)}`
      }
      pushLive()
      const spread =
        kind === 'tonal' && (hw as PointFeatures).strikes.length > 1
          ? ` ±${((hw as PointFeatures).centsSpread / 2).toFixed(1)}¢×${(hw as PointFeatures).strikes.length}`
          : ''
      console.log(
        `point ${i + 1}/${points.length} ${label} | peak ${hw.peakDbfs.toFixed(1)} dBFS | ` +
          `hw ${summarize(job, hw)}${spread} | replica ${summarize(job, repF)}`,
      )
    }
  } finally {
    if (backup) {
      try {
        await pushDump(midi, ch, backup)
      } catch {
        console.log(`${FAIL} failed to restore the edit buffer — re-push with: npm run calib -- restore`)
      }
    }
    midi.close()
  }

  const failed = liveState.points.filter((p) => p.status === 'failed')
  if (results.length === 0) {
    console.log(`${FAIL} run produced no usable points (${failed.length} failed) — raw captures kept in ${session.rawDir}`)
    liveState.phase = 'aborted'
    liveState.message = 'no usable points'
    pushLive()
    await sleep(2500)
    live?.close()
    return 1
  }
  if (failed.length) {
    console.log(`${FAIL} ${failed.length}/${points.length} points failed (kept in the report): ${failed.map((p) => p.label).join(', ')}`)
    liveState.message = `${failed.length} point(s) failed — see notes`
  }
  const proposals = buildProposals(job, results)
  const measuredDate = new Date().toISOString().slice(0, 10)
  saveJson(session.dir, 'features.json', {
    job: job.id,
    domain: job.domain,
    kind: jobKind(job),
    results,
    proposals,
    measuredDate,
  })
  const md = renderReport(
    job,
    results,
    { dir: session.dir },
    proposals.length ? { measuredDate, items: proposals } : undefined,
  )
  saveText(session.dir, 'report.md', md)
  console.log(`\nreport: ${join(session.dir, 'report.md')}\n`)
  console.log(md)
  liveState.phase = 'done'
  liveState.reportPath = join(session.dir, 'report.md')
  pushLive()
  await sleep(2500)
  live?.close()
  return failed.length ? 1 : 0
}

/** Request the edit buffer (func 10 -> 40); throws on timeout. */
async function requestDump(midi: MidiRig, ch: number, timeoutMs = 3000): Promise<Uint8Array> {
  const reply = midi.awaitSysEx(
    (m) => parseXdSysex(m)?.func === FUNC_CURRENT_PROGRAM_DUMP,
    timeoutMs
  )
  midi.send(frameCurrentProgramRequest(ch))
  try {
    return parseXdSysex(await reply)!.data
  } catch {
    throw new Error('no reply to CURRENT PROGRAM DATA DUMP REQUEST (func 10) within 3 s')
  }
}

/**
 * Push a program blob to the edit buffer (func 40); resolves with an ACK
 * description, throws on an explicit NAK. A silent (no-status) push is
 * tolerated — verify by reading back.
 */
async function pushDump(midi: MidiRig, ch: number, blob: Uint8Array): Promise<string> {
  const reply = midi.awaitSysEx((m) => {
    const p = parseXdSysex(m)
    return !!p && (p.func === FUNC_ACK || p.func === FUNC_NAK_LOAD || p.func === FUNC_NAK_FORMAT)
  }, 3000)
  midi.send(frameCurrentProgramDump(blob, ch))
  try {
    const ack = parseXdSysex(await reply)!
    if (ack.func !== FUNC_ACK) {
      throw new Error(`hardware rejected the dump push (status 0x${ack.func.toString(16)})`)
    }
    return 'ACK 0x23'
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('hardware rejected')) throw e
    return 'no ACK (firmware stayed silent)'
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  let code: number
  switch (args.cmd) {
    case 'devices':
      code = await cmdDevices(args)
      break
    case 'check':
      code = await cmdCheck(args)
      break
    case 'restore':
      code = await cmdRestore(args)
      break
    case 'run':
      code = await cmdRun(args)
      break
    case 'scope':
      code = await cmdScope(args)
      break
    case 'monitor':
      code = await cmdMonitor(args)
      break
    case 'compare':
      code = await cmdCompare(args)
      break
    case 'accept':
      code = await cmdAccept(args)
      break
    default:
      console.log(
        'usage: npm run calib -- <devices [--save] | check [...] | run <job|all> [--dry] | compare <session> | accept <session> | monitor [--audio a] | scope [--audio a] | restore [--file f]>'
      )
      code = args.cmd === 'help' ? 0 : 1
  }
  process.exit(code)
}

void main()
