/*
 * Original minilogue (OG) data-layer tests: param table integrity, program
 * serialization round-trip + cross-synth refusal, the OG's own zone tables
 * (arp types, DELAY voice mode), the corrected PITCH EG INT curve
 * (docs/og-spec.md §15.1), and rev 1.10 CC decode spot checks.
 */
import { describe, expect, it } from 'vitest'
import { P, PARAMS, PARAM_COUNT, PARAM_BY_KEY, clampParam, formatParam, MOTION_PARAM_IDS, MOTION_META, sliderDestParam, SLIDER_DEST_PITCH_BEND, SLIDER_DEST_GATE_TIME } from '../src/synths/og/params'
import { MOTION_PITCH_BEND, MOTION_GATE_TIME } from '../src/shared/paramdef'
import * as ogProgram from '../src/synths/og/program'
import * as xdProgram from '../src/synths/xd/program'
import { arpTypeIndex, ARP_TYPES, delayModeDivision, pitchEgIntToCents, pitchToCents, egIntToPercent, chordIndex, CHORDS, lfoIntTo01, programLevelToDb, portamentoToSec, SLIDER_ASSIGN_DESTS } from '../src/synths/og/curves'
import { decodeCc } from '../src/synths/og/cc'

// ------------------------------------------------------------- param table

describe('og param table', () => {
  it('builds dense with no duplicate or missing ids', () => {
    // buildParamTable throws at import time on dup/missing; assert density too.
    expect(PARAMS.length).toBe(PARAM_COUNT)
    for (let i = 0; i < PARAM_COUNT; i++) {
      expect(PARAMS[i]).toBeDefined()
      expect(PARAMS[i].id).toBe(i)
    }
  })

  it('P covers every id exactly once', () => {
    const ids = Object.values(P)
    expect(ids.length).toBe(PARAM_COUNT)
    expect(new Set(ids).size).toBe(PARAM_COUNT)
    for (const id of ids) expect(id).toBeGreaterThanOrEqual(0)
    for (const id of ids) expect(id).toBeLessThan(PARAM_COUNT)
  })

  it('serialization keys are unique', () => {
    expect(new Set(PARAMS.map((p) => p.key)).size).toBe(PARAM_COUNT)
    expect(PARAM_BY_KEY.size).toBe(PARAM_COUNT)
  })

  it('defaults are in range and clamp respects hardware ranges', () => {
    for (const p of PARAMS) {
      expect(p.def).toBeGreaterThanOrEqual(p.min)
      expect(p.def).toBeLessThanOrEqual(p.max)
    }
    expect(clampParam(P.PROGRAM_LEVEL, 0)).toBe(77) // stored 77..127
    expect(clampParam(P.PROGRAM_LEVEL, 999)).toBe(127)
    expect(clampParam(P.BEND_RANGE_PLUS, 0)).toBe(1) // 1..12, no Off
    expect(clampParam(P.PORTAMENTO, 500)).toBe(129) // 0,1..129 = OFF,0..128
    expect(clampParam(P.VOICE_MODE, 99)).toBe(7) // 8 voice modes
  })

  it('OG-specific switches and formats', () => {
    expect(formatParam(P.FILTER_TYPE, 0)).toBe('2-POLE')
    expect(formatParam(P.FILTER_TYPE, 1)).toBe('4-POLE')
    expect(formatParam(P.VOICE_MODE, 7)).toBe('SIDE CHAIN')
    expect(formatParam(P.DELAY_ROUTING, 1)).toBe('PRE FILTER')
    expect(formatParam(P.LFO_EG_MOD, 1)).toBe('RATE')
    expect(formatParam(P.PORTAMENTO, 0)).toBe('Off')
    expect(formatParam(P.PORTAMENTO, 129)).toBe('128')
    expect(formatParam(P.PROGRAM_LEVEL, 102)).toBe('0.0dB')
  })

  it('motion covers knobs AND switches incl. SYNC/RING/FILTER TYPE/DELAY ROUTING (spec §10)', () => {
    for (const id of [P.SYNC, P.RING, P.FILTER_TYPE, P.DELAY_ROUTING, P.CUTOFF, P.VM_DEPTH]) {
      expect(MOTION_PARAM_IDS).toContain(id)
      expect(MOTION_META.isTarget(id)).toBe(true)
    }
    // Excluded: kbd OCTAVE (menu) and the hold-button latch; virtual targets in.
    expect(MOTION_PARAM_IDS).not.toContain(P.OCTAVE)
    expect(MOTION_PARAM_IDS).not.toContain(P.ARP_LATCH)
    expect(MOTION_PARAM_IDS).toContain(MOTION_PITCH_BEND)
    expect(MOTION_PARAM_IDS).toContain(MOTION_GATE_TIME)
    // Switch-type lanes are stepped, knob lanes smoothable.
    expect(MOTION_META.isSmooth(P.SYNC)).toBe(false)
    expect(MOTION_META.isSmooth(P.CUTOFF)).toBe(true)
  })

  it('slider destinations map in exact MIDIimp P13 order', () => {
    expect(SLIDER_ASSIGN_DESTS.length).toBe(29)
    expect(sliderDestParam(0)).toBe(SLIDER_DEST_PITCH_BEND)
    expect(sliderDestParam(1)).toBe(SLIDER_DEST_GATE_TIME)
    expect(sliderDestParam(2)).toBe(P.VCO1_PITCH)
    expect(sliderDestParam(7)).toBe(P.PITCH_EG_INT)
    expect(sliderDestParam(13)).toBe(P.EG_INT) // FILTER EG INT
    expect(sliderDestParam(20)).toBe(P.EG_SUSTAIN)
    expect(sliderDestParam(27)).toBe(P.PORTAMENTO)
    expect(sliderDestParam(28)).toBe(P.VM_DEPTH)
  })
})

// ------------------------------------------------------------ serialization

describe('og program serialization', () => {
  it('round-trips an init program', () => {
    const prog = ogProgram.initProgram('OG Round Trip')
    prog.params[P.CUTOFF] = 700
    prog.params[P.VOICE_MODE] = 7
    prog.params[P.PROGRAM_LEVEL] = 90
    const back = ogProgram.deserializeProgram(ogProgram.serializeProgram(prog))
    expect(back).not.toBeNull()
    expect(back!.synthId).toBe('og')
    expect(back!.name).toBe('OG Round Trip')
    expect(back!.params).toEqual(prog.params)
  })

  it('og deserializer refuses xd programs (and v1 no-synthId files)', () => {
    const xdJson = xdProgram.serializeProgram(xdProgram.initProgram('XD Prog'))
    expect(ogProgram.deserializeProgram(xdJson)).toBeNull()
    // v1 files predate synthId and are xd programs — refuse those too.
    expect(ogProgram.deserializeProgram(JSON.stringify({ v: 1, name: 'Old', params: {} }))).toBeNull()
  })

  it('xd deserializer refuses og programs', () => {
    const ogJson = ogProgram.serializeProgram(ogProgram.initProgram('OG Prog'))
    expect(xdProgram.deserializeProgram(ogJson)).toBeNull()
  })
})

// ------------------------------------------------------------------- curves

describe('og curves', () => {
  it('arp type zones use the OG boundaries (spec §3, differ from xd)', () => {
    expect(arpTypeIndex(0)).toBe(0) // MANUAL 1
    expect(arpTypeIndex(78)).toBe(0) // MANUAL 1 upper edge
    expect(arpTypeIndex(79)).toBe(1) // MANUAL 2 lower edge
    expect(arpTypeIndex(945)).toBe(11) // RANDOM 2 upper edge
    expect(arpTypeIndex(946)).toBe(12) // RANDOM 3 lower edge
    expect(arpTypeIndex(1023)).toBe(12)
    expect(ARP_TYPES[12]).toBe('RANDOM 3')
  })

  it('DELAY voice-mode zones use the corrected 512 boundary (spec §15.2)', () => {
    expect(delayModeDivision(0).label).toBe('1/192')
    expect(delayModeDivision(511).label).toBe('1/24')
    expect(delayModeDivision(512).label).toBe('1/16')
    expect(delayModeDivision(1023).label).toBe('1/4')
    // beats: 1/16 note = 0.25 beats (whole note = 4 beats)
    expect(delayModeDivision(512).beats).toBeCloseTo(0.25, 10)
  })

  it('PITCH EG INT uses the erratum-corrected positive rows (spec §15.1)', () => {
    expect(pitchEgIntToCents(0)).toBe(-4800)
    expect(pitchEgIntToCents(512)).toBe(0)
    expect(pitchEgIntToCents(1020)).toBe(4800)
    expect(pitchEgIntToCents(1023)).toBe(4800) // NOT the misprinted 1200
    // midpoint of the corrected 668..1020 row: 1024 -> 4800
    expect(pitchEgIntToCents(844)).toBeCloseTo(2912, 6)
    expect(pitchEgIntToCents(668)).toBeCloseTo(1024, 6)
  })

  it('VCO pitch and EG INT match the shared family tables', () => {
    expect(pitchToCents(0)).toBe(-1200)
    expect(pitchToCents(512)).toBe(0)
    expect(pitchToCents(1023)).toBe(1200)
    expect(egIntToPercent(11)).toBe(-100)
    expect(egIntToPercent(512)).toBe(0)
    expect(egIntToPercent(1013)).toBe(100)
  })

  it('chord zones match the family table', () => {
    expect(CHORDS[chordIndex(0)].name).toBe('5th')
    expect(CHORDS[chordIndex(511)].name).toBe('7')
    expect(CHORDS[chordIndex(512)].name).toBe('7sus4')
    expect(CHORDS[chordIndex(1023)].name).toBe('Maj7b5')
  })

  it('LFO INT is unipolar (spec §8)', () => {
    expect(lfoIntTo01(0)).toBe(0)
    expect(lfoIntTo01(512)).toBeCloseTo(512 / 1023, 10)
    expect(lfoIntTo01(1023)).toBe(1)
  })

  it('program level: stored 77..127 -> -25..+25', () => {
    expect(programLevelToDb(102)).toBe(0)
    expect(programLevelToDb(77)).toBe(-12.5)
    expect(programLevelToDb(127)).toBe(12.5)
  })

  it('portamento: stored 0 = off, 1..129 spans the curve', () => {
    expect(portamentoToSec(0)).toBe(0)
    expect(portamentoToSec(1)).toBeCloseTo(0.003, 6)
    expect(portamentoToSec(129)).toBeCloseTo(5, 1)
  })
})

// ----------------------------------------------------------------- CC decode

describe('og cc decode (rev 1.10)', () => {
  it('CC43 CUTOFF scales 7-bit to raw 0..1023', () => {
    expect(decodeCc(43, 0, null)).toEqual({ kind: 'param', id: P.CUTOFF, v: 0 })
    expect(decodeCc(43, 64, null)).toEqual({ kind: 'param', id: P.CUTOFF, v: 516 })
    expect(decodeCc(43, 127, null)).toEqual({ kind: 'param', id: P.CUTOFF, v: 1023 })
  })

  it('ignores pendingLsb — the OG is 7-bit only, no CC63 scheme', () => {
    expect(decodeCc(43, 127, 5)).toEqual({ kind: 'param', id: P.CUTOFF, v: 1023 })
    expect(decodeCc(63, 7, null)).toBeNull() // CC63 itself is unmapped
  })

  it('CC84 FILTER TYPE decodes in halves', () => {
    expect(decodeCc(84, 0, null)).toEqual({ kind: 'param', id: P.FILTER_TYPE, v: 0 })
    expect(decodeCc(84, 63, null)).toEqual({ kind: 'param', id: P.FILTER_TYPE, v: 0 })
    expect(decodeCc(84, 64, null)).toEqual({ kind: 'param', id: P.FILTER_TYPE, v: 1 })
    expect(decodeCc(84, 127, null)).toEqual({ kind: 'param', id: P.FILTER_TYPE, v: 1 })
  })

  it('CC80 SYNC / CC81 RING receive NORMAL polarity (unlike the xd)', () => {
    expect(decodeCc(80, 0, null)).toEqual({ kind: 'param', id: P.SYNC, v: 0 })
    expect(decodeCc(80, 63, null)).toEqual({ kind: 'param', id: P.SYNC, v: 0 })
    expect(decodeCc(80, 64, null)).toEqual({ kind: 'param', id: P.SYNC, v: 1 })
    expect(decodeCc(81, 127, null)).toEqual({ kind: 'param', id: P.RING, v: 1 })
  })

  it('switch zone tables: octaves in quartiles, waves/routing in thirds', () => {
    // tx values 0/42/84/127 land in the four octave zones
    expect(decodeCc(48, 0, null)).toEqual({ kind: 'param', id: P.VCO1_OCTAVE, v: 0 })
    expect(decodeCc(48, 42, null)).toEqual({ kind: 'param', id: P.VCO1_OCTAVE, v: 1 })
    expect(decodeCc(48, 84, null)).toEqual({ kind: 'param', id: P.VCO1_OCTAVE, v: 2 })
    expect(decodeCc(48, 127, null)).toEqual({ kind: 'param', id: P.VCO1_OCTAVE, v: 3 })
    // thirds: 0-42 / 43-85 / 86-127
    expect(decodeCc(50, 42, null)).toEqual({ kind: 'param', id: P.VCO1_WAVE, v: 0 })
    expect(decodeCc(50, 43, null)).toEqual({ kind: 'param', id: P.VCO1_WAVE, v: 1 })
    expect(decodeCc(50, 86, null)).toEqual({ kind: 'param', id: P.VCO1_WAVE, v: 2 })
    // DELAY ROUTING follows program-data order 0=BYPASS,1=PRE,2=POST (§15.5)
    expect(decodeCc(88, 0, null)).toEqual({ kind: 'param', id: P.DELAY_ROUTING, v: 0 })
    expect(decodeCc(88, 64, null)).toEqual({ kind: 'param', id: P.DELAY_ROUTING, v: 1 })
    expect(decodeCc(88, 127, null)).toEqual({ kind: 'param', id: P.DELAY_ROUTING, v: 2 })
  })

  it('CC45 is the filter EG INT; CC42 the VCO2 pitch EG INT', () => {
    expect(decodeCc(45, 127, null)).toEqual({ kind: 'param', id: P.EG_INT, v: 1023 })
    expect(decodeCc(42, 0, null)).toEqual({ kind: 'param', id: P.PITCH_EG_INT, v: 0 })
  })

  it('CC5 is NOT in the OG map; CC64 sustain decodes (reception UNCONFIRMED)', () => {
    expect(decodeCc(5, 100, null)).toBeNull()
    expect(decodeCc(64, 127, null)).toEqual({ kind: 'sustain', on: true })
    expect(decodeCc(64, 0, null)).toEqual({ kind: 'sustain', on: false })
  })

  it('rejects junk', () => {
    expect(decodeCc(NaN, 64, null)).toBeNull()
    expect(decodeCc(43, NaN, null)).toBeNull()
    expect(decodeCc(-1, 64, null)).toBeNull()
    expect(decodeCc(128, 64, null)).toBeNull()
  })
})
