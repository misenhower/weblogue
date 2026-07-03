import { describe, expect, it } from 'vitest'
import {
  MidiInput,
  type MidiAccessLike,
  type MidiHandlers,
  type MidiInputPortLike,
  type MidiMessageEventLike,
} from '../src/midi/midi'
import {
  CC_ID_MODFX_SUB,
  CC_ID_MULTI_SHAPE,
  CC_ID_MULTI_SHIFT_SHAPE,
  CC_ID_MULTI_SUB,
  decodeCc,
} from '../src/synths/xd/cc'
import { P } from '../src/synths/xd/params'

// ---------------------------------------------------------------------------
// decodeCc — pure decoder
// ---------------------------------------------------------------------------

describe('decodeCc 10-bit params', () => {
  it('CC63 stores the lower 3 bits as pending LSB', () => {
    expect(decodeCc(63, 5, null)).toEqual({ kind: 'lsb', v: 5 })
    expect(decodeCc(63, 0b1111101, null)).toEqual({ kind: 'lsb', v: 5 }) // masked to 3 bits
  })

  it('cutoff sequence: CC63 lsb then CC43 msb -> v10 = (msb<<3)|lsb', () => {
    const lsb = decodeCc(63, 5, null)
    expect(lsb).toEqual({ kind: 'lsb', v: 5 })
    expect(decodeCc(43, 100, 5)).toEqual({ kind: 'param', id: P.CUTOFF, v: (100 << 3) | 5 })
  })

  it('missing pending LSB defaults to 0', () => {
    expect(decodeCc(43, 100, null)).toEqual({ kind: 'param', id: P.CUTOFF, v: 800 })
  })

  it('full scale reaches 1023', () => {
    expect(decodeCc(43, 127, 7)).toEqual({ kind: 'param', id: P.CUTOFF, v: 1023 })
  })

  it('maps the whole 10-bit CC set to the right params', () => {
    const cases: Array<[number, number]> = [
      [16, P.AMP_ATTACK],
      [17, P.AMP_DECAY],
      [18, P.AMP_SUSTAIN],
      [19, P.AMP_RELEASE],
      [20, P.EG_ATTACK],
      [21, P.EG_DECAY],
      [22, P.EG_INT],
      [24, P.LFO_RATE],
      [26, P.LFO_INT],
      [27, P.VM_DEPTH],
      [28, P.MODFX_TIME],
      [29, P.MODFX_DEPTH],
      [33, P.MULTI_LEVEL],
      [34, P.VCO1_PITCH],
      [35, P.VCO2_PITCH],
      [36, P.VCO1_SHAPE],
      [37, P.VCO2_SHAPE],
      [39, P.VCO1_LEVEL],
      [40, P.VCO2_LEVEL],
      [41, P.CROSS_MOD],
      [43, P.CUTOFF],
      [44, P.RESONANCE],
      [105, P.DELAY_TIME],
      [106, P.DELAY_DEPTH],
      [107, P.DELAY_DRYWET],
      [108, P.REVERB_TIME],
      [109, P.REVERB_DEPTH],
      [110, P.REVERB_DRYWET],
    ]
    for (const [cc, id] of cases) {
      expect(decodeCc(cc, 64, 3)).toEqual({ kind: 'param', id, v: (64 << 3) | 3 })
    }
  })

  it('engine-dependent shape CCs emit sentinel ids with 10-bit values', () => {
    expect(decodeCc(54, 100, 2)).toEqual({ kind: 'param', id: CC_ID_MULTI_SHAPE, v: 802 })
    expect(CC_ID_MULTI_SHAPE).toBe(-54)
    expect(decodeCc(104, 1, null)).toEqual({ kind: 'param', id: CC_ID_MULTI_SHIFT_SHAPE, v: 8 })
    expect(CC_ID_MULTI_SHIFT_SHAPE).toBe(-104)
  })
})

describe('decodeCc zone switches', () => {
  it('thirds boundaries (CC23 EG TARGET)', () => {
    expect(decodeCc(23, 0, null)).toEqual({ kind: 'param', id: P.EG_TARGET, v: 0 })
    expect(decodeCc(23, 42, null)).toEqual({ kind: 'param', id: P.EG_TARGET, v: 0 })
    expect(decodeCc(23, 43, null)).toEqual({ kind: 'param', id: P.EG_TARGET, v: 1 })
    expect(decodeCc(23, 85, null)).toEqual({ kind: 'param', id: P.EG_TARGET, v: 1 })
    expect(decodeCc(23, 86, null)).toEqual({ kind: 'param', id: P.EG_TARGET, v: 2 })
    expect(decodeCc(23, 127, null)).toEqual({ kind: 'param', id: P.EG_TARGET, v: 2 })
  })

  it('quartile boundaries (CC48/49 VCO octaves)', () => {
    const q: Array<[number, number]> = [
      [0, 0],
      [31, 0],
      [32, 1],
      [63, 1],
      [64, 2],
      [95, 2],
      [96, 3],
      [127, 3],
    ]
    for (const [v, zone] of q) {
      expect(decodeCc(48, v, null)).toEqual({ kind: 'param', id: P.VCO1_OCTAVE, v: zone })
      expect(decodeCc(49, v, null)).toEqual({ kind: 'param', id: P.VCO2_OCTAVE, v: zone })
    }
  })

  it('fifth boundaries (CC88 MODFX TYPE)', () => {
    const f: Array<[number, number]> = [
      [0, 0],
      [25, 0],
      [26, 1],
      [51, 1],
      [52, 2],
      [76, 2],
      [77, 3],
      [102, 3],
      [103, 4],
      [127, 4],
    ]
    for (const [v, zone] of f) {
      expect(decodeCc(88, v, null)).toEqual({ kind: 'param', id: P.MODFX_TYPE, v: zone })
    }
  })

  it('remaining thirds switches map to the right params', () => {
    expect(decodeCc(50, 127, null)).toEqual({ kind: 'param', id: P.VCO1_WAVE, v: 2 })
    expect(decodeCc(51, 60, null)).toEqual({ kind: 'param', id: P.VCO2_WAVE, v: 1 })
    expect(decodeCc(53, 0, null)).toEqual({ kind: 'param', id: P.MULTI_TYPE, v: 0 })
    expect(decodeCc(56, 127, null)).toEqual({ kind: 'param', id: P.LFO_TARGET, v: 2 })
    expect(decodeCc(57, 50, null)).toEqual({ kind: 'param', id: P.LFO_WAVE, v: 1 })
    expect(decodeCc(58, 90, null)).toEqual({ kind: 'param', id: P.LFO_MODE, v: 2 })
    expect(decodeCc(83, 43, null)).toEqual({ kind: 'param', id: P.KEYTRACK, v: 1 })
    expect(decodeCc(84, 86, null)).toEqual({ kind: 'param', id: P.DRIVE, v: 2 })
  })

  it('CC89 delay sub: 20-zone table, USER zones ignored', () => {
    expect(decodeCc(89, 0, null)).toEqual({ kind: 'param', id: P.DELAY_SUB, v: 0 })
    expect(decodeCc(89, 71, null)).toEqual({ kind: 'param', id: P.DELAY_SUB, v: 11 }) // last internal
    expect(decodeCc(89, 77, null)).toBeNull() // zone 12 = first USER
    expect(decodeCc(89, 127, null)).toBeNull() // zone 19
  })

  it('CC90 reverb sub: 18-zone table, USER zones ignored', () => {
    expect(decodeCc(90, 0, null)).toEqual({ kind: 'param', id: P.REVERB_SUB, v: 0 })
    expect(decodeCc(90, 70, null)).toEqual({ kind: 'param', id: P.REVERB_SUB, v: 9 }) // Horror
    expect(decodeCc(90, 72, null)).toBeNull() // zone 10 = first USER
    expect(decodeCc(90, 127, null)).toBeNull()
  })

  it('CC96 mod fx sub passes raw value with sentinel id', () => {
    expect(decodeCc(96, 77, null)).toEqual({ kind: 'param', id: CC_ID_MODFX_SUB, v: 77 })
    expect(CC_ID_MODFX_SUB).toBe(-96)
  })

  it('CC103 multi sub emits 0..15 zone with sentinel id', () => {
    expect(decodeCc(103, 0, null)).toEqual({ kind: 'param', id: CC_ID_MULTI_SUB, v: 0 })
    expect(decodeCc(103, 8, null)).toEqual({ kind: 'param', id: CC_ID_MULTI_SUB, v: 1 })
    expect(decodeCc(103, 127, null)).toEqual({ kind: 'param', id: CC_ID_MULTI_SUB, v: 15 })
    expect(CC_ID_MULTI_SUB).toBe(-103)
  })
})

describe('decodeCc toggles and specials', () => {
  it('SYNC/RING receive with INVERTED polarity (0-63 = ON)', () => {
    expect(decodeCc(80, 0, null)).toEqual({ kind: 'param', id: P.SYNC, v: 1 })
    expect(decodeCc(80, 63, null)).toEqual({ kind: 'param', id: P.SYNC, v: 1 })
    expect(decodeCc(80, 64, null)).toEqual({ kind: 'param', id: P.SYNC, v: 0 })
    expect(decodeCc(80, 127, null)).toEqual({ kind: 'param', id: P.SYNC, v: 0 })
    expect(decodeCc(81, 0, null)).toEqual({ kind: 'param', id: P.RING, v: 1 })
    expect(decodeCc(81, 127, null)).toEqual({ kind: 'param', id: P.RING, v: 0 })
  })

  it('FX ON switches use normal polarity (>=64 = ON)', () => {
    expect(decodeCc(92, 0, null)).toEqual({ kind: 'param', id: P.MODFX_ON, v: 0 })
    expect(decodeCc(92, 127, null)).toEqual({ kind: 'param', id: P.MODFX_ON, v: 1 })
    expect(decodeCc(93, 63, null)).toEqual({ kind: 'param', id: P.DELAY_ON, v: 0 })
    expect(decodeCc(93, 64, null)).toEqual({ kind: 'param', id: P.DELAY_ON, v: 1 })
    expect(decodeCc(94, 127, null)).toEqual({ kind: 'param', id: P.REVERB_ON, v: 1 })
  })

  it('sustain CC64: >=64 on', () => {
    expect(decodeCc(64, 0, null)).toEqual({ kind: 'sustain', on: false })
    expect(decodeCc(64, 63, null)).toEqual({ kind: 'sustain', on: false })
    expect(decodeCc(64, 64, null)).toEqual({ kind: 'sustain', on: true })
    expect(decodeCc(64, 127, null)).toEqual({ kind: 'sustain', on: true })
  })

  it('CC5 portamento 0..127 direct', () => {
    expect(decodeCc(5, 0, null)).toEqual({ kind: 'param', id: P.PORTAMENTO, v: 0 })
    expect(decodeCc(5, 100, null)).toEqual({ kind: 'param', id: P.PORTAMENTO, v: 100 })
  })

  it('CC59 is unmapped (spec §13): ignored, so 14-bit CC27/59 pairs stay intact', () => {
    expect(decodeCc(59, 127, null)).toBeNull()
    expect(decodeCc(59, 32, null)).toBeNull()
  })

  it('unknown CCs return null', () => {
    for (const cc of [3, 4, 9, 25, 42, 55, 102, 111, 127]) {
      expect(decodeCc(cc, 64, null)).toBeNull()
    }
  })

  it('port-level CCs (bank/joy/panic) are not decoded here', () => {
    for (const cc of [0, 1, 2, 32, 120, 123]) {
      expect(decodeCc(cc, 64, null)).toBeNull()
    }
  })

  it('guards non-finite input', () => {
    expect(decodeCc(NaN, 64, null)).toBeNull()
    expect(decodeCc(43, NaN, null)).toBeNull()
    expect(decodeCc(Infinity, 64, null)).toBeNull()
    expect(decodeCc(43, 64, NaN)).toEqual({ kind: 'param', id: P.CUTOFF, v: 512 })
    expect(decodeCc(-1, 64, null)).toBeNull()
    expect(decodeCc(200, 64, null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// MidiInput with a fake MIDIAccess
// ---------------------------------------------------------------------------

class FakePort implements MidiInputPortLike {
  onmidimessage: ((e: MidiMessageEventLike) => void) | null = null
  constructor(
    public readonly id: string,
    public readonly name: string
  ) {}
  send(bytes: number[]): void {
    this.onmidimessage?.({ data: new Uint8Array(bytes) })
  }
}

class FakeAccess implements MidiAccessLike {
  onstatechange: ((e: unknown) => void) | null = null
  readonly portMap = new Map<string, FakePort>()
  get inputs() {
    return this.portMap
  }
  addPort(port: FakePort): void {
    this.portMap.set(port.id, port)
    this.onstatechange?.({})
  }
  removePort(id: string): void {
    this.portMap.delete(id)
    this.onstatechange?.({})
  }
}

type Call = [string, ...unknown[]]

function makeHandlers(): { calls: Call[]; handlers: MidiHandlers } {
  const calls: Call[] = []
  const handlers: MidiHandlers = {
    noteOn: (note, vel) => calls.push(['noteOn', note, vel]),
    noteOff: (note) => calls.push(['noteOff', note]),
    bend: (v) => calls.push(['bend', v]),
    sustain: (on) => calls.push(['sustain', on]),
    param: (id, v) => calls.push(['param', id, v]),
    channelPressure: (v) => calls.push(['channelPressure', v]),
    programChange: (bankLsb, prog) => calls.push(['programChange', bankLsb, prog]),
    connectionChange: () => calls.push(['connectionChange']),
    joyY: (v) => calls.push(['joyY', v]),
    joyYMinus: (v) => calls.push(['joyYMinus', v]),
    panic: () => calls.push(['panic']),
    decodeCc,
  }
  return { calls, handlers }
}

async function setup(portIds: string[] = ['a']) {
  const access = new FakeAccess()
  for (const id of portIds) access.portMap.set(id, new FakePort(id, 'Port ' + id.toUpperCase()))
  const { calls, handlers } = makeHandlers()
  const midi = new MidiInput(handlers, async () => access)
  const ok = await midi.init()
  expect(ok).toBe(true)
  return { access, calls, midi }
}

describe('MidiInput init/availability', () => {
  it('returns false when Web MIDI is unavailable', async () => {
    const { handlers } = makeHandlers()
    const midi = new MidiInput(handlers) // node env: no navigator.requestMIDIAccess
    expect(await midi.init()).toBe(false)
    expect(midi.inputs()).toEqual([])
  })

  it('returns false when access is denied (request rejects)', async () => {
    const { handlers } = makeHandlers()
    const midi = new MidiInput(handlers, async () => {
      throw new DOMException('denied')
    })
    expect(await midi.init()).toBe(false)
  })

  it('lists connected inputs after init', async () => {
    const { midi } = await setup(['a', 'b'])
    expect(midi.inputs()).toEqual([
      { id: 'a', name: 'Port A' },
      { id: 'b', name: 'Port B' },
    ])
  })
})

describe('MidiInput note routing', () => {
  it('routes note on/off; velocity 0 note-on = note off', async () => {
    const { access, calls } = await setup()
    const port = access.portMap.get('a')!
    port.send([0x90, 60, 100])
    port.send([0x90, 60, 0])
    port.send([0x80, 61, 64])
    expect(calls).toEqual([
      ['noteOn', 60, 100],
      ['noteOff', 60],
      ['noteOff', 61],
    ])
  })

  it('pitch bend maps 14-bit to -1..1 with exact center and extremes', async () => {
    const { access, calls } = await setup()
    const port = access.portMap.get('a')!
    port.send([0xe0, 0, 64]) // 8192 center
    port.send([0xe0, 127, 127]) // 16383 max
    port.send([0xe0, 0, 0]) // 0 min
    expect(calls).toEqual([
      ['bend', 0],
      ['bend', 1],
      ['bend', -1],
    ])
  })

  it('channel pressure scales to 0..1', async () => {
    const { access, calls } = await setup()
    const port = access.portMap.get('a')!
    port.send([0xd0, 127])
    port.send([0xd0, 0])
    expect(calls).toEqual([
      ['channelPressure', 1],
      ['channelPressure', 0],
    ])
  })

  it('program change carries the last bank select LSB (CC32)', async () => {
    const { access, calls } = await setup()
    const port = access.portMap.get('a')!
    port.send([0xc0, 25]) // no bank yet -> 0
    port.send([0xb0, 32, 3])
    port.send([0xc0, 25])
    expect(calls).toEqual([
      ['programChange', 0, 25],
      ['programChange', 3, 25],
    ])
  })

  it('ignores system realtime and short messages', async () => {
    const { access, calls } = await setup()
    const port = access.portMap.get('a')!
    port.send([0xf8])
    port.send([0xfe])
    port.send([0x90, 60]) // truncated
    port.send([64, 64]) // data byte without status (no running status support)
    expect(calls).toEqual([])
  })
})

describe('MidiInput channel + port filtering', () => {
  it('channel filter drops other channels; omni accepts all', async () => {
    const { access, calls, midi } = await setup()
    const port = access.portMap.get('a')!
    midi.setChannel(1)
    port.send([0x90, 60, 100]) // ch 1 -> accepted
    port.send([0x91, 62, 100]) // ch 2 -> dropped
    midi.setChannel(2)
    port.send([0x91, 63, 100]) // ch 2 -> accepted
    midi.setChannel('omni')
    port.send([0x9f, 64, 100]) // ch 16 -> accepted
    expect(calls).toEqual([
      ['noteOn', 60, 100],
      ['noteOn', 63, 100],
      ['noteOn', 64, 100],
    ])
  })

  it('invalid channel values are ignored (stays on previous setting)', async () => {
    const { access, calls, midi } = await setup()
    const port = access.portMap.get('a')!
    midi.setChannel(1)
    midi.setChannel(NaN)
    midi.setChannel(0)
    midi.setChannel(17)
    port.send([0x90, 60, 100]) // ch 1 still active
    port.send([0x91, 61, 100])
    expect(calls).toEqual([['noteOn', 60, 100]])
  })

  it('input filter selects a single port; "all" restores both', async () => {
    const { access, calls, midi } = await setup(['a', 'b'])
    const pa = access.portMap.get('a')!
    const pb = access.portMap.get('b')!
    midi.setInput('a')
    pa.send([0x90, 60, 100])
    pb.send([0x90, 61, 100]) // dropped
    midi.setInput('all')
    pb.send([0x90, 62, 100])
    expect(calls).toEqual([
      ['noteOn', 60, 100],
      ['noteOn', 62, 100],
    ])
  })
})

describe('MidiInput CC handling', () => {
  it('10-bit cutoff via CC63 then CC43', async () => {
    const { access, calls } = await setup()
    const port = access.portMap.get('a')!
    port.send([0xb0, 63, 5])
    port.send([0xb0, 43, 100])
    expect(calls).toEqual([['param', P.CUTOFF, 805]])
  })

  it('pending LSB is consumed once and tracked per port', async () => {
    const { access, calls } = await setup(['a', 'b'])
    const pa = access.portMap.get('a')!
    const pb = access.portMap.get('b')!
    pa.send([0xb0, 63, 7]) // pending LSB on port a only
    pb.send([0xb0, 43, 10]) // port b has no pending -> lsb 0
    pa.send([0xb0, 43, 10]) // port a uses 7
    pa.send([0xb0, 43, 10]) // consumed -> back to 0
    expect(calls).toEqual([
      ['param', P.CUTOFF, 80],
      ['param', P.CUTOFF, 87],
      ['param', P.CUTOFF, 80],
    ])
  })

  it('sustain, joystick and panic CCs route to their handlers', async () => {
    const { access, calls } = await setup()
    const port = access.portMap.get('a')!
    port.send([0xb0, 64, 127])
    port.send([0xb0, 64, 0])
    port.send([0xb0, 1, 127])
    port.send([0xb0, 2, 64])
    port.send([0xb0, 123, 0])
    port.send([0xb0, 120, 0])
    expect(calls).toEqual([
      ['sustain', true],
      ['sustain', false],
      ['joyY', 1],
      ['joyYMinus', 64 / 127],
      ['panic'],
      ['panic'],
    ])
  })

  it('zone switch CC goes through as a param', async () => {
    const { access, calls } = await setup()
    const port = access.portMap.get('a')!
    port.send([0xb0, 84, 127]) // DRIVE 100%
    port.send([0xb0, 80, 0]) // SYNC inverted -> ON
    expect(calls).toEqual([
      ['param', P.DRIVE, 2],
      ['param', P.SYNC, 1],
    ])
  })
})

describe('MidiInput connection lifecycle', () => {
  it('fires connectionChange and attaches new ports on statechange', async () => {
    const { access, calls } = await setup(['a'])
    const late = new FakePort('c', 'Late Port')
    access.addPort(late)
    expect(calls).toEqual([['connectionChange']])
    late.send([0x90, 70, 90])
    expect(calls[1]).toEqual(['noteOn', 70, 90])
  })

  it('detaches removed ports and updates inputs()', async () => {
    const { access, calls, midi } = await setup(['a', 'b'])
    const pb = access.portMap.get('b')!
    access.removePort('b')
    expect(calls).toEqual([['connectionChange']])
    expect(midi.inputs()).toEqual([{ id: 'a', name: 'Port A' }])
    expect(pb.onmidimessage).toBeNull()
  })

  it('dispose detaches everything and stops routing', async () => {
    const { access, calls, midi } = await setup()
    const port = access.portMap.get('a')!
    midi.dispose()
    expect(port.onmidimessage).toBeNull()
    expect(midi.inputs()).toEqual([])
    port.send([0x90, 60, 100]) // no-op, handler detached
    expect(calls).toEqual([])
  })

  it('reset clears pending LSB and bank state', async () => {
    const { access, calls, midi } = await setup()
    const port = access.portMap.get('a')!
    port.send([0xb0, 63, 7])
    port.send([0xb0, 32, 5])
    midi.reset()
    port.send([0xb0, 43, 10]) // lsb gone -> 80
    port.send([0xc0, 3]) // bank gone -> 0
    expect(calls).toEqual([
      ['param', P.CUTOFF, 80],
      ['programChange', 0, 3],
    ])
  })
})
