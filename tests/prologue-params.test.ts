/*
 * prologue data-layer tests: double-width param table integrity (program-
 * global block + two generated timbre blocks), timbre-block symmetry,
 * program serialization round-trip + cross-synth refusal, curve endpoints
 * per docs/prologue-spec.md (incl. the exact MIDIimp piecewise tables), the
 * M.WHEEL destination resolver, and rev 1.01 7-bit CC decode spot checks.
 */
import { describe, expect, it } from 'vitest'
import {
  P,
  RP,
  PARAMS,
  PARAM_COUNT,
  GLOBAL_PARAM_COUNT,
  TIMBRE_PARAM_COUNT,
  REPLICA_PARAM_COUNT,
  TIMBRE_BLOCKS,
  PARAM_BY_KEY,
  clampParam,
  formatParam,
  MOTION_PARAM_IDS,
  MOTION_META,
  wheelDestParam,
  WHEEL_DEST_GATE_TIME,
  WHEEL_DEST_MULTI_SHAPE,
} from '../src/synths/prologue/params'
import { MOTION_PITCH_BEND, MOTION_GATE_TIME } from '../src/shared/paramdef'
import * as prologueProgram from '../src/synths/prologue/program'
import * as xdProgram from '../src/synths/xd/program'
import * as ogProgram from '../src/synths/og/program'
import * as monoProgram from '../src/synths/mono/program'
import {
  pitchToCents,
  pitchEgIntToCents,
  egIntToPercent,
  lfoIntTo01,
  lfoSlowHz,
  lfoFastHz,
  lfoRateToHz,
  LFO_BPM_DIVISIONS,
  lfoBpmDivIndex,
  lfoBpmToHz,
  PROLOGUE_FILTER_CFG,
  LOW_CUT_HZ,
  programLevelToDb,
  portamentoToSec,
  polyDuo,
  unisonDetuneCents,
  monoSubMix,
  voiceSpreadPan,
  CHORDS,
  chordIndex,
  ARP_TYPES,
  ARP_RATES,
  MODFX_TYPES,
  CHORUS_SUBS,
  ENSEMBLE_SUBS,
  PHASER_SUBS,
  FLANGER_SUBS,
  DELAY_SUBS,
  REVERB_SUBS,
  WHEEL_ASSIGN_DESTS,
  noteName,
} from '../src/synths/prologue/curves'
import {
  decodeCc,
  CC_ID_MULTI_SHAPE,
  CC_ID_MULTI_SHIFT_SHAPE,
  CC_ID_MULTI_SUB,
  CC_ID_MODFX_SUB,
  CC_ID_DLRV_SUB,
} from '../src/synths/prologue/cc'

const [T1, T2] = TIMBRE_BLOCKS

// ------------------------------------------------------------- param table

describe('prologue param table', () => {
  it('is the double-width layout: globals + two timbre blocks + replica tail', () => {
    expect(TIMBRE_PARAM_COUNT).toBe(65)
    expect(REPLICA_PARAM_COUNT).toBe(3)
    expect(PARAM_COUNT).toBe(GLOBAL_PARAM_COUNT + 2 * TIMBRE_PARAM_COUNT + REPLICA_PARAM_COUNT)
    expect(PARAM_COUNT).toBe(171)
    // Replica-only deviations sit AFTER the timbre blocks (append-only: the
    // hardware-faithful ids 0..167 never move).
    expect(RP.LF_COMP_ON).toBe(GLOBAL_PARAM_COUNT + 2 * TIMBRE_PARAM_COUNT)
    expect(RP.VOICE_CAP).toBe(PARAM_COUNT - 1)
    expect(PARAMS[RP.LF_COMP_ON].key).toBe('lfCompOn')
    expect(PARAMS[RP.VOICE_CAP].min).toBe(1)
    expect(PARAMS[RP.VOICE_CAP].max).toBe(16)
    expect(PARAMS[RP.VOICE_CAP].def).toBe(16)
  })

  it('builds dense with no duplicate or missing ids', () => {
    expect(PARAMS.length).toBe(PARAM_COUNT)
    for (let i = 0; i < PARAM_COUNT; i++) {
      expect(PARAMS[i]).toBeDefined()
      expect(PARAMS[i].id).toBe(i)
    }
  })

  it('P + TIMBRE_BLOCKS + RP cover every id exactly once', () => {
    const ids = [...Object.values(P), ...Object.values(T1), ...Object.values(T2), ...Object.values(RP)]
    expect(ids.length).toBe(PARAM_COUNT)
    expect(new Set(ids).size).toBe(PARAM_COUNT)
    for (const id of ids) {
      expect(id).toBeGreaterThanOrEqual(0)
      expect(id).toBeLessThan(PARAM_COUNT)
    }
  })

  it('serialization keys are unique and timbre keys carry t1/t2 prefixes', () => {
    expect(new Set(PARAMS.map((p) => p.key)).size).toBe(PARAM_COUNT)
    expect(PARAM_BY_KEY.size).toBe(PARAM_COUNT)
    expect(PARAMS[T1.cutoff].key).toBe('t1Cutoff')
    expect(PARAMS[T2.cutoff].key).toBe('t2Cutoff')
    expect(PARAMS[T1.vco1Wave].key).toBe('t1Vco1Wave')
    expect(PARAMS[T1.cutoff].label).toBe('T1 CUTOFF')
    expect(PARAMS[T2.cutoff].label).toBe('T2 CUTOFF')
  })

  it('every t1 param has a t2 twin with identical meta', () => {
    const names = Object.keys(T1) as (keyof typeof T1)[]
    expect(Object.keys(T2)).toEqual(names as string[])
    expect(names.length).toBe(TIMBRE_PARAM_COUNT)
    for (const name of names) {
      const a = PARAMS[T1[name]]
      const b = PARAMS[T2[name]]
      expect(b.id - a.id).toBe(TIMBRE_PARAM_COUNT)
      expect(a.key.startsWith('t1')).toBe(true)
      expect(b.key).toBe('t2' + a.key.slice(2))
      expect(a.label.startsWith('T1 ')).toBe(true)
      expect(b.label).toBe('T2 ' + a.label.slice(3))
      expect(b.kind).toBe(a.kind)
      expect(b.min).toBe(a.min)
      expect(b.max).toBe(a.max)
      expect(b.def).toBe(a.def)
      expect(b.labels).toEqual(a.labels)
      expect(b.motion).toBe(a.motion)
      expect(b.motionSmooth).toBe(a.motionSmooth)
    }
  })

  it('defaults are in range and clamp respects hardware ranges', () => {
    for (const p of PARAMS) {
      expect(p.def).toBeGreaterThanOrEqual(p.min)
      expect(p.def).toBeLessThanOrEqual(p.max)
    }
    expect(clampParam(P.PROGRAM_LEVEL, 0)).toBe(12) // stored 12..132
    expect(clampParam(P.PROGRAM_LEVEL, 999)).toBe(132)
    expect(clampParam(P.BALANCE, 500)).toBe(127)
    expect(clampParam(P.DLRV_DRYWET, 5000)).toBe(1024) // 0..1024 store
    expect(clampParam(P.ARP_RANGE, 0)).toBe(1) // 1..4 octaves
    expect(clampParam(P.ARP_RANGE, 9)).toBe(4)
    expect(clampParam(T1.portamento, 500)).toBe(127)
    expect(clampParam(T1.vmDepth, 5000)).toBe(1023)
  })

  it('program-data enum orders (MIDIimp TABLE 3)', () => {
    // SYNC/RING exclusive 3-pos, timbre +25: 0=RING,1=OFF,2=SYNC.
    expect(formatParam(T1.syncRing, 0)).toBe('RING')
    expect(formatParam(T1.syncRing, 1)).toBe('OFF')
    expect(formatParam(T1.syncRing, 2)).toBe('SYNC')
    // VCO octaves print 2'->16' (prologue order, REVERSED vs the xd/OG).
    expect(formatParam(T1.vco1Octave, 0)).toBe("2'")
    expect(formatParam(T1.vco1Octave, 3)).toBe("16'")
    expect(PARAMS[T1.vco1Octave].def).toBe(2) // 8'
    // VOICE MODE TYPE, timbre +6 (note P14): POLY/MONO/UNISON/CHORD.
    expect(formatParam(T1.voiceMode, 0)).toBe('POLY')
    expect(formatParam(T1.voiceMode, 1)).toBe('MONO')
    expect(formatParam(T1.voiceMode, 3)).toBe('CHORD')
    // EDIT TIMBRE byte 18: Main/Main+Sub/Sub; TIMBRE TYPE byte 19.
    expect(formatParam(P.EDIT_TIMBRE, 0)).toBe('Main')
    expect(formatParam(P.EDIT_TIMBRE, 2)).toBe('Sub')
    expect(formatParam(P.TIMBRE_TYPE, 1)).toBe('XFADE')
    // DELAY/REVERB 3-way select byte 62: OFF/DELAY/REVERB.
    expect(formatParam(P.DLRV_SELECT, 0)).toBe('OFF')
    expect(formatParam(P.DLRV_SELECT, 1)).toBe('DELAY')
    expect(formatParam(P.DLRV_SELECT, 2)).toBe('REVERB')
    // PITCH EG switch, OM panel order (enum order UNCONFIRMED, spec §16.6).
    expect(formatParam(T1.pitchEgTarget, 0)).toBe('VCO 2')
    expect(formatParam(T1.pitchEgTarget, 2)).toBe('ALL')
    // LFO MODE timbre +71: BPM/SLOW/FAST (no 1-shot).
    expect(formatParam(T1.lfoMode, 0)).toBe('BPM')
    expect(formatParam(T1.lfoMode, 2)).toBe('FAST')
    // Split point formats as a note name (0..127 = C-1..G9).
    expect(formatParam(P.SPLIT_POINT, 60)).toBe('C4')
    // Bipolar center-512 LFO INT shows a sign.
    expect(formatParam(T1.lfoInt, 1023)).toBe('+511')
    expect(formatParam(T1.lfoInt, 512)).toBe('0')
  })

  it('no motion sequencing: only the two virtual targets remain (spec §10)', () => {
    expect(MOTION_PARAM_IDS).toEqual([MOTION_PITCH_BEND, MOTION_GATE_TIME])
    for (const p of PARAMS) expect(p.motion).toBe(false)
    expect(MOTION_META.isSmooth(MOTION_PITCH_BEND)).toBe(true)
    expect(MOTION_META.isSmooth(MOTION_GATE_TIME)).toBe(true)
  })

  it('wheel resolver: 32 dests, per-timbre ids, virtual/engine sentinels', () => {
    expect(WHEEL_ASSIGN_DESTS.length).toBe(32)
    expect(WHEEL_ASSIGN_DESTS[0]).toBe('BALANCE')
    expect(WHEEL_ASSIGN_DESTS[31]).toBe('GATE TIME')
    // BALANCE is a real program-global param, not a sentinel.
    expect(wheelDestParam(0, 0)).toBe(P.BALANCE)
    expect(wheelDestParam(0, 1)).toBe(P.BALANCE)
    // MULTI SHAPE is engine-dependent; GATE TIME is virtual.
    expect(wheelDestParam(10, 0)).toBe(WHEEL_DEST_MULTI_SHAPE)
    expect(wheelDestParam(31, 0)).toBe(WHEEL_DEST_GATE_TIME)
    // Per-timbre scoping without string math.
    expect(wheelDestParam(14, 0)).toBe(T1.cutoff)
    expect(wheelDestParam(14, 1)).toBe(T2.cutoff)
    expect(wheelDestParam(1, 1)).toBe(T2.portamento)
    // Program-global FX dests are shared by both timbres.
    expect(wheelDestParam(29, 0)).toBe(P.DLRV_TIME)
    expect(wheelDestParam(29, 1)).toBe(P.DLRV_TIME)
    expect(wheelDestParam(99, 0)).toBe(WHEEL_DEST_GATE_TIME) // clamped
  })
})

// ------------------------------------------------------------ serialization

describe('prologue program serialization', () => {
  it('round-trips an init program including timbre-2 params', () => {
    const prog = prologueProgram.initProgram('Prologue Trip')
    prog.params[P.BALANCE] = 100
    prog.params[P.DLRV_SELECT] = 2
    prog.params[T1.cutoff] = 700
    prog.params[T2.cutoff] = 300
    prog.params[T2.voiceMode] = 3
    prog.params[T2.wheelAssign] = 31
    const back = prologueProgram.deserializeProgram(prologueProgram.serializeProgram(prog))
    expect(back).not.toBeNull()
    expect(back!.synthId).toBe('prologue')
    expect(back!.name).toBe('Prologue Trip')
    expect(back!.params).toEqual(prog.params)
  })

  it('prologue deserializer refuses other synths (and v1 no-synthId files)', () => {
    const xdJson = xdProgram.serializeProgram(xdProgram.initProgram('XD Prog'))
    const ogJson = ogProgram.serializeProgram(ogProgram.initProgram('OG Prog'))
    const monoJson = monoProgram.serializeProgram(monoProgram.initProgram('Mono Prog'))
    expect(prologueProgram.deserializeProgram(xdJson)).toBeNull()
    expect(prologueProgram.deserializeProgram(ogJson)).toBeNull()
    expect(prologueProgram.deserializeProgram(monoJson)).toBeNull()
    // v1 files predate synthId and are xd programs — refuse those too.
    expect(prologueProgram.deserializeProgram(JSON.stringify({ v: 1, name: 'Old', params: {} }))).toBeNull()
  })

  it('the other deserializers refuse prologue programs', () => {
    const json = prologueProgram.serializeProgram(prologueProgram.initProgram('P Prog'))
    expect(xdProgram.deserializeProgram(json)).toBeNull()
    expect(ogProgram.deserializeProgram(json)).toBeNull()
    expect(monoProgram.deserializeProgram(json)).toBeNull()
  })
})

// ------------------------------------------------------------------- curves

describe('prologue curves', () => {
  it('VCO pitch matches the family piecewise table (MIDIimp P16)', () => {
    expect(pitchToCents(0)).toBe(-1200)
    expect(pitchToCents(4)).toBe(-1200)
    expect(pitchToCents(356)).toBe(-256)
    expect(pitchToCents(512)).toBe(0) // center detent (492..532 flat)
    expect(pitchToCents(668)).toBe(256)
    expect(pitchToCents(1020)).toBe(1200)
    expect(pitchToCents(1023)).toBe(1200)
  })

  it('PITCH EG INT matches the documented +-4800c table (MIDIimp P17)', () => {
    expect(pitchEgIntToCents(0)).toBe(-4800)
    expect(pitchEgIntToCents(4)).toBe(-4800)
    expect(pitchEgIntToCents(356)).toBe(-1024)
    expect(pitchEgIntToCents(512)).toBe(0)
    expect(pitchEgIntToCents(548)).toBe(64)
    expect(pitchEgIntToCents(668)).toBe(1024)
    expect(pitchEgIntToCents(1020)).toBe(4800)
    expect(pitchEgIntToCents(1023)).toBe(4800)
  })

  it('CUTOFF EG INT quadratic matches the exact formula (MIDIimp P20)', () => {
    expect(egIntToPercent(0)).toBe(-100)
    expect(egIntToPercent(11)).toBe(-100)
    expect(egIntToPercent(512)).toBe(0)
    expect(egIntToPercent(1013)).toBe(100)
    expect(egIntToPercent(1023)).toBe(100)
    // Quadratic shape: half-turn is much less than half depth.
    expect(Math.abs(egIntToPercent(772))).toBeLessThan(30)
  })

  it('LFO: bipolar INT, SLOW/FAST ranges, family BPM table (spec §8)', () => {
    expect(lfoIntTo01(512)).toBe(0)
    expect(lfoIntTo01(1023)).toBe(1)
    expect(lfoIntTo01(0)).toBe(-1)
    expect(lfoSlowHz(0)).toBeCloseTo(0.05, 10)
    expect(lfoSlowHz(1023)).toBeCloseTo(28, 10)
    expect(lfoFastHz(0)).toBeCloseTo(0.5, 10)
    expect(lfoFastHz(1023)).toBeCloseTo(2800, 8)
    expect(LFO_BPM_DIVISIONS.length).toBe(16)
    expect(LFO_BPM_DIVISIONS[0].label).toBe('4')
    expect(LFO_BPM_DIVISIONS[15].label).toBe('1/36')
    expect(lfoBpmDivIndex(63)).toBe(0)
    expect(lfoBpmDivIndex(64)).toBe(1)
    // 1/36 note at 120 BPM: 120/60 beats/s over 4/36 beats = 18 Hz.
    expect(lfoBpmToHz(1023, 120)).toBeCloseTo(18, 10)
    // Mode enum 0=BPM, 1=SLOW, 2=FAST.
    expect(lfoRateToHz(600, 0, 120)).toBe(lfoBpmToHz(600, 120))
    expect(lfoRateToHz(600, 1, 120)).toBe(lfoSlowHz(600))
    expect(lfoRateToHz(600, 2, 120)).toBe(lfoFastHz(600))
  })

  it('voice-mode depth zones (MIDIimp P13): POLY/DUO boundary at 256', () => {
    expect(polyDuo(0)).toEqual({ duo: false, amount: 0 })
    expect(polyDuo(255)).toEqual({ duo: false, amount: 0 })
    expect(polyDuo(256)).toEqual({ duo: true, amount: 0 })
    expect(polyDuo(1023).duo).toBe(true)
    expect(polyDuo(1023).amount).toBe(1)
    expect(unisonDetuneCents(0)).toBe(0)
    expect(unisonDetuneCents(1023)).toBe(50)
    const mid = monoSubMix(512)
    expect(mid.sub1).toBeCloseTo(1, 1)
    expect(monoSubMix(0)).toEqual({ sub1: 0, sub2: 0 })
    expect(monoSubMix(1023)).toEqual({ sub1: 1, sub2: 1 })
  })

  it('chord zone table: 14 chords, family boundaries (MIDIimp P13)', () => {
    expect(CHORDS.length).toBe(14)
    expect(chordIndex(0)).toBe(0) // 5th
    expect(chordIndex(73)).toBe(0)
    expect(chordIndex(74)).toBe(1) // sus2
    expect(chordIndex(950)).toBe(12) // mMaj7
    expect(chordIndex(951)).toBe(13) // Maj7b5
    expect(chordIndex(1023)).toBe(13)
    expect(CHORDS[13].name).toBe('Maj7b5')
  })

  it('voice spread pan: symmetric, spread-scaled, safe at 1 voice', () => {
    expect(voiceSpreadPan(1, 0, 16)).toBe(-1)
    expect(voiceSpreadPan(1, 15, 16)).toBe(1)
    expect(voiceSpreadPan(0.5, 0, 16)).toBe(-0.5)
    expect(voiceSpreadPan(0, 7, 16)).toBeCloseTo(0, 12)
    expect(voiceSpreadPan(1, 8, 17)).toBeCloseTo(0, 12) // odd count centers
    expect(voiceSpreadPan(1, 0, 1)).toBe(0)
    // Symmetry: voice i and its mirror sum to zero.
    expect(voiceSpreadPan(1, 3, 16) + voiceSpreadPan(1, 12, 16)).toBeCloseTo(0, 12)
  })

  it('filter voicing: 2-pole, xd-adjacent with a gentler resonance taper', () => {
    expect(PROLOGUE_FILTER_CFG.poles).toBe(2)
    expect(PROLOGUE_FILTER_CFG.driveGains).toEqual([1.0, 2.6, 6.0]) // xd reuse (UNCONFIRMED)
    expect(PROLOGUE_FILTER_CFG.resCurve).toBeLessThan(1.4) // gentler than the xd
    expect(PROLOGUE_FILTER_CFG.resLoss).toBe(0)
    expect(LOW_CUT_HZ).toBe(120) // UNCONFIRMED corner, single calibration point
  })

  it('program level: stored 12..132 -> -18..+6 dB, 102 = 0 dB', () => {
    expect(programLevelToDb(102)).toBe(0)
    expect(programLevelToDb(12)).toBe(-18)
    expect(programLevelToDb(132)).toBeCloseTo(6, 10)
  })

  it('portamento: 0 = off, 127 ~ 5 s', () => {
    expect(portamentoToSec(0)).toBe(0)
    expect(portamentoToSec(1)).toBeGreaterThan(0)
    expect(portamentoToSec(127)).toBeCloseTo(5, 1)
  })

  it('arp tables: 6 types (P12), 11 rates (P9, spec §16.4)', () => {
    expect(ARP_TYPES.length).toBe(6)
    expect(ARP_TYPES[0]).toBe('MANUAL')
    expect(ARP_TYPES[5]).toBe('POLY RANDOM')
    expect(ARP_RATES.length).toBe(11)
    expect(ARP_RATES[0].label).toBe('64th')
    expect(ARP_RATES[10].label).toBe('4th')
    expect(ARP_RATES[10].beats).toBe(1)
  })

  it('FX subtype lists match spec §7 (xd lists; delay 12, reverb 10)', () => {
    expect(MODFX_TYPES.length).toBe(5)
    expect(CHORUS_SUBS.length).toBe(8)
    expect(ENSEMBLE_SUBS.length).toBe(3)
    expect(PHASER_SUBS.length).toBe(8)
    expect(FLANGER_SUBS.length).toBe(8)
    expect(DELAY_SUBS.length).toBe(12)
    expect(DELAY_SUBS[11]).toBe('Doubling')
    expect(REVERB_SUBS.length).toBe(10)
    expect(REVERB_SUBS[9]).toBe('Horror')
  })

  it('split point note names: 0..127 = C-1..G9', () => {
    expect(noteName(0)).toBe('C-1')
    expect(noteName(60)).toBe('C4')
    expect(noteName(127)).toBe('G9')
  })
})

// ----------------------------------------------------------------- CC decode

describe('prologue cc decode (rev 1.01)', () => {
  it('7-bit knobs scale to raw 0..1023 and address TIMBRE 1', () => {
    expect(decodeCc(43, 0, null)).toEqual({ kind: 'param', id: T1.cutoff, v: 0 })
    expect(decodeCc(43, 64, null)).toEqual({ kind: 'param', id: T1.cutoff, v: 516 })
    expect(decodeCc(43, 127, null)).toEqual({ kind: 'param', id: T1.cutoff, v: 1023 })
    expect(decodeCc(45, 127, null)).toEqual({ kind: 'param', id: T1.cutoffEgInt, v: 1023 })
    expect(decodeCc(22, 0, null)).toEqual({ kind: 'param', id: T1.egSustain, v: 0 })
    expect(decodeCc(42, 127, null)).toEqual({ kind: 'param', id: T1.pitchEgInt, v: 1023 })
  })

  it('ignores pendingLsb — the prologue is 7-bit only, no CC63 scheme', () => {
    expect(decodeCc(43, 127, 5)).toEqual({ kind: 'param', id: T1.cutoff, v: 1023 })
    expect(decodeCc(63, 7, null)).toBeNull() // CC63 itself is unmapped
  })

  it('program-global knobs: MOD FX + DL/RV + BALANCE + DRY WET', () => {
    expect(decodeCc(28, 127, null)).toEqual({ kind: 'param', id: P.MODFX_SPEED, v: 1023 })
    expect(decodeCc(30, 0, null)).toEqual({ kind: 'param', id: P.DLRV_TIME, v: 0 })
    expect(decodeCc(8, 100, null)).toEqual({ kind: 'param', id: P.BALANCE, v: 100 })
    // FW2 DRY WET maps onto the 0..1024 store.
    expect(decodeCc(111, 0, null)).toEqual({ kind: 'param', id: P.DLRV_DRYWET, v: 0 })
    expect(decodeCc(111, 127, null)).toEqual({ kind: 'param', id: P.DLRV_DRYWET, v: 1024 })
  })

  it('direct 0..127 params: portamento + voice spread', () => {
    expect(decodeCc(5, 90, null)).toEqual({ kind: 'param', id: T1.portamento, v: 90 })
    expect(decodeCc(14, 127, null)).toEqual({ kind: 'param', id: T1.voiceSpread, v: 127 })
  })

  it('octave CCs land in quartiles with 2\' first (prologue enum order)', () => {
    // tx values 0/42/84/127 land in the four zones.
    expect(decodeCc(48, 0, null)).toEqual({ kind: 'param', id: T1.vco1Octave, v: 0 }) // 2'
    expect(decodeCc(48, 42, null)).toEqual({ kind: 'param', id: T1.vco1Octave, v: 1 })
    expect(decodeCc(49, 84, null)).toEqual({ kind: 'param', id: T1.vco2Octave, v: 2 })
    expect(decodeCc(52, 127, null)).toEqual({ kind: 'param', id: T1.multiOctave, v: 3 }) // 16'
    expect(formatParam(T1.vco1Octave, 0)).toBe("2'")
  })

  it('CC80 RING-SYNC tri-state in program order (not the xd inverted pair)', () => {
    expect(decodeCc(80, 0, null)).toEqual({ kind: 'param', id: T1.syncRing, v: 0 }) // RING
    expect(decodeCc(80, 64, null)).toEqual({ kind: 'param', id: T1.syncRing, v: 1 }) // OFF
    expect(decodeCc(80, 127, null)).toEqual({ kind: 'param', id: T1.syncRing, v: 2 }) // SYNC
  })

  it('CC85 TIMBRE EDIT zones (SUB/+/MAIN) flip onto the program enum', () => {
    expect(decodeCc(85, 0, null)).toEqual({ kind: 'param', id: P.EDIT_TIMBRE, v: 2 }) // Sub
    expect(decodeCc(85, 64, null)).toEqual({ kind: 'param', id: P.EDIT_TIMBRE, v: 1 }) // Main+Sub
    expect(decodeCc(85, 127, null)).toEqual({ kind: 'param', id: P.EDIT_TIMBRE, v: 0 }) // Main
  })

  it('CC88 MOD FX TYPE receives FIVE zones incl. USER (spec §16.2)', () => {
    // tx values 0/38/64/84/127 land in the five zones.
    expect(decodeCc(88, 0, null)).toEqual({ kind: 'param', id: P.MODFX_TYPE, v: 0 })
    expect(decodeCc(88, 38, null)).toEqual({ kind: 'param', id: P.MODFX_TYPE, v: 1 })
    expect(decodeCc(88, 64, null)).toEqual({ kind: 'param', id: P.MODFX_TYPE, v: 2 })
    expect(decodeCc(88, 84, null)).toEqual({ kind: 'param', id: P.MODFX_TYPE, v: 3 })
    expect(decodeCc(88, 127, null)).toEqual({ kind: 'param', id: P.MODFX_TYPE, v: 4 })
  })

  it('CC89 DELAY/REVERB halves: no OFF via CC', () => {
    expect(decodeCc(89, 0, null)).toEqual({ kind: 'param', id: P.DLRV_SELECT, v: 1 }) // DELAY
    expect(decodeCc(89, 63, null)).toEqual({ kind: 'param', id: P.DLRV_SELECT, v: 1 })
    expect(decodeCc(89, 64, null)).toEqual({ kind: 'param', id: P.DLRV_SELECT, v: 2 }) // REVERB
    expect(decodeCc(89, 127, null)).toEqual({ kind: 'param', id: P.DLRV_SELECT, v: 2 })
  })

  it('FX on/offs and LOW CUT are plain halves', () => {
    expect(decodeCc(92, 127, null)).toEqual({ kind: 'param', id: P.MODFX_ON, v: 1 })
    expect(decodeCc(94, 0, null)).toEqual({ kind: 'param', id: P.DLRV_ON, v: 0 })
    expect(decodeCc(82, 0, null)).toEqual({ kind: 'param', id: T1.lowCut, v: 0 })
    expect(decodeCc(82, 127, null)).toEqual({ kind: 'param', id: T1.lowCut, v: 1 })
  })

  it('engine-dependent CCs decode to sentinel negative ids', () => {
    // Shapes carry raw 0..1023; sub-type selects carry raw 0..127 (the app
    // zone-divides by the active type).
    expect(decodeCc(54, 127, null)).toEqual({ kind: 'param', id: CC_ID_MULTI_SHAPE, v: 1023 })
    expect(decodeCc(104, 64, null)).toEqual({ kind: 'param', id: CC_ID_MULTI_SHIFT_SHAPE, v: 516 })
    expect(decodeCc(103, 100, null)).toEqual({ kind: 'param', id: CC_ID_MULTI_SUB, v: 100 })
    expect(decodeCc(96, 77, null)).toEqual({ kind: 'param', id: CC_ID_MODFX_SUB, v: 77 })
    // CC97 is receive-only on hardware; decoding IS receiving, so it maps.
    expect(decodeCc(97, 33, null)).toEqual({ kind: 'param', id: CC_ID_DLRV_SUB, v: 33 })
  })

  it('CC64 damper decodes as sustain', () => {
    expect(decodeCc(64, 127, null)).toEqual({ kind: 'sustain', on: true })
    expect(decodeCc(64, 0, null)).toEqual({ kind: 'sustain', on: false })
  })

  it('port-level and unmapped CCs return null', () => {
    expect(decodeCc(1, 100, null)).toBeNull() // mod wheel: port-level mapping
    expect(decodeCc(2, 100, null)).toBeNull()
    expect(decodeCc(59, 64, null)).toBeNull()
    expect(decodeCc(105, 64, null)).toBeNull() // xd 10-bit delay CCs don't exist here
  })

  it('rejects junk', () => {
    expect(decodeCc(NaN, 64, null)).toBeNull()
    expect(decodeCc(43, NaN, null)).toBeNull()
    expect(decodeCc(-1, 64, null)).toBeNull()
    expect(decodeCc(128, 64, null)).toBeNull()
  })
})
