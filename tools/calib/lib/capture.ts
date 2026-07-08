/*
 * Audio capture via ffmpeg's avfoundation input. One spawned ffmpeg process
 * per capture, writing float32 WAV. Devices are addressed by NAME (persisted
 * in calib/rig.json) and resolved to an avfoundation index at runtime, since
 * indices shuffle as devices come and go.
 *
 * Absolute capture-start timing is deliberately loose: the measurement
 * protocol derives all timing from audio onsets within a capture (see
 * docs/hardware-calibration.md), so `onRecording` only needs to fire before
 * the stimulus is sent, never at a precise instant.
 */
import { spawn } from 'node:child_process'

export interface AudioDevice {
  index: number
  name: string
}

/** Parse `ffmpeg -f avfoundation -list_devices true` audio section. */
export async function listAudioDevices(): Promise<AudioDevice[]> {
  const stderr = await new Promise<string>((resolve) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''])
    let out = ''
    p.stderr.on('data', (d: Buffer) => (out += d.toString()))
    p.on('close', () => resolve(out))
    p.on('error', () => resolve(out))
  })
  const devices: AudioDevice[] = []
  let inAudio = false
  for (const line of stderr.split('\n')) {
    if (line.includes('AVFoundation audio devices')) {
      inAudio = true
      continue
    }
    if (line.includes('AVFoundation video devices')) {
      inAudio = false
      continue
    }
    if (!inAudio) continue
    const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/)
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

/**
 * Stream continuous mono float32 PCM from the device to `onChunk` until
 * stop() is called. Used by the realtime scope; measurements always use
 * recordWav.
 */
export function streamPcm(
  deviceIndex: number,
  onChunk: (samples: Float32Array) => void,
  sampleRate = 48000,
): { stop: () => void } {
  const p = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'avfoundation',
    '-thread_queue_size',
    '4096',
    '-i',
    `:${deviceIndex}`,
    '-ac',
    '1',
    '-ar',
    String(sampleRate),
    '-f',
    'f32le',
    '-',
  ])
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

export interface RecordOpts {
  deviceIndex: number
  seconds: number
  outPath: string
  channels?: number // default 2
  sampleRate?: number // default 48000
  /** Fires once ffmpeg has opened the input and is rolling (approximate). */
  onRecording?: () => void
}

/** Record a WAV; resolves when ffmpeg exits cleanly, rejects with stderr tail. */
export function recordWav(opts: RecordOpts): Promise<void> {
  const { deviceIndex, seconds, outPath } = opts
  const channels = opts.channels ?? 2
  const sampleRate = opts.sampleRate ?? 48000
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-hide_banner',
      '-y',
      '-f',
      'avfoundation',
      '-thread_queue_size',
      '4096',
      '-i',
      `:${deviceIndex}`,
      '-ac',
      String(channels),
      '-ar',
      String(sampleRate),
      '-c:a',
      'pcm_f32le',
      '-t',
      String(seconds),
      outPath,
    ])
    let stderr = ''
    let started = false
    p.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (!started && opts.onRecording && stderr.includes('Input #0')) {
        started = true
        // small grace period: input opened, first buffers in flight
        setTimeout(opts.onRecording, 150)
      }
    })
    p.on('error', (err) => reject(new Error(`ffmpeg failed to start: ${err.message}`)))
    p.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.split('\n').slice(-6).join('\n')}`))
    })
  })
}
