/*
 * tools/calib/lib/ccmap.ts — the inverse CC map must round-trip through the
 * real decoder: every message sequence it emits, fed through decodeCc with
 * pendingLsb threaded exactly like src/midi/midi.ts (a 'lsb' result arms the
 * NEXT cc only), lands back on {kind:'param', id, v: raw}.
 */
import { describe, expect, it } from 'vitest'
import { encodeParamCc, ccControlledParamIds, type CcMsg } from '../tools/calib/lib/ccmap'
import {
  decodeCc,
  CC_ID_MULTI_SHAPE,
  CC_ID_MULTI_SHIFT_SHAPE,
  CC_ID_MULTI_SUB,
  CC_ID_MODFX_SUB,
} from '../src/synths/xd/cc'
import { P } from '../src/synths/xd/params'
import type { DecodedCc } from '../src/midi/midi'

/** Feed a CC sequence through decodeCc, threading pendingLsb like midi.ts. */
function decodeSeq(msgs: readonly CcMsg[]): DecodedCc[] {
  const out: DecodedCc[] = []
  let pending: number | null = null
  for (const m of msgs) {
    const pend = pending // a pending LSB applies to this CC only
    pending = null
    const r = decodeCc(m.cc, m.value, pend)
    if (!r) continue
    if (r.kind === 'lsb') pending = r.v
    else out.push(r)
  }
  return out
}

function mustEncode(id: number, raw: number): CcMsg[] {
  const msgs = encodeParamCc(id, raw)
  if (!msgs) throw new Error(`expected a CC encoding for param ${id}`)
  return msgs
}

/** Round-trip: encode, decode, assert exactly one param result = (id, raw). */
function expectRoundTrip(id: number, raw: number): void {
  const results = decodeSeq(mustEncode(id, raw))
  expect(results, `param ${id} raw ${raw}`).toEqual([{ kind: 'param', id, v: raw }])
}

const TEN_BIT_IDS = [
  P.AMP_ATTACK, P.AMP_DECAY, P.AMP_SUSTAIN, P.AMP_RELEASE,
  P.EG_ATTACK, P.EG_DECAY, P.EG_INT,
  P.LFO_RATE, P.LFO_INT, P.VM_DEPTH,
  P.MODFX_TIME, P.MODFX_DEPTH, P.MULTI_LEVEL,
  P.VCO1_PITCH, P.VCO2_PITCH, P.VCO1_SHAPE, P.VCO2_SHAPE,
  P.VCO1_LEVEL, P.VCO2_LEVEL, P.CROSS_MOD,
  P.CUTOFF, P.RESONANCE,
  CC_ID_MULTI_SHAPE, CC_ID_MULTI_SHIFT_SHAPE,
  P.DELAY_TIME, P.DELAY_DEPTH, P.DELAY_DRYWET,
  P.REVERB_TIME, P.REVERB_DEPTH, P.REVERB_DRYWET,
] as const

const SWITCHES: ReadonlyArray<readonly [string, number, number]> = [
  ['EG_TARGET', P.EG_TARGET, 3],
  ['VCO1_OCTAVE', P.VCO1_OCTAVE, 4],
  ['VCO2_OCTAVE', P.VCO2_OCTAVE, 4],
  ['VCO1_WAVE', P.VCO1_WAVE, 3],
  ['VCO2_WAVE', P.VCO2_WAVE, 3],
  ['MULTI_TYPE', P.MULTI_TYPE, 3],
  ['LFO_TARGET', P.LFO_TARGET, 3],
  ['LFO_WAVE', P.LFO_WAVE, 3],
  ['LFO_MODE', P.LFO_MODE, 3],
  ['KEYTRACK', P.KEYTRACK, 3],
  ['DRIVE', P.DRIVE, 3],
  ['MODFX_TYPE', P.MODFX_TYPE, 5],
]

describe('10-bit params (CC63 LSB then value CC)', () => {
  const raws = [0, 1, 7, 8, 511, 512, 777, 1023]

  it('emits [{cc:63, value: raw&7}, {cc, value: raw>>3}]', () => {
    for (const id of TEN_BIT_IDS) {
      for (const raw of raws) {
        const msgs = mustEncode(id, raw)
        expect(msgs).toHaveLength(2)
        expect(msgs[0]).toEqual({ cc: 63, value: raw & 7 })
        expect(msgs[1].value).toBe(raw >> 3)
      }
    }
  })

  it('round-trips every raw through decodeCc', () => {
    for (const id of TEN_BIT_IDS) {
      for (const raw of raws) expectRoundTrip(id, raw)
    }
  })
})

describe('zone switches (single CC at the zone center)', () => {
  it('centers survive the decoder for every zone of every switch', () => {
    for (const [name, id, zones] of SWITCHES) {
      for (let zone = 0; zone < zones; zone++) {
        const msgs = mustEncode(id, zone)
        expect(msgs, `${name} zone ${zone}`).toHaveLength(1)
        const { value } = msgs[0]
        expect(value).toBe(Math.floor((zone * 128 + 64) / zones))
        expect((value * zones) >> 7, `${name} zone ${zone} center`).toBe(zone)
        expectRoundTrip(id, zone)
      }
    }
  })
})

describe('directly mapped CCs', () => {
  it('CC5 portamento is 0..127 direct', () => {
    for (const raw of [0, 64, 127]) {
      expect(mustEncode(P.PORTAMENTO, raw)).toEqual([{ cc: 5, value: raw }])
      expectRoundTrip(P.PORTAMENTO, raw)
    }
  })

  it('CC80 SYNC / CC81 RING use NORMAL polarity (spec §15 "inverted" disproven on hardware 2026-07-11)', () => {
    expect(mustEncode(P.SYNC, 1)).toEqual([{ cc: 80, value: 127 }])
    expect(mustEncode(P.SYNC, 0)).toEqual([{ cc: 80, value: 0 }])
    expect(mustEncode(P.RING, 1)).toEqual([{ cc: 81, value: 127 }])
    expect(mustEncode(P.RING, 0)).toEqual([{ cc: 81, value: 0 }])
    for (const id of [P.SYNC, P.RING]) {
      expectRoundTrip(id, 0)
      expectRoundTrip(id, 1)
    }
  })

  it('FX ON CCs 92/93/94 use normal polarity', () => {
    const fx: ReadonlyArray<readonly [number, number]> = [
      [P.MODFX_ON, 92],
      [P.DELAY_ON, 93],
      [P.REVERB_ON, 94],
    ]
    for (const [id, cc] of fx) {
      expect(mustEncode(id, 1)).toEqual([{ cc, value: 127 }])
      expect(mustEncode(id, 0)).toEqual([{ cc, value: 0 }])
      expectRoundTrip(id, 0)
      expectRoundTrip(id, 1)
    }
  })

  it('CC89 DELAY_SUB round-trips internal zones 0..11', () => {
    for (let z = 0; z <= 11; z++) {
      const msgs = mustEncode(P.DELAY_SUB, z)
      expect(msgs).toEqual([{ cc: 89, value: Math.floor((z * 128 + 64) / 20) }])
      expectRoundTrip(P.DELAY_SUB, z)
    }
  })

  it('CC90 REVERB_SUB round-trips internal zones 0..9', () => {
    for (let z = 0; z <= 9; z++) {
      const msgs = mustEncode(P.REVERB_SUB, z)
      expect(msgs).toEqual([{ cc: 90, value: Math.floor((z * 128 + 64) / 18) }])
      expectRoundTrip(P.REVERB_SUB, z)
    }
  })

  it('CC103 MULTI SUB sentinel parks mid-zone, zones 0..15', () => {
    for (let z = 0; z <= 15; z++) {
      expect(mustEncode(CC_ID_MULTI_SUB, z)).toEqual([{ cc: 103, value: (z << 3) + 4 }])
      expectRoundTrip(CC_ID_MULTI_SUB, z)
    }
  })

  it('CC96 MODFX SUB sentinel is raw passthrough 0..127', () => {
    for (const raw of [0, 64, 127]) {
      expect(mustEncode(CC_ID_MODFX_SUB, raw)).toEqual([{ cc: 96, value: raw }])
      expectRoundTrip(CC_ID_MODFX_SUB, raw)
    }
  })
})

describe('params without a CC', () => {
  it('returns null for panel/menu params absent from the cc.ts tables', () => {
    const noCc = [
      P.VOICE_MODE,
      P.MULTI_OCTAVE,
      P.SELECT_NOISE,
      P.SELECT_VPM,
      P.ARP_RATE,
      P.PROGRAM_LEVEL,
      P.MICRO_TUNING,
      P.MULTI_ROUTING,
    ]
    for (const id of noCc) expect(encodeParamCc(id, 0), `param ${id}`).toBeNull()
    expect(encodeParamCc(9999, 0)).toBeNull()
  })
})

describe('ccControlledParamIds', () => {
  it('matches the union of the cc.ts tables', () => {
    const ids = ccControlledParamIds()
    // 30 ten-bit (incl. 2 sentinels) + 12 switches + 10 direct = 52
    expect(ids).toHaveLength(52)
    expect(new Set(ids).size).toBe(52)
    for (const id of TEN_BIT_IDS) expect(ids).toContain(id)
    for (const [, id] of SWITCHES) expect(ids).toContain(id)
    for (const id of [CC_ID_MULTI_SUB, CC_ID_MODFX_SUB]) expect(ids).toContain(id)
  })

  it('every listed id encodes; every unlisted P id does not', () => {
    const supported = new Set(ccControlledParamIds())
    for (const id of supported) {
      const msgs = encodeParamCc(id, 0)
      expect(msgs, `param ${id}`).not.toBeNull()
      for (const m of msgs ?? []) {
        expect(m.cc).toBeGreaterThanOrEqual(0)
        expect(m.cc).toBeLessThanOrEqual(127)
        expect(m.value).toBeGreaterThanOrEqual(0)
        expect(m.value).toBeLessThanOrEqual(127)
        expect(Number.isInteger(m.value)).toBe(true)
      }
    }
    for (const id of Object.values(P)) {
      if (!supported.has(id)) expect(encodeParamCc(id, 0), `param ${id}`).toBeNull()
    }
  })
})
