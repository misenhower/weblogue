/*
 * tools/calib/lib/sysex7 — Korg 7<->8-bit SysEx codec + minilogue xd dump
 * framing: round-trip fuzz, length formula, framing/parsing, known vectors.
 */
import { describe, expect, it } from 'vitest'
import {
  FUNC_ACK,
  FUNC_CURRENT_PROGRAM_DUMP,
  FUNC_CURRENT_PROGRAM_REQUEST,
  FUNC_NAK_FORMAT,
  FUNC_NAK_LOAD,
  decode7,
  encode7,
  frameCurrentProgramDump,
  frameCurrentProgramRequest,
  parseXdSysex,
  xdSysexHeader,
} from '../tools/calib/lib/sysex7'
import { decodeProgBin, encodeProgBin } from '../src/synths/xd/progbin'
import { initProgram } from '../src/synths/xd/program'

/** mulberry32 — deterministic fuzz. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), s | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomBytes(n: number, rng: () => number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (rng() * 256) | 0
  return out
}

/** NOTE 1 grouping math: 8 MIDI bytes per full 7-byte set, lead + rest for a partial. */
function encodedLen(n: number): number {
  return 8 * Math.floor(n / 7) + (n % 7 ? 1 + (n % 7) : 0)
}

// -----------------------------------------------------------------------------
// encode7 / decode7
// -----------------------------------------------------------------------------
describe('encode7/decode7', () => {
  it('round-trips random buffers of assorted lengths', () => {
    const rng = makeRng(0x51e51e)
    for (const n of [1, 6, 7, 8, 700, 1024]) {
      const data = randomBytes(n, rng)
      expect(Array.from(decode7(encode7(data)))).toEqual(Array.from(data))
    }
  })

  it('emits only 7-bit-clean bytes', () => {
    const rng = makeRng(0xbadcafe)
    for (const n of [1, 6, 7, 8, 700, 1024]) {
      const enc = encode7(randomBytes(n, rng))
      expect(enc.every((b) => b <= 0x7f)).toBe(true)
    }
  })

  it('encoded length is 8*floor(n/7) + (n%7 ? 1+n%7 : 0)', () => {
    const rng = makeRng(0xdecade)
    for (const n of [1, 6, 7, 8, 700, 1024]) {
      expect(encode7(randomBytes(n, rng)).length).toBe(encodedLen(n))
    }
  })

  it('handles empty input', () => {
    expect(encode7(new Uint8Array(0)).length).toBe(0)
    expect(decode7(new Uint8Array(0)).length).toBe(0)
  })

  it('known vector: lead bit b0 carries the MSB of data byte 7n+0', () => {
    // NOTE 1: lead bits b6..b0 are labeled 7n+6,5,4,3,2,1,0 — so byte 0's
    // b7 lands in the lead's b0, and 0x80,0x01 -> lead 0x01, then low 7s.
    expect(Array.from(encode7(Uint8Array.from([0x80, 0x01])))).toEqual([0x01, 0x00, 0x01])
    expect(Array.from(decode7(Uint8Array.from([0x01, 0x00, 0x01])))).toEqual([0x80, 0x01])
  })
})

// -----------------------------------------------------------------------------
// Framing + parsing
// -----------------------------------------------------------------------------
describe('xd sysex framing', () => {
  it('xdSysexHeader is F0 42 3g 00 01 51', () => {
    expect(xdSysexHeader()).toEqual([0xf0, 0x42, 0x30, 0x00, 0x01, 0x51])
    expect(xdSysexHeader(15)).toEqual([0xf0, 0x42, 0x3f, 0x00, 0x01, 0x51])
  })

  it('frameCurrentProgramRequest builds header + 10 + F7', () => {
    expect(Array.from(frameCurrentProgramRequest(2))).toEqual([
      0xf0, 0x42, 0x32, 0x00, 0x01, 0x51, FUNC_CURRENT_PROGRAM_REQUEST, 0xf7,
    ])
  })

  it('full blob: init program survives frame -> parse -> decodeProgBin', () => {
    const prog = initProgram()
    const bin = encodeProgBin(prog)
    expect(bin.length).toBe(1024)

    const msg = frameCurrentProgramDump(bin, 3)
    expect(msg[0]).toBe(0xf0)
    expect(msg[2]).toBe(0x33)
    expect(msg[6]).toBe(FUNC_CURRENT_PROGRAM_DUMP)
    expect(msg[msg.length - 1]).toBe(0xf7)
    expect(msg.length).toBe(6 + 1 + encodedLen(bin.length) + 1)
    // everything between F0 and F7 must be MIDI-data safe
    expect(msg.subarray(1, msg.length - 1).every((b) => b <= 0x7f)).toBe(true)

    const parsed = parseXdSysex(msg)
    expect(parsed).not.toBeNull()
    expect(parsed!.func).toBe(FUNC_CURRENT_PROGRAM_DUMP)
    expect(Array.from(parsed!.data)).toEqual(Array.from(bin))

    const back = decodeProgBin(parsed!.data)
    expect(back).not.toBeNull()
    expect(back!.params).toEqual(prog.params)
  })
})

describe('parseXdSysex', () => {
  it('accepts any channel 0-15', () => {
    for (let ch = 0; ch < 16; ch++) {
      const parsed = parseXdSysex(frameCurrentProgramRequest(ch))
      expect(parsed).not.toBeNull()
      expect(parsed!.func).toBe(FUNC_CURRENT_PROGRAM_REQUEST)
      expect(parsed!.data.length).toBe(0)
    }
  })

  it('parses status replies (NOTE 2) with empty data', () => {
    for (const func of [FUNC_ACK, FUNC_NAK_LOAD, FUNC_NAK_FORMAT]) {
      const parsed = parseXdSysex([...xdSysexHeader(9), func, 0xf7])
      expect(parsed).not.toBeNull()
      expect(parsed!.func).toBe(func)
      expect(parsed!.data.length).toBe(0)
    }
  })

  it('rejects non-xd and malformed sysex', () => {
    const ack = [...xdSysexHeader(0), FUNC_ACK, 0xf7]
    expect(parseXdSysex(ack)).not.toBeNull() // sanity: the template parses
    const swap = (i: number, v: number) => ack.map((b, j) => (j === i ? v : b))
    expect(parseXdSysex(swap(0, 0x00))).toBeNull() // no F0
    expect(parseXdSysex(swap(1, 0x41))).toBeNull() // wrong manufacturer
    expect(parseXdSysex(swap(2, 0x40))).toBeNull() // not a 3g byte
    expect(parseXdSysex(swap(3, 0x01))).toBeNull() // wrong header body
    expect(parseXdSysex(swap(4, 0x00))).toBeNull()
    expect(parseXdSysex(swap(5, 0x2c))).toBeNull() // minilogue og id, not xd
    expect(parseXdSysex(ack.slice(0, ack.length - 1))).toBeNull() // no EOX
    expect(parseXdSysex([])).toBeNull()
    expect(parseXdSysex([0xf0, 0xf7])).toBeNull() // too short
  })
})
