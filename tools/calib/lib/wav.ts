/*
 * Minimal RIFF/WAVE codec for the calibration harness (tools/calib). Pure —
 * DataView over Uint8Array, no node Buffer — so the root tsc (DOM lib) can
 * typecheck it through the tests.
 *
 * readWav walks the chunk list properly: unknown chunks (LIST, fact, bext,
 * ...) are skipped, odd-sized chunks honor the RIFF pad byte, and fmt/data
 * may arrive in either order. Supported encodings: PCM16 / PCM24 / PCM32
 * (format tag 1) and IEEE float32 (format tag 3), any channel count (the
 * harness uses mono and stereo), plus the WAVE_FORMAT_EXTENSIBLE (0xfffe)
 * wrapper around either. Integer samples normalize to [-1, 1) by dividing by
 * 2^(bits-1). writeWav always emits interleaved IEEE float32.
 */

export interface WavData {
  channels: Float32Array[]
  sr: number
}

const FMT_PCM = 1
const FMT_FLOAT = 3
const FMT_EXTENSIBLE = 0xfffe

/** Read a 4-char chunk id at byte offset o. */
function tag4(bytes: Uint8Array, o: number): string {
  return String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3])
}

/** Write a 4-char chunk id at byte offset o. */
function putTag4(bytes: Uint8Array, o: number, id: string): void {
  for (let i = 0; i < 4; i++) bytes[o + i] = id.charCodeAt(i)
}

export function readWav(bytes: Uint8Array): WavData {
  if (bytes.length < 12 || tag4(bytes, 0) !== 'RIFF' || tag4(bytes, 8) !== 'WAVE') {
    throw new Error('readWav: not a RIFF/WAVE file')
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  let fmtTag = 0
  let numCh = 0
  let sr = 0
  let bits = 0
  let haveFmt = false
  let dataOff = -1
  let dataLen = 0

  // Chunk walk. Chunks are word-aligned: an odd body size carries a pad byte.
  let o = 12
  while (o + 8 <= bytes.length) {
    const id = tag4(bytes, o)
    const size = dv.getUint32(o + 4, true)
    const body = o + 8
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.length) {
        throw new Error('readWav: malformed fmt chunk')
      }
      fmtTag = dv.getUint16(body, true)
      numCh = dv.getUint16(body + 2, true)
      sr = dv.getUint32(body + 4, true)
      bits = dv.getUint16(body + 14, true)
      if (fmtTag === FMT_EXTENSIBLE) {
        // The real format tag is the first word of the SubFormat GUID.
        if (size < 40 || body + 26 > bytes.length) {
          throw new Error('readWav: malformed extensible fmt chunk')
        }
        fmtTag = dv.getUint16(body + 24, true)
      }
      haveFmt = true
    } else if (id === 'data' && dataOff < 0) {
      dataOff = body
      dataLen = Math.min(size, bytes.length - body) // tolerate truncated files
    }
    o = body + size + (size & 1)
  }

  if (!haveFmt) throw new Error('readWav: missing fmt chunk')
  if (dataOff < 0) throw new Error('readWav: missing data chunk')
  if (numCh < 1) throw new Error('readWav: fmt chunk declares zero channels')

  let decode: (p: number) => number
  if (fmtTag === FMT_FLOAT && bits === 32) {
    decode = p => dv.getFloat32(p, true)
  } else if (fmtTag === FMT_PCM && bits === 16) {
    decode = p => dv.getInt16(p, true) / 0x8000
  } else if (fmtTag === FMT_PCM && bits === 24) {
    decode = p => {
      const u = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16)
      return ((u << 8) >> 8) / 0x800000 // sign-extend 24 -> 32 bits
    }
  } else if (fmtTag === FMT_PCM && bits === 32) {
    decode = p => dv.getInt32(p, true) / 0x80000000
  } else {
    throw new Error(`readWav: unsupported format (tag ${fmtTag}, ${bits}-bit)`)
  }

  const bytesPer = bits >> 3
  const frameBytes = bytesPer * numCh
  const frames = Math.floor(dataLen / frameBytes)
  const channels: Float32Array[] = []
  for (let c = 0; c < numCh; c++) channels.push(new Float32Array(frames))
  for (let i = 0; i < frames; i++) {
    const base = dataOff + i * frameBytes
    for (let c = 0; c < numCh; c++) channels[c][i] = decode(base + c * bytesPer)
  }
  return { channels, sr }
}

export function writeWav(channels: Float32Array[], sr: number): Uint8Array {
  if (channels.length === 0) throw new Error('writeWav: no channels')
  const frames = channels[0].length
  for (const ch of channels) {
    if (ch.length !== frames) throw new Error('writeWav: channel length mismatch')
  }

  const numCh = channels.length
  const dataLen = frames * numCh * 4
  const out = new Uint8Array(44 + dataLen)
  const dv = new DataView(out.buffer)

  putTag4(out, 0, 'RIFF')
  dv.setUint32(4, 36 + dataLen, true)
  putTag4(out, 8, 'WAVE')
  putTag4(out, 12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, FMT_FLOAT, true)
  dv.setUint16(22, numCh, true)
  dv.setUint32(24, sr >>> 0, true)
  dv.setUint32(28, (sr * numCh * 4) >>> 0, true) // byte rate
  dv.setUint16(32, numCh * 4, true) // block align
  dv.setUint16(34, 32, true)
  putTag4(out, 36, 'data')
  dv.setUint32(40, dataLen, true)

  let p = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      dv.setFloat32(p, channels[c][i], true)
      p += 4
    }
  }
  return out
}
