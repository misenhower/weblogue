import { describe, expect, it } from 'vitest'
import { readWav, writeWav } from '../tools/calib/lib/wav'
import { detectOnset, peakDbfs } from '../tools/calib/lib/onset'

const SR = 48000

/** mulberry32 — deterministic fuzz (same pattern as engine.test.ts). */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), s | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Assemble a RIFF/WAVE blob from raw chunks, honoring odd-size pad bytes. */
function riff(chunks: ReadonlyArray<readonly [string, Uint8Array]>): Uint8Array {
  let total = 12
  for (const [, body] of chunks) total += 8 + body.length + (body.length & 1)
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  const putTag = (o: number, id: string) => {
    for (let i = 0; i < 4; i++) out[o + i] = id.charCodeAt(i)
  }
  putTag(0, 'RIFF')
  dv.setUint32(4, total - 8, true)
  putTag(8, 'WAVE')
  let o = 12
  for (const [id, body] of chunks) {
    putTag(o, id)
    dv.setUint32(o + 4, body.length, true)
    out.set(body, o + 8)
    o += 8 + body.length + (body.length & 1)
  }
  return out
}

/** Canonical 16-byte fmt chunk body. */
function fmtChunk(tag: number, ch: number, sr: number, bits: number): Uint8Array {
  const b = new Uint8Array(16)
  const dv = new DataView(b.buffer)
  dv.setUint16(0, tag, true)
  dv.setUint16(2, ch, true)
  dv.setUint32(4, sr, true)
  dv.setUint32(8, sr * ch * (bits >> 3), true)
  dv.setUint16(12, ch * (bits >> 3), true)
  dv.setUint16(14, bits, true)
  return b
}

function pcm16Data(samples: number[]): Uint8Array {
  const b = new Uint8Array(samples.length * 2)
  const dv = new DataView(b.buffer)
  for (let i = 0; i < samples.length; i++) dv.setInt16(i * 2, samples[i], true)
  return b
}

describe('writeWav -> readWav round-trip', () => {
  it('is sample-exact for stereo float32 at 48k', () => {
    const rng = makeRng(0xca11b)
    const n = 4321
    const l = new Float32Array(n)
    const r = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      l[i] = rng() * 2 - 1
      r[i] = rng() * 2 - 1
    }
    const back = readWav(writeWav([l, r], SR))
    expect(back.sr).toBe(SR)
    expect(back.channels.length).toBe(2)
    expect(back.channels[0]).toEqual(l)
    expect(back.channels[1]).toEqual(r)
  })
})

describe('readWav decoding', () => {
  it('decodes a hand-built canonical 44-byte PCM16 mono file', () => {
    const samples = [0, 16384, -16384, 32767, -32768]
    const dataLen = samples.length * 2
    const bytes = new Uint8Array(44 + dataLen)
    const dv = new DataView(bytes.buffer)
    const putTag = (o: number, id: string) => {
      for (let i = 0; i < 4; i++) bytes[o + i] = id.charCodeAt(i)
    }
    putTag(0, 'RIFF')
    dv.setUint32(4, 36 + dataLen, true)
    putTag(8, 'WAVE')
    putTag(12, 'fmt ')
    dv.setUint32(16, 16, true)
    dv.setUint16(20, 1, true) // PCM
    dv.setUint16(22, 1, true) // mono
    dv.setUint32(24, 44100, true)
    dv.setUint32(28, 44100 * 2, true)
    dv.setUint16(32, 2, true)
    dv.setUint16(34, 16, true)
    putTag(36, 'data')
    dv.setUint32(40, dataLen, true)
    for (let i = 0; i < samples.length; i++) dv.setInt16(44 + i * 2, samples[i], true)

    const w = readWav(bytes)
    expect(w.sr).toBe(44100)
    expect(w.channels.length).toBe(1)
    const ch = w.channels[0]
    expect(ch.length).toBe(samples.length)
    expect(ch[0]).toBe(0)
    expect(ch[1]).toBeCloseTo(0.5, 6)
    expect(ch[2]).toBeCloseTo(-0.5, 6)
    expect(ch[3]).toBeCloseTo(32767 / 32768, 6)
    expect(ch[4]).toBe(-1)
  })

  it('PCM24 scaling: 0x7fffff is just under 1.0, 0x800000 is -1.0', () => {
    // Little-endian 3-byte samples: 0x7fffff then 0x800000 (most negative).
    const data = new Uint8Array([0xff, 0xff, 0x7f, 0x00, 0x00, 0x80])
    const bytes = riff([
      ['fmt ', fmtChunk(1, 1, SR, 24)],
      ['data', data],
    ])
    const ch = readWav(bytes).channels[0]
    expect(ch.length).toBe(2)
    expect(ch[0]).toBeLessThan(1)
    expect(ch[0]).toBeGreaterThan(0.9999)
    expect(ch[1]).toBe(-1)
  })

  it('skips an odd-sized LIST chunk (with pad byte) before data', () => {
    const list = new Uint8Array([0x49, 0x4e, 0x46, 0x4f, 1, 2, 3]) // 7 bytes
    const bytes = riff([
      ['fmt ', fmtChunk(1, 1, 22050, 16)],
      ['LIST', list],
      ['data', pcm16Data([1000, -1000])],
    ])
    const w = readWav(bytes)
    expect(w.sr).toBe(22050)
    expect(w.channels[0].length).toBe(2)
    expect(w.channels[0][0]).toBeCloseTo(1000 / 32768, 6)
    expect(w.channels[0][1]).toBeCloseTo(-1000 / 32768, 6)
  })

  it('throws a clear error on unsupported format tags', () => {
    const bytes = riff([
      ['fmt ', fmtChunk(2, 1, SR, 16)], // 2 = ADPCM, unsupported
      ['data', pcm16Data([0])],
    ])
    expect(() => readWav(bytes)).toThrow(/unsupported format/)
  })

  it('rejects non-RIFF input', () => {
    expect(() => readWav(new Uint8Array(16))).toThrow(/RIFF/)
  })
})

describe('detectOnset', () => {
  it('finds a sine onset after a noisy pre-roll within +/-96 samples (2 ms)', () => {
    const rng = makeRng(7)
    const n = Math.round(0.5 * SR)
    const onsetAt = Math.round(0.3 * SR)
    const x = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      x[i] = (rng() * 2 - 1) * 1e-4
      if (i >= onsetAt) x[i] += 0.5 * Math.sin((2 * Math.PI * 1000 * (i - onsetAt)) / SR)
    }
    const o = detectOnset(x, SR)
    expect(o).not.toBeNull()
    expect(Math.abs(o!.sample - onsetAt)).toBeLessThanOrEqual(96)
    expect(o!.noiseFloorRms).toBeGreaterThan(0)
    expect(o!.noiseFloorRms).toBeLessThan(1e-4)
    expect(o!.peakDbfs).toBeCloseTo(-6.02, 1)
  })

  it('returns null for all-zero input', () => {
    expect(detectOnset(new Float32Array(SR), SR)).toBeNull()
  })

  it('returns null when noise never crosses the threshold', () => {
    const rng = makeRng(99)
    const x = new Float32Array(SR)
    for (let i = 0; i < x.length; i++) x[i] = (rng() * 2 - 1) * 1e-4
    expect(detectOnset(x, SR)).toBeNull()
  })
})

describe('peakDbfs', () => {
  it('is ~-6.02 dB for a 0.5-amplitude sine', () => {
    const x = new Float32Array(4800)
    for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR)
    expect(peakDbfs(x)).toBeCloseTo(-6.02, 1)
  })

  it('is -Infinity for all-zero input', () => {
    expect(peakDbfs(new Float32Array(64))).toBe(-Infinity)
  })
})
