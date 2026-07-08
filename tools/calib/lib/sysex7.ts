/*
 * Korg 7<->8-bit SysEx data codec + minilogue xd dump framing, per
 * docs/hardware/minilogue_xd_MIDIImp.txt. Pure module (no node imports) so
 * the root tsc can typecheck it via the tests.
 *
 * Bit convention (doc NOTE 1, ~line 1113): DATA 1Set = 8bit x 7Byte becomes
 * MIDI 1Set = 7bit x 8Byte. Each group of up to 7 data bytes is sent as one
 * LEAD byte followed by the low 7 bits of each data byte IN ORDER. The lead
 * byte's bit i (b0..b6) carries the MSB (b7) of following data byte 7n+i —
 * the doc labels the lead's b6..b0 as "7n+6,5,4,3,2,1,0". So
 * encode7([0x80, 0x01]) = [0x01, 0x00, 0x01]: lead b0 = MSB of data byte 0.
 * A partial trailing group is a lead byte + the remaining bytes, giving
 * encoded length 8*floor(n/7) + (n%7 ? 1+n%7 : 0).
 *
 * The doc's claimed dump payload size "384Bytes (7bit) -> 336Bytes (8bit)"
 * is a known erratum (the program blob is 1024 bytes -> 1171 MIDI bytes);
 * every length here is derived from the grouping math, never hardcoded.
 *
 * Framing (doc (1)/(4), NOTE 2): F0 42 3g 00 01 51 <func> [data] F7 with
 * g = global MIDI channel 0-15.
 */

// ---------------------------------------------------------------------------
// 7<->8-bit data conversion (NOTE 1)
// ---------------------------------------------------------------------------

/** Pack 8-bit data into MIDI-safe 7-bit sets: one lead-MSB byte per <=7 data bytes. */
export function encode7(data: Uint8Array): Uint8Array {
  const n = data.length
  const rem = n % 7
  const out = new Uint8Array(8 * Math.floor(n / 7) + (rem ? 1 + rem : 0))
  let o = 0
  for (let g = 0; g < n; g += 7) {
    const count = Math.min(7, n - g)
    const lead = o++
    for (let i = 0; i < count; i++) {
      const b = data[g + i]
      out[lead] |= (b >> 7) << i
      out[o++] = b & 0x7f
    }
  }
  return out
}

/** Inverse of encode7: rebuild 8-bit data from lead-MSB 7-bit sets. */
export function decode7(data: Uint8Array): Uint8Array {
  const m = data.length
  const rem = m % 8
  const out = new Uint8Array(7 * Math.floor(m / 8) + (rem ? rem - 1 : 0))
  let o = 0
  for (let g = 0; g < m; g += 8) {
    const count = Math.min(8, m - g) - 1
    const lead = data[g]
    for (let i = 0; i < count; i++) {
      out[o++] = (data[g + 1 + i] & 0x7f) | (((lead >> i) & 1) << 7)
    }
  }
  return out
}


// ---------------------------------------------------------------------------
// minilogue xd SysEx function bytes (doc (1), (4), NOTE 2)
// ---------------------------------------------------------------------------
export const FUNC_CURRENT_PROGRAM_DUMP = 0x40
export const FUNC_CURRENT_PROGRAM_REQUEST = 0x10
export const FUNC_ACK = 0x23 // DATA LOAD COMPLETED
export const FUNC_NAK_LOAD = 0x24 // DATA LOAD ERROR
export const FUNC_NAK_FORMAT = 0x26 // DATA FORMAT ERROR


// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/** EXCLUSIVE HEADER for the xd: F0 42 3g 00 01 51 (g = global MIDI channel). */
export function xdSysexHeader(channel = 0): number[] {
  return [0xf0, 0x42, 0x30 | (channel & 0x0f), 0x00, 0x01, 0x51]
}

/** CURRENT PROGRAM DATA DUMP (func 40): header + func + encode7(prog) + EOX. */
export function frameCurrentProgramDump(prog: Uint8Array, channel = 0): Uint8Array {
  const head = xdSysexHeader(channel)
  const body = encode7(prog)
  const out = new Uint8Array(head.length + 1 + body.length + 1)
  out.set(head, 0)
  out[head.length] = FUNC_CURRENT_PROGRAM_DUMP
  out.set(body, head.length + 1)
  out[out.length - 1] = 0xf7
  return out
}

/** CURRENT PROGRAM DATA DUMP REQUEST (func 10): header + func + EOX. */
export function frameCurrentProgramRequest(channel = 0): Uint8Array {
  return Uint8Array.from([...xdSysexHeader(channel), FUNC_CURRENT_PROGRAM_REQUEST, 0xf7])
}

/**
 * Parse an xd SysEx message: validates the F0 42 3g 00 01 51 header (any
 * channel g) and trailing EOX, returns the function byte plus the decoded
 * 8-bit body (empty for status/request messages). Null if not an xd sysex.
 */
export function parseXdSysex(
  msg: Uint8Array | readonly number[]
): { func: number; data: Uint8Array } | null {
  const n = msg.length
  if (n < 8) return null
  if (msg[0] !== 0xf0 || msg[1] !== 0x42 || (msg[2] & 0xf0) !== 0x30) return null
  if (msg[3] !== 0x00 || msg[4] !== 0x01 || msg[5] !== 0x51) return null
  if (msg[n - 1] !== 0xf7) return null
  const body =
    msg instanceof Uint8Array ? msg.subarray(7, n - 1) : Uint8Array.from(msg.slice(7, n - 1))
  return { func: msg[6], data: decode7(body) }
}
