/*
 * Minimal ZIP reader/writer for Korg library containers (.mnlgxdlib,
 * .mnlgxdprog, .prlgprog, ... are all plain ZIP archives, a few KB each).
 * Zero dependencies: inflate/deflate via the platform's
 * DecompressionStream/CompressionStream ('deflate-raw').
 *
 * Reader: central-directory driven (sizes/offsets from the CD, which is
 * authoritative), supports methods 0 (stored) and 8 (deflate) — everything
 * Korg's librarian and common zip tools emit.
 * Writer: deflates every entry, zeroed DOS timestamps (deterministic output).
 */

export interface ZipEntry {
  name: string
  data: Uint8Array
}

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

/* ------------------------------------------------------------------ */
/* CRC-32 (standard polynomial, table-driven)                          */
/* ------------------------------------------------------------------ */

const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/* ------------------------------------------------------------------ */
/* stream helpers                                                      */
/* ------------------------------------------------------------------ */

async function pipeBytes(data: Uint8Array, ts: GenericTransformStream): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ts)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return pipeBytes(data, new DecompressionStream('deflate-raw'))
}

function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return pipeBytes(data, new CompressionStream('deflate-raw'))
}

/* ------------------------------------------------------------------ */
/* read                                                                */
/* ------------------------------------------------------------------ */

/** Parse a ZIP archive. Throws on malformed input or unsupported methods. */
export async function unzip(bytes: Uint8Array): Promise<ZipEntry[]> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  // EOCD: scan backwards (comment can pad the tail, max 64KB).
  let eocd = -1
  const stop = Math.max(0, bytes.length - 22 - 0xffff)
  for (let i = bytes.length - 22; i >= stop; i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (no end-of-central-directory)')

  const count = dv.getUint16(eocd + 10, true)
  let pos = dv.getUint32(eocd + 16, true) // central directory offset

  const entries: ZipEntry[] = []
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(pos, true) !== SIG_CENTRAL) throw new Error('corrupt ZIP central directory')
    const method = dv.getUint16(pos + 10, true)
    const compSize = dv.getUint32(pos + 20, true)
    const nameLen = dv.getUint16(pos + 28, true)
    const extraLen = dv.getUint16(pos + 30, true)
    const commentLen = dv.getUint16(pos + 32, true)
    const localOff = dv.getUint32(pos + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen))
    pos += 46 + nameLen + extraLen + commentLen

    // Local header: its name/extra lengths can differ from the CD's.
    if (dv.getUint32(localOff, true) !== SIG_LOCAL) throw new Error('corrupt ZIP local header')
    const lNameLen = dv.getUint16(localOff + 26, true)
    const lExtraLen = dv.getUint16(localOff + 28, true)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const raw = bytes.subarray(dataStart, dataStart + compSize)

    if (name.endsWith('/')) continue // directory entry
    if (method === 0) entries.push({ name, data: raw.slice() })
    else if (method === 8) entries.push({ name, data: await inflateRaw(raw) })
    else throw new Error(`unsupported ZIP compression method ${method} for ${name}`)
  }
  return entries
}

/* ------------------------------------------------------------------ */
/* write                                                               */
/* ------------------------------------------------------------------ */

/** Build a ZIP archive (deflate, zeroed timestamps). */
export async function zip(entries: readonly ZipEntry[]): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const e of entries) {
    const nameB = enc.encode(e.name)
    const crc = crc32(e.data)
    const comp = await deflateRaw(e.data)

    const local = new Uint8Array(30 + nameB.length)
    const ldv = new DataView(local.buffer)
    ldv.setUint32(0, SIG_LOCAL, true)
    ldv.setUint16(4, 20, true) // version needed
    ldv.setUint16(8, 8, true) // method: deflate
    ldv.setUint32(14, crc, true)
    ldv.setUint32(18, comp.length, true)
    ldv.setUint32(22, e.data.length, true)
    ldv.setUint16(26, nameB.length, true)
    local.set(nameB, 30)
    parts.push(local, comp)

    const cd = new Uint8Array(46 + nameB.length)
    const cdv = new DataView(cd.buffer)
    cdv.setUint32(0, SIG_CENTRAL, true)
    cdv.setUint16(4, 20, true) // version made by
    cdv.setUint16(6, 20, true) // version needed
    cdv.setUint16(10, 8, true) // method
    cdv.setUint32(16, crc, true)
    cdv.setUint32(20, comp.length, true)
    cdv.setUint32(24, e.data.length, true)
    cdv.setUint16(28, nameB.length, true)
    cdv.setUint32(42, offset, true)
    cd.set(nameB, 46)
    central.push(cd)

    offset += local.length + comp.length
  }

  let cdSize = 0
  for (const c of central) cdSize += c.length
  const eocd = new Uint8Array(22)
  const edv = new DataView(eocd.buffer)
  edv.setUint32(0, SIG_EOCD, true)
  edv.setUint16(8, entries.length, true)
  edv.setUint16(10, entries.length, true)
  edv.setUint32(12, cdSize, true)
  edv.setUint32(16, offset, true)

  const total = offset + cdSize + 22
  const out = new Uint8Array(total)
  let p = 0
  for (const part of [...parts, ...central, eocd]) {
    out.set(part, p)
    p += part.length
  }
  return out
}
