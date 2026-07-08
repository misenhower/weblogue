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
import { listAudioDevices, resolveAudioDevice, recordWav } from './lib/capture'
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

const ROOT = process.cwd()

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------
interface Args {
  cmd: string
  flags: Map<string, string | true>
}

function parseArgs(argv: string[]): Args {
  const cmd = argv[0] ?? 'help'
  const flags = new Map<string, string | true>()
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(key, next)
      i++
    } else {
      flags.set(key, true)
    }
  }
  return { cmd, flags }
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
  const TOTAL = 7
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
      backup = await requestDump(midi, ch)
      // persist the snapshot BEFORE pushing anything: even a crash or a
      // yanked cable can't lose the user's edit state (calib restore re-pushes)
      const backupDir = join(calibDir(ROOT), 'backups')
      mkdirSync(backupDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      writeFileSync(join(backupDir, `edit-buffer-${stamp}.bin`), backup)
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
    default:
      console.log(
        'usage: npm run calib -- <devices [--save] | check [--midi m] [--audio a] [--channel 1-16] [--skip-audio] | restore [--file f]>'
      )
      code = args.cmd === 'help' ? 0 : 1
  }
  process.exit(code)
}

void main()
