/*
 * minilogue xd prog_bin codec tests: 1024-byte TABLE 2 layout, decode
 * validation, and encode->decode roundtrip over every factory preset.
 */
import { describe, expect, it } from 'vitest'
import { decodeProgBin, encodeProgBin, XD_KORG_FILE, XD_PROG_BIN_SIZE } from '../src/synths/xd/progbin'
import { XD_DEF } from '../src/synths/xd/def'
import { FACTORY_PRESETS } from '../src/synths/xd/presets'
import { initProgram, serializeProgram } from '../src/synths/xd/program'
import { P } from '../src/synths/xd/params'
import { MOTION_PITCH_BEND } from '../src/shared/paramdef'
import { GATE_TIE, NUM_STEPS, type Program } from '../src/shared/program'

const ARP_LATCH_DEFAULT = XD_DEF.params[P.ARP_LATCH].def // 0 = Off

/**
 * Roundtrip comparison. ARP LATCH is the one modeled parameter with no field
 * in the hardware blob (TABLE 2 covers offsets 0..1023 exhaustively and has
 * no latch row — the xd keeps latch as a global setting, not program data),
 * so decode always yields its default; everything else must match exactly.
 */
function expectRoundtrip(p: Program): void {
  const dec = decodeProgBin(encodeProgBin(p))
  expect(dec).not.toBeNull()
  const a = JSON.parse(serializeProgram(p))
  const bJson = JSON.parse(serializeProgram(dec as Program))
  expect(bJson.params.arpLatch).toBe(ARP_LATCH_DEFAULT)
  a.params.arpLatch = ARP_LATCH_DEFAULT
  expect(bJson).toEqual(a)
}

describe('xd prog_bin codec', () => {
  it('encodes a 1024-byte blob with PROG / PRED / SQ magics', () => {
    const b = encodeProgBin(initProgram())
    expect(b.length).toBe(XD_PROG_BIN_SIZE)
    const ascii = (off: number, len: number) => new TextDecoder().decode(b.slice(off, off + len))
    expect(ascii(0, 4)).toBe('PROG')
    expect(ascii(156, 4)).toBe('PRED')
    expect(ascii(160, 2)).toBe('SQ')
  })

  it('roundtrips the init program exactly (arp latch is Off by default)', () => {
    const p = initProgram()
    const dec = decodeProgBin(encodeProgBin(p))
    expect(dec).not.toBeNull()
    expect(serializeProgram(dec as Program)).toBe(serializeProgram(p))
  })

  it('roundtrips every factory preset (32) modulo the unstored arp latch', () => {
    expect(FACTORY_PRESETS.length).toBe(32)
    for (const p of FACTORY_PRESETS) expectRoundtrip(p)
  })

  it('rejects garbage: wrong magic', () => {
    expect(decodeProgBin(new Uint8Array(XD_PROG_BIN_SIZE))).toBeNull()
    const junk = new Uint8Array(XD_PROG_BIN_SIZE).fill(0xff)
    expect(decodeProgBin(junk)).toBeNull()
  })

  it('rejects wrong sizes even with a valid magic', () => {
    for (const size of [0, 4, 1023, 1025, 2048]) {
      const b = new Uint8Array(size)
      if (size >= 4) b.set([0x50, 0x52, 0x4f, 0x47]) // 'PROG'
      expect(decodeProgBin(b)).toBeNull()
    }
  })

  it('clamps in-range garbage bytes instead of producing out-of-range params', () => {
    const b = encodeProgBin(initProgram())
    b[41] = 15 // SELECT USER: hardware has 16 slots, replica has 4 stand-ins
    b[94] = 15 // MOD FX USER: replica has 2
    b[100] = 19 // DELAY SUB TYPE: USER slots 12..19 are not modeled
    b[106] = 17 // REVERB SUB TYPE: USER slots 10..17 are not modeled
    b[60] = 0xff // CUTOFF high byte: word decodes > 1023
    b[61] = 0xff
    const dec = decodeProgBin(b) as Program
    expect(dec.params[P.SELECT_USER]).toBe(3)
    expect(dec.params[P.MODFX_SUB_USER]).toBe(1)
    expect(dec.params[P.DELAY_SUB]).toBe(11)
    expect(dec.params[P.REVERB_SUB]).toBe(9)
    expect(dec.params[P.CUTOFF]).toBe(1023)
    for (let id = 0; id < XD_DEF.paramCount; id++) {
      const m = XD_DEF.params[id]
      expect(dec.params[id]).toBeGreaterThanOrEqual(m.min)
      expect(dec.params[id]).toBeLessThanOrEqual(m.max)
      expect(Number.isFinite(dec.params[id])).toBe(true)
    }
  })

  it('truncates names to the hardware 12-char field on roundtrip', () => {
    const p = initProgram('ABCDEFGHIJKLMNOP') // replica allows 16 chars
    const dec = decodeProgBin(encodeProgBin(p)) as Program
    expect(dec.name).toBe('ABCDEFGHIJKL')
    const short = initProgram('Init Program') // exactly 12: roundtrips whole
    expect((decodeProgBin(encodeProgBin(short)) as Program).name).toBe('Init Program')
  })

  it('writes the spec value transformations (NORMAL SYNC/RING polarity, 1-based enums)', () => {
    // TABLE 2's "0,1=ON,OFF" legend is an erratum: hardware truth table
    // (2026-07-11 byte-probe on Korg's own Init blob) proves 0=OFF, 1=ON —
    // Korg factory presets store (0,0) for the plain OFF state.
    const p = initProgram()
    p.params[P.SYNC] = 1 // On
    p.params[P.RING] = 0 // Off
    const b = encodeProgBin(p)
    expect(b[34]).toBe(1) // On stores 1
    expect(b[35]).toBe(0) // Off stores 0
    expect(b[21]).toBe(4) // VOICE MODE TYPE: POLY(ours 3) is hw 4
    expect(b[89]).toBe(1) // MOD FX TYPE: CHORUS(ours 0) is hw 1
    expect(b[150]).toBe(13) // PROGRAM TRANSPOSE: ours 12 (=0 Note) is hw 13
    const dec = decodeProgBin(b) as Program
    expect(dec.params[P.SYNC]).toBe(1)
    expect(dec.params[P.RING]).toBe(0)
  })

  it('stores 2-byte fields little-endian (low byte first, like loguetools/xd-patch)', () => {
    const p = initProgram()
    p.params[P.CUTOFF] = 0x2a5 // 677
    p.params[P.DELAY_DRYWET] = 1024 // the 0~1024 field needs 3 high bits
    const b = encodeProgBin(p)
    expect(b[60]).toBe(0xa5) // CUTOFF low byte at 60
    expect(b[61]).toBe(0x02) // CUTOFF high byte at 61
    expect(b[151]).toBe(0x00) // DELAY DRY WET low byte at 151
    expect(b[152]).toBe(0x04) // DELAY DRY WET high byte at 152
    const dec = decodeProgBin(b) as Program
    expect(dec.params[P.CUTOFF]).toBe(0x2a5)
    expect(dec.params[P.DELAY_DRYWET]).toBe(1024)
  })

  it('stores swing biased by +75 (0,75,150 = -75%,0,+75%)', () => {
    const p = initProgram()
    for (const [swing, byte] of [
      [-75, 0],
      [0, 75],
      [75, 150],
    ] as const) {
      p.seq.swing = swing
      const b = encodeProgBin(p)
      expect(b[168]).toBe(byte)
      expect((decodeProgBin(b) as Program).seq.swing).toBe(swing)
    }
  })

  it('maps micro tuning around the unmodeled hardware ids', () => {
    const p = initProgram()
    p.params[P.MICRO_TUNING] = 8 // replica 'Major Penta'
    const b = encodeProgBin(p)
    expect(b[122]).toBe(11) // hw 11 = Major Penta (8~10 are Ionian/Dorian/Aeolian)
    expect((decodeProgBin(b) as Program).params[P.MICRO_TUNING]).toBe(8)
    b[122] = 9 // hw Dorian: not modeled, falls back to Equal Temp
    expect((decodeProgBin(b) as Program).params[P.MICRO_TUNING]).toBe(0)
  })

  it('roundtrips seq step data including gate TIE and stacked notes', () => {
    const p = initProgram()
    p.seq.bpm = 173.5 // 0.1 BPM resolution survives (stored as 1735)
    p.seq.stepLength = 12
    p.seq.stepResolution = 2
    p.seq.swing = -75
    p.seq.defaultGate = 36
    p.seq.activeSteps[3] = false
    p.seq.activeSteps[15] = false
    p.seq.steps[0] = { on: true, notes: [60, 64, 67], vels: [100, 90, 80], gates: [54, 54, GATE_TIE] }
    p.seq.steps[7] = { on: true, notes: [70], vels: [108], gates: [GATE_TIE] }
    expectRoundtrip(p)
  })

  it('keeps a muted step\'s notes/vels/gates AND its mute flag on roundtrip', () => {
    // store.toggleStep mutes without clearing content; the xd blob carries
    // the mute in the Step Off/On mask (170~171) separately from the event
    // data, so a muted-but-populated step is fully representable.
    const p = initProgram()
    p.seq.steps[4] = { on: false, notes: [60, 67], vels: [100, 90], gates: [54, GATE_TIE] }
    const dec = decodeProgBin(encodeProgBin(p)) as Program
    expect(dec.seq.steps[4].on).toBe(false)
    expect(dec.seq.steps[4].notes).toEqual([60, 67])
    expect(dec.seq.steps[4].vels).toEqual([100, 90])
    expect(dec.seq.steps[4].gates).toEqual([54, GATE_TIE])
    expectRoundtrip(p) // and the whole program stays exact
  })

  it('normalizes decoded names: all-NUL -> Program, trailing spaces trimmed, non-printables dropped', () => {
    const b = encodeProgBin(initProgram())
    b.fill(0, 4, 16) // all-NUL name field
    expect((decodeProgBin(b) as Program).name).toBe('Program')
    const t = encodeProgBin(initProgram('Pad   ')) // stored with trailing spaces...
    expect((decodeProgBin(t) as Program).name).toBe('Pad') // ...trimmed on decode
    b.set([0x41, 0x07, 0x42], 4) // 'A', BEL (non-printable), 'B'
    expect((decodeProgBin(b) as Program).name).toBe('AB')
  })

  it('decodes legacy SEQD-tagged blobs with all active steps on (*note S1)', () => {
    const p = initProgram()
    p.seq.activeSteps[2] = false
    const b = encodeProgBin(p)
    b.set([0x53, 0x45, 0x51, 0x44], 160) // 'SEQD' over 'SQ' + active-step mask
    const dec = decodeProgBin(b) as Program
    expect(dec.seq.activeSteps).toEqual(Array.from({ length: NUM_STEPS }, () => true))
  })

  it('drops unmappable motion targets (lane off) and keeps mapped ones', () => {
    const p = initProgram()
    p.seq.motion[0] = {
      paramId: P.CUTOFF,
      on: true,
      smooth: true,
      data: Array.from({ length: NUM_STEPS }, (_, i) => (i === 2 ? [100, 200, 300, 400, 500] : null)),
    }
    const b = encodeProgBin(p)
    b[174 + 2 + 1] = 44 // Motion Slot 2 Parameter ID: hw DRIVE, not motion-recordable here
    b[174 + 2] = 1 // and mark it on
    const dec = decodeProgBin(b) as Program
    expect(dec.seq.motion[0].paramId).toBe(P.CUTOFF)
    expect(dec.seq.motion[0].on).toBe(true)
    expect(dec.seq.motion[0].data[2]).toEqual([100, 200, 300, 400, 500])
    expect(dec.seq.motion[0].data[3]).toBeNull()
    expect(dec.seq.motion[1]).toEqual({
      paramId: -1,
      on: false,
      smooth: false,
      data: Array.from({ length: NUM_STEPS }, () => null),
    })
  })

  it('quantizes pitch-bend motion lanes to the 10-bit hardware field', () => {
    // PITCH BEND lanes store -1..1 floats; the blob holds 10 bits (0..1023),
    // so roundtrip is within one quantization step, not bit-exact.
    const p = initProgram()
    p.seq.motion[0] = {
      paramId: MOTION_PITCH_BEND,
      on: true,
      smooth: true,
      data: Array.from({ length: NUM_STEPS }, (_, i) => (i === 0 ? [-1, -0.25, 0, 0.25, 1] : null)),
    }
    const dec = decodeProgBin(encodeProgBin(p)) as Program
    const lane = dec.seq.motion[0]
    expect(lane.paramId).toBe(MOTION_PITCH_BEND)
    const pts = lane.data[0] as number[]
    const want = [-1, -0.25, 0, 0.25, 1]
    for (let k = 0; k < want.length; k++) expect(Math.abs(pts[k] - want[k])).toBeLessThan(1 / 511)
  })

  it('exposes the librarian metadata', () => {
    expect(XD_KORG_FILE.product).toBe('minilogue xd')
    expect(XD_KORG_FILE.infoTag).toBe('xd_ProgramInformation')
    expect(XD_KORG_FILE.progExt).toBe('mnlgxdprog')
    expect(XD_KORG_FILE.libExts).toEqual(['mnlgxdlib', 'mnlgxdpreset'])
  })
})
