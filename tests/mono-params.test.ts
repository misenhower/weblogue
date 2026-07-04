/*
 * monologue data-layer tests: param table integrity, program serialization
 * round-trip + cross-synth refusal, the monologue's program-data enum orders
 * (SYNC/RING, EG TYPE, VCO2 WAVE with NOISE, LFO MODE), curve endpoints per
 * docs/monologue-spec.md, and rev 1.00 CC decode spot checks.
 */
import { describe, expect, it } from 'vitest'
import { P, PARAMS, PARAM_COUNT, PARAM_BY_KEY, clampParam, formatParam, MOTION_PARAM_IDS, MOTION_META, sliderDestParam, SLIDER_DEST_PITCH_BEND, SLIDER_DEST_GATE_TIME } from '../src/synths/mono/params'
import { MOTION_PITCH_BEND, MOTION_GATE_TIME } from '../src/shared/paramdef'
import * as monoProgram from '../src/synths/mono/program'
import * as ogProgram from '../src/synths/og/program'
import * as xdProgram from '../src/synths/xd/program'
import {
  pitchToCents,
  egIntTo01,
  egIntToCents,
  EG_MAX_PITCH_CENTS,
  lfoIntTo01,
  lfoSlowHz,
  lfoFastHz,
  lfoRateToHz,
  LFO_BPM_DIVISIONS,
  lfoBpmDivIndex,
  lfoBpmToHz,
  MONO_FILTER_CFG,
  MONO_DRIVE_CFG,
  driveAmount01,
  programLevelToDb,
  portamentoToSec,
  slideTimeToSec,
  SLIDER_ASSIGN_DESTS,
  MICRO_TUNINGS,
  fmtEgIntBipolar,
} from '../src/synths/mono/curves'
import { decodeCc } from '../src/synths/mono/cc'

// ------------------------------------------------------------- param table

describe('mono param table', () => {
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
    expect(clampParam(P.SLIDE_TIME, 100)).toBe(72) // 0..72 = 0..100%
    expect(clampParam(P.DRIVE, 2000)).toBe(1023) // continuous knob (spec §7)
    // Replica ships the family microtuning subset, NOT the hardware's 0..139.
    expect(clampParam(P.MICRO_TUNING, 139)).toBe(MICRO_TUNINGS.length - 1)
  })

  it('program-data enum orders (spec §3/§5/§6/§9)', () => {
    // VCO waves: 0=SQR,1=TRI,2=SAW; VCO2 swaps NOISE in for SQR.
    expect(formatParam(P.VCO1_WAVE, 0)).toBe('SQR')
    expect(formatParam(P.VCO1_WAVE, 2)).toBe('SAW')
    expect(formatParam(P.VCO2_WAVE, 0)).toBe('NOISE')
    expect(formatParam(P.VCO2_WAVE, 1)).toBe('TRI')
    // SYNC/RING exclusive 3-pos: 0=RING,1=OFF,2=SYNC (byte 32 b0-1).
    expect(formatParam(P.SYNC_RING, 0)).toBe('RING')
    expect(formatParam(P.SYNC_RING, 1)).toBe('OFF')
    expect(formatParam(P.SYNC_RING, 2)).toBe('SYNC')
    // EG TYPE: 0=GATE,1=A/G/D,2=A/D (byte 34 b0-1 — panel prints the reverse).
    expect(formatParam(P.EG_TYPE, 0)).toBe('GATE')
    expect(formatParam(P.EG_TYPE, 1)).toBe('A/G/D')
    expect(formatParam(P.EG_TYPE, 2)).toBe('A/D')
    // EG TARGET: 0=CUTOFF,1=PITCH 2,2=PITCH.
    expect(formatParam(P.EG_TARGET, 1)).toBe('PITCH 2')
    // LFO MODE: 0=1-SHOT,1=SLOW,2=FAST (byte 36 b2-3).
    expect(formatParam(P.LFO_MODE, 0)).toBe('1-SHOT')
    expect(formatParam(P.LFO_MODE, 2)).toBe('FAST')
  })

  it('bipolar center-512 knobs display -511..+511 with sign', () => {
    expect(formatParam(P.EG_INT, 512)).toBe('0')
    expect(formatParam(P.EG_INT, 1023)).toBe('+511')
    expect(formatParam(P.EG_INT, 0)).toBe('-511')
    expect(formatParam(P.LFO_INT, 612)).toBe('+100')
    expect(fmtEgIntBipolar(412)).toBe('-100')
  })

  it('menu formats: portamento quirk, slide time %, program level dB', () => {
    expect(formatParam(P.PORTAMENTO, 0)).toBe('Off')
    expect(formatParam(P.PORTAMENTO, 1)).toBe('0')
    expect(formatParam(P.PORTAMENTO, 129)).toBe('128')
    expect(formatParam(P.SLIDE_TIME, 72)).toBe('100%')
    expect(formatParam(P.SLIDE_TIME, 0)).toBe('0%')
    expect(formatParam(P.PROGRAM_LEVEL, 102)).toBe('0.0dB')
    expect(formatParam(P.KEY_TRIG, 2)).toBe('HOLD')
  })

  it('motion covers panel knobs/switches + the panel-less VCO1 params (spec §8)', () => {
    for (const id of [P.DRIVE, P.SYNC_RING, P.EG_TYPE, P.CUTOFF, P.VCO1_PITCH, P.VCO1_OCTAVE]) {
      expect(MOTION_PARAM_IDS).toContain(id)
      expect(MOTION_META.isTarget(id)).toBe(true)
    }
    // Excluded: kbd OCTAVE (spec §8 names it), the KEY TRG/HOLD button
    // (transport state, ARP_LATCH precedent), and menu params.
    expect(MOTION_PARAM_IDS).not.toContain(P.OCTAVE)
    expect(MOTION_PARAM_IDS).not.toContain(P.KEY_TRIG)
    expect(MOTION_PARAM_IDS).not.toContain(P.SLIDE_TIME)
    expect(MOTION_PARAM_IDS).not.toContain(P.PORTAMENTO)
    expect(MOTION_PARAM_IDS).toContain(MOTION_PITCH_BEND)
    expect(MOTION_PARAM_IDS).toContain(MOTION_GATE_TIME)
    // Switch-type lanes are stepped, knob lanes smoothable.
    expect(MOTION_META.isSmooth(P.SYNC_RING)).toBe(false)
    expect(MOTION_META.isSmooth(P.VCO1_OCTAVE)).toBe(false)
    expect(MOTION_META.isSmooth(P.DRIVE)).toBe(true)
    expect(MOTION_META.isSmooth(P.VCO1_PITCH)).toBe(true)
  })

  it('slider: 16 destinations, default PITCH BEND (spec §11)', () => {
    expect(SLIDER_ASSIGN_DESTS.length).toBe(16)
    expect(PARAMS[P.SLIDER_ASSIGN].def).toBe(0)
    expect(formatParam(P.SLIDER_ASSIGN, 0)).toBe('PITCH BEND')
    expect(sliderDestParam(0)).toBe(SLIDER_DEST_PITCH_BEND)
    expect(sliderDestParam(1)).toBe(SLIDER_DEST_GATE_TIME)
    expect(sliderDestParam(2)).toBe(P.VCO1_PITCH)
    expect(sliderDestParam(8)).toBe(P.CUTOFF)
    expect(sliderDestParam(10)).toBe(P.EG_ATTACK)
    expect(sliderDestParam(12)).toBe(P.EG_INT)
    expect(sliderDestParam(15)).toBe(P.DRIVE)
    expect(sliderDestParam(99)).toBe(P.DRIVE) // clamped to the last dest
  })
})

// ------------------------------------------------------------ serialization

describe('mono program serialization', () => {
  it('round-trips an init program', () => {
    const prog = monoProgram.initProgram('Mono Round Trip')
    prog.params[P.CUTOFF] = 700
    prog.params[P.DRIVE] = 800
    prog.params[P.EG_TYPE] = 2
    prog.params[P.PROGRAM_LEVEL] = 90
    const back = monoProgram.deserializeProgram(monoProgram.serializeProgram(prog))
    expect(back).not.toBeNull()
    expect(back!.synthId).toBe('mono')
    expect(back!.name).toBe('Mono Round Trip')
    expect(back!.params).toEqual(prog.params)
  })

  it('round-trips the per-step slide flag (absent in old files reads back off)', () => {
    const prog = monoProgram.initProgram('Slide Trip')
    prog.seq.steps[0] = { on: true, notes: [60], vels: [100], gates: [54], slide: true }
    prog.seq.steps[1] = { on: true, notes: [62], vels: [100], gates: [54] } // no flag
    const back = monoProgram.deserializeProgram(monoProgram.serializeProgram(prog))
    expect(back!.seq.steps[0].slide).toBe(true)
    expect(back!.seq.steps[1].slide).toBeUndefined() // slide-less steps stay keyless
  })

  it('mono deserializer refuses xd/og programs (and v1 no-synthId files)', () => {
    const xdJson = xdProgram.serializeProgram(xdProgram.initProgram('XD Prog'))
    const ogJson = ogProgram.serializeProgram(ogProgram.initProgram('OG Prog'))
    expect(monoProgram.deserializeProgram(xdJson)).toBeNull()
    expect(monoProgram.deserializeProgram(ogJson)).toBeNull()
    // v1 files predate synthId and are xd programs — refuse those too.
    expect(monoProgram.deserializeProgram(JSON.stringify({ v: 1, name: 'Old', params: {} }))).toBeNull()
  })

  it('xd and og deserializers refuse mono programs', () => {
    const monoJson = monoProgram.serializeProgram(monoProgram.initProgram('Mono Prog'))
    expect(xdProgram.deserializeProgram(monoJson)).toBeNull()
    expect(ogProgram.deserializeProgram(monoJson)).toBeNull()
  })
})

// ------------------------------------------------------------------- curves

describe('mono curves', () => {
  it('VCO pitch matches the family piecewise table (spec §3)', () => {
    expect(pitchToCents(0)).toBe(-1200)
    expect(pitchToCents(4)).toBe(-1200)
    expect(pitchToCents(356)).toBe(-256)
    expect(pitchToCents(512)).toBe(0) // center detent (492..532 flat)
    expect(pitchToCents(668)).toBe(256)
    expect(pitchToCents(1020)).toBe(1200)
    expect(pitchToCents(1023)).toBe(1200)
  })

  it('EG INT / LFO INT are bipolar around center 512 (spec §5/§6)', () => {
    expect(egIntTo01(512)).toBe(0)
    expect(egIntTo01(1023)).toBe(1)
    expect(egIntTo01(0)).toBe(-1) // -512/511 clamps to -1
    expect(egIntToCents(1023)).toBe(EG_MAX_PITCH_CENTS)
    expect(egIntToCents(512)).toBe(0)
    expect(lfoIntTo01(512)).toBe(0)
    expect(lfoIntTo01(1023)).toBe(1)
    expect(lfoIntTo01(0)).toBe(-1)
  })

  it('LFO rate curves per mode: SLOW 0.05..28 Hz, FAST 0.5..2800 Hz (spec §6)', () => {
    expect(lfoSlowHz(0)).toBeCloseTo(0.05, 10)
    expect(lfoSlowHz(1023)).toBeCloseTo(28, 10)
    expect(lfoFastHz(0)).toBeCloseTo(0.5, 10)
    expect(lfoFastHz(1023)).toBeCloseTo(2800, 8)
    // Param enum: 0=1-SHOT (slow range), 1=SLOW, 2=FAST.
    expect(lfoRateToHz(600, 0)).toBe(lfoSlowHz(600))
    expect(lfoRateToHz(600, 1)).toBe(lfoSlowHz(600))
    expect(lfoRateToHz(600, 2)).toBe(lfoFastHz(600))
  })

  it('BPM-sync uses the family 16-zone table (MIDIimp; spec §15.5)', () => {
    expect(LFO_BPM_DIVISIONS.length).toBe(16)
    expect(LFO_BPM_DIVISIONS[0].label).toBe('4')
    expect(LFO_BPM_DIVISIONS[15].label).toBe('1/36')
    expect(lfoBpmDivIndex(0)).toBe(0)
    expect(lfoBpmDivIndex(63)).toBe(0)
    expect(lfoBpmDivIndex(64)).toBe(1)
    expect(lfoBpmDivIndex(1023)).toBe(15)
    // 1/36 note at 120 BPM: 120/60 beats/s over 4/36 beats = 18 Hz.
    expect(lfoBpmToHz(1023, 120)).toBeCloseTo(18, 10)
  })

  it('filter voicing keeps its bass and self-oscillates (spec §4)', () => {
    expect(MONO_FILTER_CFG.resLoss).toBe(0) // no OG-style level loss
    expect(MONO_FILTER_CFG.kMin).toBe(0) // self-oscillation at r = 1
    expect(MONO_FILTER_CFG.poles).toBe(2) // 12 dB/oct
    expect(MONO_FILTER_CFG.driveGains).toBeNull() // drive is post-VCA, not in-filter
    expect(MONO_FILTER_CFG.bassComp).toBeGreaterThan(0)
  })

  it('drive amount + voicing constants', () => {
    expect(driveAmount01(0)).toBe(0)
    expect(driveAmount01(1023)).toBe(1)
    expect(driveAmount01(2000)).toBe(1)
    expect(MONO_DRIVE_CFG.gainMax).toBeGreaterThan(1)
  })

  it('program level: stored 77..127 -> -12.5..+12.5 dB (0.5 dB steps)', () => {
    expect(programLevelToDb(102)).toBe(0)
    expect(programLevelToDb(77)).toBe(-12.5)
    expect(programLevelToDb(127)).toBe(12.5)
  })

  it('portamento: stored 0 = off, 1..129 spans the curve (byte-41 quirk)', () => {
    expect(portamentoToSec(0)).toBe(0)
    expect(portamentoToSec(1)).toBeCloseTo(0.003, 6)
    expect(portamentoToSec(129)).toBeCloseTo(5, 1)
  })

  it('slide time: 0..72 -> 0..~0.5 s (UNCONFIRMED musical guess)', () => {
    expect(slideTimeToSec(0)).toBe(0)
    expect(slideTimeToSec(36)).toBeCloseTo(0.25, 10)
    expect(slideTimeToSec(72)).toBeCloseTo(0.5, 10)
    expect(slideTimeToSec(100)).toBeCloseTo(0.5, 10) // clamped
  })
})

// ----------------------------------------------------------------- CC decode

describe('mono cc decode (rev 1.00)', () => {
  it('CC43 CUTOFF scales 7-bit to raw 0..1023', () => {
    expect(decodeCc(43, 0, null)).toEqual({ kind: 'param', id: P.CUTOFF, v: 0 })
    expect(decodeCc(43, 64, null)).toEqual({ kind: 'param', id: P.CUTOFF, v: 516 })
    expect(decodeCc(43, 127, null)).toEqual({ kind: 'param', id: P.CUTOFF, v: 1023 })
  })

  it('ignores pendingLsb — the monologue is 7-bit only, no CC63 scheme', () => {
    expect(decodeCc(43, 127, 5)).toEqual({ kind: 'param', id: P.CUTOFF, v: 1023 })
    expect(decodeCc(63, 7, null)).toBeNull() // CC63 itself is unmapped
  })

  it('CC28 DRIVE is a continuous knob; CC34 VCO1 PITCH receives (rx-only)', () => {
    expect(decodeCc(28, 64, null)).toEqual({ kind: 'param', id: P.DRIVE, v: 516 })
    expect(decodeCc(34, 127, null)).toEqual({ kind: 'param', id: P.VCO1_PITCH, v: 1023 })
    expect(decodeCc(25, 0, null)).toEqual({ kind: 'param', id: P.EG_INT, v: 0 })
    expect(decodeCc(26, 127, null)).toEqual({ kind: 'param', id: P.LFO_INT, v: 1023 })
  })

  it('CC60 SYNC/RING tri-state: RING/OFF/SYNC zones', () => {
    expect(decodeCc(60, 0, null)).toEqual({ kind: 'param', id: P.SYNC_RING, v: 0 }) // RING
    expect(decodeCc(60, 42, null)).toEqual({ kind: 'param', id: P.SYNC_RING, v: 0 })
    expect(decodeCc(60, 43, null)).toEqual({ kind: 'param', id: P.SYNC_RING, v: 1 }) // OFF
    expect(decodeCc(60, 64, null)).toEqual({ kind: 'param', id: P.SYNC_RING, v: 1 })
    expect(decodeCc(60, 86, null)).toEqual({ kind: 'param', id: P.SYNC_RING, v: 2 }) // SYNC
    expect(decodeCc(60, 127, null)).toEqual({ kind: 'param', id: P.SYNC_RING, v: 2 })
  })

  it('CC51 VCO2 WAVE zones start at NOISE (spec §10)', () => {
    expect(decodeCc(51, 0, null)).toEqual({ kind: 'param', id: P.VCO2_WAVE, v: 0 }) // NOISE
    expect(decodeCc(51, 64, null)).toEqual({ kind: 'param', id: P.VCO2_WAVE, v: 1 }) // TRI
    expect(decodeCc(51, 127, null)).toEqual({ kind: 'param', id: P.VCO2_WAVE, v: 2 }) // SAW
    expect(formatParam(P.VCO2_WAVE, 0)).toBe('NOISE')
  })

  it('CC61 EG TYPE zones follow program-data order GATE / A/G/D / A/D', () => {
    expect(decodeCc(61, 0, null)).toEqual({ kind: 'param', id: P.EG_TYPE, v: 0 }) // GATE
    expect(decodeCc(61, 64, null)).toEqual({ kind: 'param', id: P.EG_TYPE, v: 1 }) // A/G/D
    expect(decodeCc(61, 127, null)).toEqual({ kind: 'param', id: P.EG_TYPE, v: 2 }) // A/D
  })

  it('CC59 LFO MODE zones: 1-SHOT/SLOW/FAST; CC48/49 octaves in quartiles', () => {
    expect(decodeCc(59, 0, null)).toEqual({ kind: 'param', id: P.LFO_MODE, v: 0 })
    expect(decodeCc(59, 127, null)).toEqual({ kind: 'param', id: P.LFO_MODE, v: 2 })
    // tx values 0/42/84/127 land in the four octave zones
    expect(decodeCc(48, 0, null)).toEqual({ kind: 'param', id: P.VCO1_OCTAVE, v: 0 })
    expect(decodeCc(48, 42, null)).toEqual({ kind: 'param', id: P.VCO1_OCTAVE, v: 1 })
    expect(decodeCc(49, 84, null)).toEqual({ kind: 'param', id: P.VCO2_OCTAVE, v: 2 })
    expect(decodeCc(49, 127, null)).toEqual({ kind: 'param', id: P.VCO2_OCTAVE, v: 3 })
  })

  it('CC64 sustain decodes (no damper input — reception UNCONFIRMED)', () => {
    expect(decodeCc(64, 127, null)).toEqual({ kind: 'sustain', on: true })
    expect(decodeCc(64, 0, null)).toEqual({ kind: 'sustain', on: false })
  })

  it('unmapped CCs return null (no CC5, no OG CC80/81 pair)', () => {
    expect(decodeCc(5, 100, null)).toBeNull()
    expect(decodeCc(80, 127, null)).toBeNull()
    expect(decodeCc(81, 127, null)).toBeNull()
    expect(decodeCc(88, 64, null)).toBeNull()
  })

  it('rejects junk', () => {
    expect(decodeCc(NaN, 64, null)).toBeNull()
    expect(decodeCc(43, NaN, null)).toBeNull()
    expect(decodeCc(-1, 64, null)).toBeNull()
    expect(decodeCc(128, 64, null)).toBeNull()
  })
})
