/*
 * Audio capture via the CoreAudio-native helper (native/calib-rec.swift),
 * compiled on demand with swiftc. Devices are addressed by NAME (persisted in
 * calib/rig.local.json) and resolved to HAL AudioDeviceIDs at runtime.
 *
 * History: this module originally shelled out to ffmpeg's avfoundation input,
 * which silently drops small chunks of the stream (measured up to ~7 losses/s
 * on a quartz-stable digital source while AVAudioEngine captured the same
 * device byte-clean — 2026-07-10). Never capture measurement audio through
 * avfoundation.
 *
 * Absolute capture-start timing is deliberately loose: the measurement
 * protocol derives all timing from audio onsets within a capture (see
 * docs/hardware-calibration.md), so `onRecording` only needs to fire before
 * the stimulus is sent, never at a precise instant.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NATIVE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../native')
const SRC = join(NATIVE_DIR, 'calib-rec.swift')
const BIN = join(NATIVE_DIR, '.bin/calib-rec')

/** Compile the helper if missing or older than its source; returns the binary path. */
export function ensureRecorder(): string {
  const srcTime = statSync(SRC).mtimeMs
  if (!existsSync(BIN) || statSync(BIN).mtimeMs < srcTime) {
    mkdirSync(dirname(BIN), { recursive: true })
    try {
      execFileSync('swiftc', ['-O', '-o', BIN, SRC], { stdio: 'pipe' })
    } catch (err) {
      throw new Error(
        `cannot compile the CoreAudio capture helper (needs Xcode command-line tools): ${
          err instanceof Error ? err.message : err
        }`,
      )
    }
  }
  return BIN
}

export interface AudioDevice {
  /** CoreAudio HAL AudioDeviceID */
  index: number
  name: string
}

export async function listAudioDevices(): Promise<AudioDevice[]> {
  const out = execFileSync(ensureRecorder(), ['list']).toString()
  const devices: AudioDevice[] = []
  for (const line of out.split('\n')) {
    const m = line.match(/^(\d+)\t(.+)$/)
    if (m) devices.push({ index: Number(m[1]), name: m[2] })
  }
  return devices
}

export async function resolveAudioDevice(nameMatch: string): Promise<AudioDevice> {
  const devices = await listAudioDevices()
  const needle = nameMatch.toLowerCase()
  const hit = devices.find((d) => d.name.toLowerCase().includes(needle))
  if (!hit) {
    const names = devices.map((d) => `[${d.index}] ${d.name}`).join(', ')
    throw new Error(`audio device matching "${nameMatch}" not found (available: ${names || 'none'})`)
  }
  return hit
}

export interface RecordOpts {
  deviceIndex: number
  seconds: number
  outPath: string
  channels?: number // default 2
  sampleRate?: number // default 48000
  /** Fires once the recorder is rolling (approximate). */
  onRecording?: () => void
}

/**
 * Record a WAV; resolves when the helper exits cleanly, rejects with stderr
 * tail. A short capture (transient CoreAudio stall — the helper detects and
 * reports it) is retried once before rejecting.
 */
export async function recordWav(opts: RecordOpts): Promise<void> {
  try {
    await recordWavOnce(opts)
  } catch (err) {
    if (!(err instanceof Error && err.message.includes('short capture'))) throw err
    await recordWavOnce(opts)
  }
}

function recordWavOnce(opts: RecordOpts): Promise<void> {
  const { deviceIndex, seconds, outPath } = opts
  const channels = opts.channels ?? 2
  const sampleRate = opts.sampleRate ?? 48000
  const bin = ensureRecorder()
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['rec', String(deviceIndex), String(seconds), String(sampleRate), String(channels), outPath])
    let stderr = ''
    let started = false
    const fireOnRecording = (): void => {
      if (!started && opts.onRecording) {
        started = true
        // small settle so captures keep a quiet pre-roll for the noise floor
        setTimeout(opts.onRecording, 250)
      }
    }
    p.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
      // the helper prints READY once the first audio buffer has landed
      if (stderr.includes('READY')) fireOnRecording()
    })
    setTimeout(fireOnRecording, 1500) // fallback if READY never arrives
    p.on('error', reject)
    p.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`calib-rec exited ${code}: ${stderr.split('\n').slice(-4).join('\n')}`))
    })
  })
}

/**
 * Stream continuous mono float32 PCM from the device to `onChunk` until
 * stop() is called. Used by the realtime scope; measurements use recordWav.
 */
export function streamPcm(
  deviceIndex: number,
  onChunk: (samples: Float32Array) => void,
  sampleRate = 48000,
): { stop: () => void } {
  const p = spawn(ensureRecorder(), ['stream', String(deviceIndex), String(sampleRate)])
  let pending: Buffer = Buffer.alloc(0)
  p.stdout.on('data', (d: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, d]) : d
    const usable = pending.length - (pending.length % 4)
    if (!usable) return
    const out = new Float32Array(usable / 4)
    for (let i = 0; i < out.length; i++) out[i] = pending.readFloatLE(i * 4)
    pending = Buffer.from(pending.subarray(usable)) // remainder is <4 bytes
    onChunk(out)
  })
  return {
    stop: () => {
      p.kill('SIGINT')
    },
  }
}
