/*
 * OG prog_bin codec tests — 448-byte 'PROG'/'SEQD' blob per
 * docs/hardware/minilogue_MIDIImp.txt TABLE 2 (Revision 1.10).
 *
 * Roundtrip contract: decodeProgBin(encodeProgBin(p)) serializes identically
 * to p for every factory preset, with ONE documented exception: motion-lane
 * data for 0..1023 (knob) targets. The hardware stores motion points as a
 * single byte (top 8 of the 10 bits, *note S4-2), so the 2 LSBs quantize
 * away; those lanes are asserted separately with a +/-4 raw-unit bound
 * (endpoint floor-to-multiple-of-4 <= 3, plus interpolation re-rounding).
 * Switch-target lanes (e.g. FILTER TYPE) roundtrip exactly.
 */
import { describe, expect, it } from 'vitest'
import {
  OG_KORG_FILE,
  OG_PROG_BIN_SIZE,
  decodeProgBin,
  encodeProgBin,
} from '../src/synths/og/progbin'
import { FACTORY_PRESETS } from '../src/synths/og/presets'
import { P, PARAMS } from '../src/synths/og/params'
import { initProgram, serializeProgram } from '../src/synths/og/program'
import { GATE_TIE, NUM_STEPS, NUM_MOTION_LANES, MOTION_POINTS } from '../src/shared/program'
import { MOTION_PITCH_BEND } from '../src/shared/paramdef'

/** Lanes whose per-point values exceed one byte on hardware (lossy 2 LSBs). */
function isLossyMotionTarget(pid: number): boolean {
  if (pid === MOTION_PITCH_BEND) return true // -1..1 float -> byte
  const meta = PARAMS[pid]
  return !!meta && meta.max > 255
}

function magicBlob(fill = 0): Uint8Array {
  const b = new Uint8Array(OG_PROG_BIN_SIZE).fill(fill)
  b.set([0x50, 0x52, 0x4f, 0x47], 0) // 'PROG'
  b.set([0x53, 0x45, 0x51, 0x44], 96) // 'SEQD'
  return b
}

describe('OG prog_bin codec', () => {
  it('exposes the librarian metadata', () => {
    expect(OG_KORG_FILE.product).toBe('minilogue')
    expect(OG_KORG_FILE.infoTag).toBe('minilogue_ProgramInformation')
    expect(OG_KORG_FILE.progExt).toBe('mnlgprog')
    expect(OG_KORG_FILE.libExts).toEqual(['mnlglib', 'mnlgpreset'])
  })

  it('encodes a 448-byte blob with PROG/SEQD magics and spec-anchored fields', () => {
    const bin = encodeProgBin(initProgram())
    expect(bin.length).toBe(OG_PROG_BIN_SIZE)
    expect(String.fromCharCode(...bin.subarray(0, 4))).toBe('PROG')
    expect(String.fromCharCode(...bin.subarray(96, 100))).toBe('SEQD')
    // Name field (4~15): 'Init Program' is exactly the 12-char hardware width.
    expect(String.fromCharCode(...bin.subarray(4, 16))).toBe('Init Program')
    // CUTOFF default 1023: upper 8 bits at byte 29, lower 2 at byte 55 b4~5.
    expect(bin[29]).toBe(0xff)
    expect((bin[55] >> 4) & 0x03).toBe(0x03)
    // VCO1 PITCH default 512: byte 20 = 128, low bits (52 b0~1) = 0.
    expect(bin[20]).toBe(128)
    expect(bin[52] & 0x03).toBe(0)
    // Program Level (byte 71) default 102; Slider Assign (72) default
    // PITCH BEND = sparse hardware id 77 (P13's 0..28 list is a doc error;
    // ids per minilogue-editor/loguetools, cf. monologue *note P12).
    expect(bin[71]).toBe(102)
    expect(bin[72]).toBe(77)
    // BPM 120.0 -> 1200 (12-bit LE at 100/101); step switch bytes = 0xff (*note S2).
    expect(bin[100] | (bin[101] << 8)).toBe(1200)
    expect(bin[110]).toBe(0xff)
    expect(bin[111]).toBe(0xff)
    // Bend range +2/-2 nibbles at byte 66.
    expect(bin[66]).toBe(0x22)
  })

  it('roundtrips the init program exactly', () => {
    const p = initProgram()
    const back = decodeProgBin(encodeProgBin(p))
    expect(back).not.toBeNull()
    expect(serializeProgram(back!)).toBe(serializeProgram(p))
  })

  it('roundtrips every factory preset (knob motion data within 8-bit quantization)', () => {
    expect(FACTORY_PRESETS.length).toBeGreaterThanOrEqual(10)
    for (const preset of FACTORY_PRESETS) {
      const back = decodeProgBin(encodeProgBin(preset))
      expect(back, preset.name).not.toBeNull()

      const a = JSON.parse(serializeProgram(preset))
      const b = JSON.parse(serializeProgram(back!))

      for (let l = 0; l < NUM_MOTION_LANES; l++) {
        const laneA = preset.seq.motion[l]
        const laneB = back!.seq.motion[l]
        expect(laneB.paramId, `${preset.name} lane ${l} paramId`).toBe(laneA.paramId)
        expect(laneB.on, `${preset.name} lane ${l} on`).toBe(laneA.on)
        expect(laneB.smooth, `${preset.name} lane ${l} smooth`).toBe(laneA.smooth)
        if (!isLossyMotionTarget(laneA.paramId)) continue // exact: left in JSON diff
        // DOCUMENTED LOSS: hardware stores one byte per motion point for
        // 10-bit params (value >> 2) and 2 points per step vs our 5, so
        // knob-target lane data cannot roundtrip bit-exactly. Assert the
        // null mask and a tight quantization bound instead, and exclude
        // only this data from the JSON equality below.
        for (let i = 0; i < NUM_STEPS; i++) {
          const da = laneA.data[i]
          const db = laneB.data[i]
          expect(db === null, `${preset.name} lane ${l} step ${i} mask`).toBe(da === null)
          if (!da || !db) continue
          expect(db.length).toBe(MOTION_POINTS)
          for (let k = 0; k < MOTION_POINTS; k++) {
            expect(
              Math.abs(db[k] - da[k]),
              `${preset.name} lane ${l} step ${i} pt ${k}: ${da[k]} -> ${db[k]}`,
            ).toBeLessThanOrEqual(4)
          }
        }
        a.seq.motion[l].data = a.seq.motion[l].data.map(() => null)
        b.seq.motion[l].data = b.seq.motion[l].data.map(() => null)
      }

      // Everything else — all 54 params, name, BPM/swing/gates/steps/notes
      // (incl. TIE), active steps, switch-target motion lanes — is exact.
      expect(b, preset.name).toEqual(a)
    }
  })

  it('preserves TIE gates and multi-note steps through the step event blocks', () => {
    const cascade = FACTORY_PRESETS.find((p) => p.name === 'Cascade')!
    const back = decodeProgBin(encodeProgBin(cascade))!
    expect(back.seq.steps[12].gates[0]).toBe(GATE_TIE)
    expect(back.seq.steps[12].notes).toEqual([64])
    expect(back.seq.steps[13].on).toBe(false)
  })

  it('writes the corrected S3-1 motion parameter ids', () => {
    const acid = FACTORY_PRESETS.find((p) => p.name === 'Acid Squelch')!
    const bin = encodeProgBin(acid)
    // Slot 1 (bytes 112~113): CUTOFF lane, on+smooth; S3-1 id 32 = CUTOFF.
    expect(bin[112]).toBe(0x03)
    expect(bin[113]).toBe(32)
    // Slot 2 (bytes 114~115): FILTER TYPE lane, on, stepped; id 37 = CUTOFF TYPE.
    expect(bin[114]).toBe(0x01)
    expect(bin[115]).toBe(37)
  })

  it('maps slider assign through the sparse hardware id table', () => {
    const p = initProgram()
    // Index 11 = CUTOFF -> stored id 32; roundtrips to the same index.
    p.params[P.SLIDER_ASSIGN] = 11
    const bin = encodeProgBin(p)
    expect(bin[72]).toBe(32)
    expect(decodeProgBin(bin)!.params[P.SLIDER_ASSIGN]).toBe(11)
    // Index 28 = VOICE MODE DEPTH -> id 71 (last entry).
    p.params[P.SLIDER_ASSIGN] = 28
    expect(encodeProgBin(p)[72]).toBe(71)
    // Unknown stored ids (e.g. P13's bogus sequential values that are not
    // also real ids) decode to the default PITCH BEND index 0.
    const alien = encodeProgBin(initProgram())
    alien[72] = 28
    expect(decodeProgBin(alien)!.params[P.SLIDER_ASSIGN]).toBe(0)
  })

  it('returns null for wrong sizes', () => {
    expect(decodeProgBin(new Uint8Array(0))).toBeNull()
    expect(decodeProgBin(new Uint8Array(OG_PROG_BIN_SIZE - 1))).toBeNull()
    expect(decodeProgBin(new Uint8Array(OG_PROG_BIN_SIZE + 1))).toBeNull()
    // Right content, wrong length: a truncated real blob must not decode.
    const bin = encodeProgBin(initProgram())
    expect(decodeProgBin(bin.subarray(0, 447))).toBeNull()
  })

  it('returns null for missing or corrupt magics', () => {
    expect(decodeProgBin(new Uint8Array(OG_PROG_BIN_SIZE))).toBeNull() // all zeros
    expect(decodeProgBin(new Uint8Array(OG_PROG_BIN_SIZE).fill(0xab))).toBeNull()
    const noSeqd = encodeProgBin(initProgram())
    noSeqd[96] = 0x00 // break 'SEQD'
    expect(decodeProgBin(noSeqd)).toBeNull()
    const noProg = encodeProgBin(initProgram())
    noProg[0] = 0x51 // break 'PROG'
    expect(decodeProgBin(noProg)).toBeNull()
  })

  it('clamps hostile bytes behind valid magics into legal ranges', () => {
    const back = decodeProgBin(magicBlob(0xff))
    expect(back).not.toBeNull()
    for (const meta of PARAMS) {
      const v = back!.params[meta.id]
      expect(Number.isFinite(v), meta.key).toBe(true)
      expect(v, meta.key).toBeGreaterThanOrEqual(meta.min)
      expect(v, meta.key).toBeLessThanOrEqual(meta.max)
    }
    const seq = back!.seq
    expect(seq.bpm).toBe(300) // 0xFFF -> 4095 clamped to 3000 -> 300.0
    expect(seq.stepLength).toBe(16)
    expect(seq.swing).toBe(-1) // 0xFF as signed
    expect(seq.defaultGate).toBe(72)
    expect(seq.stepResolution).toBe(4)
    for (const st of seq.steps) {
      for (const n of st.notes) expect(n).toBeLessThanOrEqual(127)
      for (const v of st.vels) expect(v).toBeLessThanOrEqual(127)
      for (const g of st.gates) expect(g).toBeLessThanOrEqual(127)
    }
    // Motion slot param id 0xFF is not a known S3-1 id: lanes come back off.
    for (const lane of seq.motion) {
      expect(lane.paramId).toBe(-1)
      expect(lane.on).toBe(false)
      expect(lane.data.every((d) => d === null)).toBe(true)
    }
    // And the decoded mess re-encodes without throwing.
    expect(encodeProgBin(back!).length).toBe(OG_PROG_BIN_SIZE)
  })

  it('truncates names to the 12-char hardware field on roundtrip', () => {
    // Replica allows 16 chars; TABLE 2 offset 4~15 holds only 12.
    const p = initProgram('SixteenCharsName')
    expect(p.name.length).toBe(16)
    const back = decodeProgBin(encodeProgBin(p))!
    expect(back.name).toBe('SixteenChars')
    // Non-ASCII characters become '?' in the file.
    const funky = initProgram('Weiß Röhre')
    expect(decodeProgBin(encodeProgBin(funky))!.name).toBe('Wei? R?hre')
    // All-NUL name field: family normalization falls back to 'Program'.
    const blank = encodeProgBin(initProgram())
    blank.fill(0, 4, 16)
    expect(decodeProgBin(blank)!.name).toBe('Program')
  })

  it('keeps a muted step\'s notes on export (the mute flag itself has no field)', () => {
    // store.toggleStep mutes without clearing content. The og blob derives
    // step on/off from event presence (velocity 0 = no event) and has no
    // separate mute bit, so the notes must survive export; the mute flag
    // cannot — the step decodes as on=true (documented format limit,
    // content preservation beats flag fidelity).
    const p = initProgram()
    p.seq.steps[3] = { on: false, notes: [62, 65], vels: [90, 80], gates: [40, GATE_TIE] }
    const back = decodeProgBin(encodeProgBin(p))!
    expect(back.seq.steps[3].notes).toEqual([62, 65])
    expect(back.seq.steps[3].vels).toEqual([90, 80])
    expect(back.seq.steps[3].gates).toEqual([40, GATE_TIE])
    expect(back.seq.steps[3].on).toBe(true) // on-by-presence: mute not representable
  })

  it('keeps only the first 4 notes of a step (hardware note slots)', () => {
    const p = initProgram()
    p.seq.steps[0] = {
      on: true,
      notes: [60, 64, 67, 71, 74, 77, 81, 84], // replica paraphony: 8
      vels: [100, 101, 102, 103, 104, 105, 106, 107],
      gates: [40, 41, 42, GATE_TIE, 44, 45, 46, 47],
    }
    const back = decodeProgBin(encodeProgBin(p))!
    expect(back.seq.steps[0].notes).toEqual([60, 64, 67, 71])
    expect(back.seq.steps[0].vels).toEqual([100, 101, 102, 103])
    expect(back.seq.steps[0].gates).toEqual([40, 41, 42, GATE_TIE])
  })

  it('drops motion lanes whose target has no S3-1 id (VOICE MODE DEPTH)', () => {
    const p = initProgram()
    const lane = p.seq.motion[0]
    lane.paramId = P.VM_DEPTH // motion-recordable in the replica, absent from S3-1
    lane.on = true
    lane.smooth = true
    lane.data[0] = [0, 100, 200, 300, 400]
    const back = decodeProgBin(encodeProgBin(p))!
    expect(back.seq.motion[0].paramId).toBe(-1)
    expect(back.seq.motion[0].on).toBe(false)
    expect(back.seq.motion[0].data[0]).toBeNull()
  })

  it('roundtrips fractional BPM (stored x10, 12-bit)', () => {
    const p = initProgram()
    p.seq.bpm = 137.5
    expect(decodeProgBin(encodeProgBin(p))!.seq.bpm).toBe(137.5)
    p.seq.bpm = 10
    expect(decodeProgBin(encodeProgBin(p))!.seq.bpm).toBe(10)
    p.seq.bpm = 300
    expect(decodeProgBin(encodeProgBin(p))!.seq.bpm).toBe(300)
  })

  it('roundtrips active-step and motion-step masks', () => {
    const p = initProgram()
    for (let i = 0; i < NUM_STEPS; i++) p.seq.activeSteps[i] = i % 3 !== 1
    const lane = p.seq.motion[2] // arbitrary slot
    lane.paramId = P.RESONANCE
    lane.on = true
    lane.smooth = true
    lane.data[5] = [100, 200, 300, 400, 500] // non-linear: only ends survive
    lane.data[9] = [512, 512, 512, 512, 512]
    const back = decodeProgBin(encodeProgBin(p))!
    expect(back.seq.activeSteps).toEqual(p.seq.activeSteps)
    const bl = back.seq.motion[2]
    expect(bl.paramId).toBe(P.RESONANCE)
    expect(bl.data.map((d) => d !== null)).toEqual(lane.data.map((d) => d !== null))
    // Smooth spread from the two stored endpoints (100..500 -> 5-pt ramp).
    expect(bl.data[5]).toEqual([100, 200, 300, 400, 500])
    expect(bl.data[9]).toEqual([512, 512, 512, 512, 512])
  })
})
