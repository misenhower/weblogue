/*
 * monologue prog_bin codec tests (src/synths/mono/progbin.ts) — the 448-byte
 * 'PROG'+'SEQD' binary of docs/hardware/monologue_MIDIImp.txt TABLE 2.
 *
 * The roundtrip contract: decodeProgBin(encodeProgBin(p)) serializes
 * identically to p for every factory preset, EXCEPT for the one documented
 * lossy field — motion lane VALUES. The hardware stores motion data as 4
 * bytes of 0~255 per slot per step (note S2/S2-2: Data1 = step start,
 * Data2 = step end, interpolated when Smooth is on), so a 10-bit knob's
 * motion value keeps only its upper 8 bits (multiples of 4) and a 5-point
 * replica lane keeps only its endpoints. Presets whose lanes are linear
 * ramps on the 4-raw-unit grid roundtrip exactly; 'Pelog Bells' (whose ramp
 * endpoints fall off-grid) quantizes as computed below. Everything else —
 * every param, name, BPM, masks, notes/gates incl. TIE, SLIDE flags —
 * roundtrips exactly.
 */
import { describe, expect, it } from 'vitest'
import { FACTORY_PRESETS } from '../src/synths/mono/presets'
import { P, PARAMS, PARAM_COUNT, clampParam } from '../src/synths/mono/params'
import { initProgram, serializeProgram, deserializeProgram } from '../src/synths/mono/program'
import {
  MONO_KORG_FILE,
  PROG_BIN_SIZE,
  encodeProgBin,
  decodeProgBin,
} from '../src/synths/mono/progbin'
import { MONO_DEF } from '../src/synths/mono/def'
import { MICRO_TUNINGS } from '../src/synths/mono/curves'
import { MOTION_PITCH_BEND, MOTION_GATE_TIME } from '../src/shared/paramdef'
import { GATE_TIE, MOTION_POINTS, NUM_STEPS, type Program } from '../src/shared/program'

// -----------------------------------------------------------------------------
// The documented hardware motion resolution, applied to an expected program:
// smooth lanes keep quantized endpoints and re-ramp; stepped lanes keep the
// quantized first point. 10-bit knob targets quantize to (v >> 2) << 2.
// (Independent re-statement of the spec's note S2-2 semantics, NOT an import
// from the codec under test.)
// -----------------------------------------------------------------------------
function hwMotionQuantized(p: Program): Program {
  const c = deserializeProgram(serializeProgram(p))
  if (!c) throw new Error('clone failed')
  for (const lane of c.seq.motion) {
    if (lane.paramId < 0) continue
    const meta = PARAMS[lane.paramId]
    const q = (v: number): number => (meta.max > 255 ? (v >> 2) << 2 : v)
    const smooth = lane.smooth && meta.motionSmooth === true
    for (let i = 0; i < NUM_STEPS; i++) {
      const pts = lane.data[i]
      if (!pts) continue
      const a = q(pts[0])
      const b = smooth ? q(pts[MOTION_POINTS - 1]) : a
      lane.data[i] = Array.from({ length: MOTION_POINTS }, (_, k) =>
        Math.round(a + ((b - a) * k) / (MOTION_POINTS - 1)),
      )
    }
  }
  return c
}

describe('mono prog_bin roundtrip', () => {
  it('roundtrips every factory preset (motion values at hardware resolution)', () => {
    for (const preset of FACTORY_PRESETS) {
      const bin = encodeProgBin(preset)
      const back = decodeProgBin(bin)
      expect(back, preset.name).not.toBeNull()
      expect(serializeProgram(back as Program), preset.name).toBe(
        serializeProgram(hwMotionQuantized(preset)),
      )
    }
  })

  it('quantization touches ONLY Pelog Bells (its ramp endpoints are off the 4-unit grid)', () => {
    for (const preset of FACTORY_PRESETS) {
      const untouched = serializeProgram(hwMotionQuantized(preset)) === serializeProgram(preset)
      expect(untouched, preset.name).toBe(preset.name !== 'Pelog Bells')
    }
  })

  it('roundtrips the init program exactly', () => {
    const p = initProgram()
    const back = decodeProgBin(encodeProgBin(p))
    expect(back).not.toBeNull()
    expect(serializeProgram(back as Program)).toBe(serializeProgram(p))
  })
})

describe('mono prog_bin blob structure', () => {
  it('is 448 bytes with PROG at 0 and SEQD at 48', () => {
    const b = encodeProgBin(initProgram())
    expect(b.length).toBe(PROG_BIN_SIZE)
    expect(PROG_BIN_SIZE).toBe(448)
    expect(String.fromCharCode(b[0], b[1], b[2], b[3])).toBe('PROG')
    expect(String.fromCharCode(b[48], b[49], b[50], b[51])).toBe('SEQD')
  })

  it('splits 10-bit knobs into upper byte + packed low bits (TABLE 2 offsets)', () => {
    const p = initProgram()
    p.params[P.CUTOFF] = 1023 // "22 CUTOFF (bit2~9)" / "33 b4~5"
    p.params[P.EG_INT] = 513 // "26 EG INT (bit2~9)" / "35 b0~1" (TABLE 2, not the note-P1 permutation)
    p.params[P.LFO_RATE] = 2 // "27 LFO RATE (bit2~9)" / "35 b2~3"
    const b = encodeProgBin(p)
    expect(b[22]).toBe(255)
    expect((b[33] >> 4) & 3).toBe(3)
    expect(b[26]).toBe(128)
    expect(b[35] & 3).toBe(1)
    expect(b[27]).toBe(0)
    expect((b[35] >> 2) & 3).toBe(2)
  })

  it('writes step events on the 22-byte stride (spec row-range erratum) with TIE and SLIDE', () => {
    const pelog = FACTORY_PRESETS.find((p) => p.name === 'Pelog Bells') as Program
    const b = encodeProgBin(pelog)
    // st(seq, 4, 47, GATE_TIE): step 5 event at 96 + 4*22 = 184.
    expect(b[184 + 0]).toBe(47) // note
    expect(b[184 + 2]).toBe(100) // velocity
    expect(b[184 + 4]).toBe(GATE_TIE) // gate byte, TIE (73), trigger bit 0
    // Step 16 event lives at 426~447 ("426~447 Step 16 Event Data").
    expect(b[426 + 0]).toBe(43)

    const acid = FACTORY_PRESETS.find((p) => p.name === 'Slide Acid') as Program
    const a = encodeProgBin(acid)
    // SLIDE flags on steps 3, 8, 13 (indices 2, 7, 12) -> bytes 68~69 bitmask.
    expect(a[68]).toBe((1 << 2) | (1 << 7))
    expect(a[69]).toBe(1 << (12 - 8))
  })

  it('encodes BPM as 100~3000 = 10.0~300.0 little-endian at 52~53', () => {
    const p = initProgram()
    p.seq.bpm = 128.5
    const b = encodeProgBin(p)
    expect(b[52] | (b[53] << 8)).toBe(1285)
    expect((decodeProgBin(b) as Program).seq.bpm).toBe(128.5)
  })
})

describe('mono prog_bin decode validation', () => {
  it('rejects wrong sizes', () => {
    expect(decodeProgBin(new Uint8Array(0))).toBeNull()
    expect(decodeProgBin(new Uint8Array(447))).toBeNull()
    expect(decodeProgBin(new Uint8Array(449))).toBeNull()
    expect(decodeProgBin(new Uint8Array(336))).toBeNull() // a prologue-sized blob
  })

  it('rejects wrong magics', () => {
    expect(decodeProgBin(new Uint8Array(448))).toBeNull() // no 'PROG'
    const b = encodeProgBin(initProgram())
    const noSeqd = b.slice()
    noSeqd[48] = 0x58 // corrupt 'SEQD'
    expect(decodeProgBin(noSeqd)).toBeNull()
    const noProg = b.slice()
    noProg[0] = 0x58
    expect(decodeProgBin(noProg)).toBeNull()
  })

  it('clamps binary garbage into valid param ranges (no NaN, no out-of-range)', () => {
    const b = new Uint8Array(448).fill(0xff)
    b.set([0x50, 0x52, 0x4f, 0x47], 0) // 'PROG'
    b.set([0x53, 0x45, 0x51, 0x44], 48) // 'SEQD'
    const p = decodeProgBin(b)
    expect(p).not.toBeNull()
    const prog = p as Program
    expect(prog.params.length).toBe(PARAM_COUNT)
    for (const meta of PARAMS) {
      const v = prog.params[meta.id]
      expect(Number.isFinite(v), meta.key).toBe(true)
      expect(v, meta.key).toBe(clampParam(meta.id, v))
    }
    expect(prog.seq.bpm).toBeLessThanOrEqual(300)
    expect(prog.seq.stepLength).toBeLessThanOrEqual(16)
    expect(prog.seq.stepResolution).toBeLessThanOrEqual(4)
    expect(Math.abs(prog.seq.swing)).toBeLessThanOrEqual(75)
    expect(prog.seq.defaultGate).toBeLessThanOrEqual(72)
    for (const st of prog.seq.steps) {
      for (const n of st.notes) expect(n).toBeLessThanOrEqual(127)
      for (const v of st.vels) expect(v).toBeLessThanOrEqual(127)
      for (const g of st.gates) expect(g).toBeLessThanOrEqual(127)
    }
    // Slot parameter byte 0xFF is not a note-S1-1 id: lanes unassigned + off.
    for (const lane of prog.seq.motion) {
      expect(lane.paramId).toBe(-1)
      expect(lane.on).toBe(false)
      expect(lane.data.every((d) => d === null)).toBe(true)
    }
    // The whole decode must survive its own serializer.
    expect(deserializeProgram(serializeProgram(prog))).not.toBeNull()
  })
})

describe('mono prog_bin name field', () => {
  it('is 12 chars on hardware: longer replica names truncate on roundtrip', () => {
    const p = initProgram('ABCDEFGHIJKLMNOP') // 16 chars (replica max)
    const back = decodeProgBin(encodeProgBin(p)) as Program
    expect(back.name).toBe('ABCDEFGHIJKL')
  })

  it('roundtrips a full 12-char name exactly', () => {
    const p = initProgram('Init Program') // exactly 12
    const back = decodeProgBin(encodeProgBin(p)) as Program
    expect(back.name).toBe('Init Program')
  })

  it('falls back to Program for an all-NUL name field (family normalization)', () => {
    const b = encodeProgBin(initProgram())
    b.fill(0, 4, 16)
    expect((decodeProgBin(b) as Program).name).toBe('Program')
  })
})

describe('mono prog_bin documented non-roundtrip fields', () => {
  it('keeps a muted step\'s note on export (the mute flag itself has no field)', () => {
    // store.toggleStep mutes without clearing content. The monologue blob
    // derives step on/off from event presence (velocity 0 = NoEvent) and
    // bytes 64~65 are the Active Step skip mask, not a mute bit — so the
    // note must survive export; the mute flag cannot — the step decodes as
    // on=true (documented format limit, content preservation beats flag
    // fidelity).
    const p = initProgram()
    p.seq.steps[5] = { on: false, notes: [48], vels: [110], gates: [GATE_TIE] }
    const back = decodeProgBin(encodeProgBin(p)) as Program
    expect(back.seq.steps[5].notes).toEqual([48])
    expect(back.seq.steps[5].vels).toEqual([110])
    expect(back.seq.steps[5].gates).toEqual([GATE_TIE])
    expect(back.seq.steps[5].on).toBe(true) // on-by-presence: mute not representable
  })

  it('KEY TRG stores as SEQ TRIG (byte 36 b6); HOLD is transport state and decodes Off', () => {
    const p = initProgram()
    p.params[P.KEY_TRIG] = 1 // KEY TRG
    expect((decodeProgBin(encodeProgBin(p)) as Program).params[P.KEY_TRIG]).toBe(1)
    p.params[P.KEY_TRIG] = 2 // HOLD — not program data on hardware
    const b = encodeProgBin(p)
    expect((b[36] >> 6) & 1).toBe(0)
    expect((decodeProgBin(b) as Program).params[P.KEY_TRIG]).toBe(0)
  })

  it('SLIDER_RANGE has no TABLE 2 field: decode leaves the default', () => {
    const p = initProgram()
    p.params[P.SLIDER_RANGE] = 0 // -100%
    const back = decodeProgBin(encodeProgBin(p)) as Program
    expect(back.params[P.SLIDER_RANGE]).toBe(PARAMS[P.SLIDER_RANGE].def)
  })
})

describe('mono prog_bin value maps', () => {
  it('maps MICRO_TUNING through the note-P11 ids and clamps non-built-ins', () => {
    const pelogIdx = MICRO_TUNINGS.findIndex((t) => t.name === 'Pelog')
    const p = initProgram()
    p.params[P.MICRO_TUNING] = pelogIdx
    const b = encodeProgBin(p)
    expect(b[38]).toBe(7) // "7 : Pelog"
    expect((decodeProgBin(b) as Program).params[P.MICRO_TUNING]).toBe(pelogIdx)
    // Reverse maps to P11 id 13 (the replica list skips Ionian/Dorian/Aeolian).
    p.params[P.MICRO_TUNING] = MICRO_TUNINGS.findIndex((t) => t.name === 'Reverse')
    expect(encodeProgBin(p)[38]).toBe(13)
    // Hardware-only entries decode to Equal Temp (0).
    for (const hw of [9 /* Dorian */, 15 /* AFX002 */, 128 /* USER SCALE 1 */]) {
      const g = encodeProgBin(initProgram())
      g[38] = hw
      expect((decodeProgBin(g) as Program).params[P.MICRO_TUNING]).toBe(0)
    }
  })

  it('maps SLIDER_ASSIGN through the note-P12 ids (DRIVE via S1-1 id 37; PORTAMENT -> default)', () => {
    const p = initProgram()
    p.params[P.SLIDER_ASSIGN] = 15 // DRIVE (replica dest list)
    const b = encodeProgBin(p)
    expect(b[42]).toBe(37)
    expect((decodeProgBin(b) as Program).params[P.SLIDER_ASSIGN]).toBe(15)
    p.params[P.SLIDER_ASSIGN] = 0 // PITCH BEND, the hardware default
    expect(encodeProgBin(p)[42]).toBe(56)
    const g = encodeProgBin(initProgram())
    g[42] = 40 // PORTAMENT: in the hardware list, not in the replica's
    expect((decodeProgBin(g) as Program).params[P.SLIDER_ASSIGN]).toBe(0)
  })
})

describe('mono prog_bin motion lanes', () => {
  it('roundtrips a switch-target lane (direct byte values) and its step mask', () => {
    const p = initProgram()
    const lane = p.seq.motion[1]
    lane.paramId = P.VCO1_OCTAVE // note S1-1 "15 : VCO 1 OCTAVE", 0~3 direct
    lane.on = true
    lane.smooth = false
    lane.data[0] = [3, 3, 3, 3, 3]
    lane.data[9] = [1, 1, 1, 1, 1]
    const b = encodeProgBin(p)
    expect(b[72 + 2]).toBe(1) // slot 2: on, not smooth
    expect(b[73 + 2]).toBe(15)
    expect(b[80 + 2]).toBe(1) // step 1 mask
    expect(b[81 + 2]).toBe(1 << 1) // step 10 mask
    const back = decodeProgBin(b) as Program
    expect(serializeProgram(back)).toBe(serializeProgram(p))
  })

  it('roundtrips virtual targets: GATE TIME (with TIE) and PITCH BEND full throw', () => {
    const p = initProgram()
    const gate = p.seq.motion[0]
    gate.paramId = MOTION_GATE_TIME // note S1-1 "57 : GATE TIME"
    gate.on = true
    gate.smooth = true
    gate.data[0] = [12, 12, 12, 12, 12]
    gate.data[1] = [127, 127, 127, 127, 127] // TIE override
    const bend = p.seq.motion[1]
    bend.paramId = MOTION_PITCH_BEND // note S1-1 "56 : PITCH BEND"
    bend.on = true
    bend.smooth = true
    bend.data[2] = [-1, -0.5, 0, 0.5, 1] // linear, endpoints on the byte grid
    const b = encodeProgBin(p)
    expect(b[73]).toBe(57)
    expect(b[73 + 2]).toBe(56)
    const back = decodeProgBin(b) as Program
    expect(serializeProgram(back)).toBe(serializeProgram(p))
  })

  it('reconstructs smooth lanes as Data1->Data2 ramps and stepped lanes as flat Data1', () => {
    const p = initProgram()
    const lane = p.seq.motion[0]
    lane.paramId = P.CUTOFF
    lane.on = true
    lane.smooth = true
    lane.data[0] = [100, 900, 100, 900, 500] // NOT linear: hardware keeps endpoints only
    const back = decodeProgBin(encodeProgBin(p)) as Program
    expect(back.seq.motion[0].data[0]).toEqual([100, 200, 300, 400, 500])
    lane.smooth = false
    const back2 = decodeProgBin(encodeProgBin(p)) as Program
    expect(back2.seq.motion[0].data[0]).toEqual([100, 100, 100, 100, 100])
  })
})

describe('mono korg file identity', () => {
  it('exposes the monologue container identity and is wired into MONO_DEF', () => {
    expect(MONO_KORG_FILE.product).toBe('monologue')
    expect(MONO_KORG_FILE.infoTag).toBe('monologue_ProgramInformation')
    expect(MONO_KORG_FILE.progExt).toBe('molgprog')
    expect(MONO_KORG_FILE.libExts).toEqual(['molglib'])
    expect(MONO_DEF.korgFile).toBe(MONO_KORG_FILE)
  })
})
