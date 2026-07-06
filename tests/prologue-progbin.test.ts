/*
 * prologue prog_bin codec tests — the Korg librarian binary format
 * (docs/hardware/prologue_MIDIImp.txt TABLE 3, 336 bytes: 'PROG' + name[12] +
 * global block + two 126-byte timbre blocks + 'PRED').
 *
 * The roundtrip contract: decodeProgBin(encodeProgBin(p)) serializes
 * identically to p for every factory preset and for fuzzed programs — the
 * replica's raw param ranges mirror hardware, so every modeled field maps
 * 1:1 (with documented +/-1 storage biases). Known non-roundtrip cases:
 *   - name: hardware stores 12 chars, the replica allows 16 — encode
 *     truncates (all factory names are <= 12).
 *   - seq.bpm below 30: hardware TEMPO floor is 300 (= 30.0 BPM).
 *   - replica-only params (RP.LF_COMP_*, RP.VOICE_CAP): not in the blob;
 *     decode leaves defaults (all factory presets use the defaults).
 *   - seq beyond bpm: the prologue has no SEQD section — steps/motion stay
 *     at initSeq() defaults on decode (factory presets never set them).
 */
import { describe, expect, it } from 'vitest'
import {
  decodeProgBin,
  encodeProgBin,
  PROG_BIN_SIZE,
  PROLOGUE_KORG_FILE,
  TUNING_TO_HW,
} from '../src/synths/prologue/progbin'
import { makePrologueDef } from '../src/synths/prologue/def'
import { FACTORY_PRESETS } from '../src/synths/prologue/presets'
import { PARAMS, P, RP, clampParam } from '../src/synths/prologue/params'
import { initProgram, serializeProgram } from '../src/synths/prologue/program'
import { MICRO_TUNINGS } from '../src/synths/prologue/curves'
import type { Program } from '../src/shared/program'

const magicAt = (bytes: Uint8Array, off: number) =>
  String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3])

/** Deterministic LCG for fuzz programs. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

describe('prologue prog_bin codec', () => {
  it('exposes the librarian identity', () => {
    expect(PROLOGUE_KORG_FILE.product).toBe('prologue')
    expect(PROLOGUE_KORG_FILE.infoTag).toBe('prologue_ProgramInformation')
    expect(PROLOGUE_KORG_FILE.progExt).toBe('prlgprog')
    expect(PROLOGUE_KORG_FILE.libExts).toEqual(['prlglib', 'prlgpreset'])
  })

  it('encodes exactly 336 bytes with PROG + PRED magics', () => {
    const bin = encodeProgBin(initProgram())
    expect(bin.length).toBe(PROG_BIN_SIZE)
    expect(bin.length).toBe(336)
    expect(magicAt(bin, 0)).toBe('PROG')
    expect(magicAt(bin, 332)).toBe('PRED')
  })

  it('roundtrips the init program', () => {
    const p = initProgram()
    const back = decodeProgBin(encodeProgBin(p))
    expect(back).not.toBeNull()
    expect(serializeProgram(back as Program)).toBe(serializeProgram(p))
  })

  it('roundtrips every factory preset byte-for-value', () => {
    expect(FACTORY_PRESETS.length).toBe(12)
    for (const preset of FACTORY_PRESETS) {
      const back = decodeProgBin(encodeProgBin(preset))
      expect(back, preset.name).not.toBeNull()
      expect(serializeProgram(back as Program), preset.name).toBe(serializeProgram(preset))
    }
  })

  it('rejects wrong magic', () => {
    const bin = encodeProgBin(initProgram())
    bin[0] = 'X'.charCodeAt(0)
    expect(decodeProgBin(bin)).toBeNull()
  })

  it('rejects wrong sizes', () => {
    const bin = encodeProgBin(initProgram())
    expect(decodeProgBin(bin.slice(0, 335))).toBeNull()
    expect(decodeProgBin(new Uint8Array([...bin, 0]))).toBeNull()
    expect(decodeProgBin(new Uint8Array(0))).toBeNull()
    // An xd-sized 'PROG' blob must not be accepted as a prologue program.
    const xdSized = new Uint8Array(1024)
    xdSized.set(bin.slice(0, 4), 0)
    expect(decodeProgBin(xdSized)).toBeNull()
  })

  it('clamps binary garbage into valid param ranges (no NaN, no out-of-range)', () => {
    const rand = lcg(0xbadc0de)
    const bin = new Uint8Array(PROG_BIN_SIZE)
    for (let i = 0; i < bin.length; i++) bin[i] = Math.floor(rand() * 256)
    bin.set([0x50, 0x52, 0x4f, 0x47], 0) // 'PROG'
    const p = decodeProgBin(bin)
    expect(p).not.toBeNull()
    for (const meta of PARAMS) {
      const v = (p as Program).params[meta.id]
      expect(Number.isFinite(v), meta.key).toBe(true)
      expect(v, meta.key).toBeGreaterThanOrEqual(meta.min)
      expect(v, meta.key).toBeLessThanOrEqual(meta.max)
    }
    const bpm = (p as Program).seq.bpm
    expect(bpm).toBeGreaterThanOrEqual(10)
    expect(bpm).toBeLessThanOrEqual(300)
  })

  it('truncates names to the hardware 12-char field on roundtrip', () => {
    const p = initProgram('SuperPadMachine') // 15 chars, replica allows 16
    const back = decodeProgBin(encodeProgBin(p)) as Program
    expect(back.name).toBe('SuperPadMach')
    // 12-char names survive exactly (all factory names are <= 12).
    const q = initProgram('Init Program')
    expect((decodeProgBin(encodeProgBin(q)) as Program).name).toBe('Init Program')
    // All-NUL name field: family normalization falls back to 'Program'.
    const blank = encodeProgBin(initProgram())
    blank.fill(0, 4, 16)
    expect((decodeProgBin(blank) as Program).name).toBe('Program')
  })

  it('roundtrips TEMPO to 0.1 BPM and clamps below the hardware 30.0 floor', () => {
    const p = initProgram()
    p.seq.bpm = 87.5
    expect((decodeProgBin(encodeProgBin(p)) as Program).seq.bpm).toBe(87.5)
    // Hardware TEMPO is 300~6000 = 30.0~600.0: replica BPM < 30 cannot be
    // represented and comes back as 30 (documented non-roundtrip).
    p.seq.bpm = 20
    expect((decodeProgBin(encodeProgBin(p)) as Program).seq.bpm).toBe(30)
  })

  it('stores 2-byte fields little-endian (raw bytes, not just roundtrip)', () => {
    // Symmetric encode/decode would hide a byte-order bug: pin LE with raw
    // bytes. TEMPO @24-25, 120.0 BPM = 1200 = 0x04B0 -> low byte first.
    const p = initProgram()
    p.seq.bpm = 120
    const bytes = encodeProgBin(p)
    expect(bytes[24]).toBe(0xb0)
    expect(bytes[25]).toBe(0x04)
  })

  it('maps every replica micro tuning onto a distinct hardware value and back', () => {
    expect(TUNING_TO_HW.length).toBe(MICRO_TUNINGS.length)
    expect(new Set(TUNING_TO_HW).size).toBe(TUNING_TO_HW.length)
    for (let i = 0; i < MICRO_TUNINGS.length; i++) {
      const p = initProgram()
      p.params[P.MICRO_TUNING] = i
      const back = decodeProgBin(encodeProgBin(p)) as Program
      expect(back.params[P.MICRO_TUNING], MICRO_TUNINGS[i].name).toBe(i)
    }
    // Hardware-only tunings (e.g. Ionian = P8 value 8, stored 9) decode to
    // Equal Temp rather than a wrong replica entry.
    const bin = encodeProgBin(initProgram())
    bin[51] = 9
    expect((decodeProgBin(bin) as Program).params[P.MICRO_TUNING]).toBe(0)
  })

  it('roundtrips the 1-biased menu fields at both range ends', () => {
    const edges: ReadonlyArray<readonly [number, number[]]> = [
      [P.SCALE_KEY, [0, 24]], // stored 1~25
      [P.PROGRAM_TUNING, [0, 100]], // stored 1~101
      [P.PROGRAM_TRANSPOSE, [0, 24]], // stored 1~25
      [P.ARP_GATE, [0, 72]], // stored 1~73
      [P.ARP_RATE, [0, 10]], // stored 1~11 (doc range 1~12)
      [P.DLRV_DRYWET, [0, 1024]], // stored 1~1025
      [P.ARP_RANGE, [1, 4]], // stored 0~3 of raw 0~15
    ]
    for (const [id, values] of edges) {
      for (const v of values) {
        const p = initProgram()
        p.params[id] = clampParam(id, v)
        const back = decodeProgBin(encodeProgBin(p)) as Program
        expect(back.params[id], `param ${id} = ${v}`).toBe(p.params[id])
      }
    }
  })

  it('roundtrips 50 fuzzed programs (every modeled field is stored)', () => {
    const rand = lcg(0x5eed)
    for (let n = 0; n < 50; n++) {
      const p = initProgram('Fuzz ' + n)
      for (const meta of PARAMS) {
        p.params[meta.id] = meta.min + Math.floor(rand() * (meta.max - meta.min + 1))
      }
      // Replica-only params are not in the blob; keep them at defaults so the
      // fuzz asserts the *modeled* fields (their absence is covered below).
      p.params[RP.LF_COMP_ON] = PARAMS[RP.LF_COMP_ON].def
      p.params[RP.LF_COMP_GAIN] = PARAMS[RP.LF_COMP_GAIN].def
      p.params[RP.VOICE_CAP] = PARAMS[RP.VOICE_CAP].def
      p.seq.bpm = Math.round(300 + rand() * 2700) / 10 // 30.0..300.0
      const back = decodeProgBin(encodeProgBin(p))
      expect(back, `fuzz ${n}`).not.toBeNull()
      expect(serializeProgram(back as Program), `fuzz ${n}`).toBe(serializeProgram(p))
    }
  })

  it('leaves replica-only params at their defaults on decode', () => {
    const p = initProgram()
    p.params[RP.LF_COMP_ON] = 1
    p.params[RP.LF_COMP_GAIN] = 512
    p.params[RP.VOICE_CAP] = 4
    const back = decodeProgBin(encodeProgBin(p)) as Program
    expect(back.params[RP.LF_COMP_ON]).toBe(PARAMS[RP.LF_COMP_ON].def)
    expect(back.params[RP.LF_COMP_GAIN]).toBe(PARAMS[RP.LF_COMP_GAIN].def)
    expect(back.params[RP.VOICE_CAP]).toBe(PARAMS[RP.VOICE_CAP].def)
  })

  it('is wired into both variant defs, with VOICE CAP capped per variant', () => {
    const d8 = makePrologueDef(8)
    const d16 = makePrologueDef(16)
    expect(d8.korgFile?.progExt).toBe('prlgprog')
    expect(d16.korgFile?.progExt).toBe('prlgprog')
    const bin = encodeProgBin(initProgram())
    const p8 = d8.korgFile!.decodeProgBin(bin) as Program
    const p16 = d16.korgFile!.decodeProgBin(bin) as Program
    expect(p8.synthId).toBe('prologue')
    expect(p16.synthId).toBe('prologue')
    expect(p8.params[RP.VOICE_CAP]).toBe(8)
    expect(p16.params[RP.VOICE_CAP]).toBe(16)
    expect(d8.korgFile!.decodeProgBin(new Uint8Array(10))).toBeNull()
  })
})
