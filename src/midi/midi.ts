/*
 * Web MIDI input mapped to the minilogue xd's own MIDI implementation
 * (docs/xd-spec.md §13).
 *
 * Panel params arrive in OUR raw units (param ids from shared/params.ts):
 * 10-bit knobs 0..1023, zone switches as small ints, portamento 0..127.
 *
 * 10-bit protocol: CC#63 carries the LOWER 3 BITS of the next 10-bit value
 * and arrives BEFORE the value CC; v10 = (msb7 << 3) | lsb3. If no LSB is
 * pending, lsb = 0. The pending LSB is tracked per input port.
 *
 * Engine-dependent CCs cannot be resolved here (we do not know which multi
 * engine / mod-fx type is active), so they are emitted with sentinel NEGATIVE
 * ids that the app must resolve:
 *   CC54  MULTI SHAPE        -> id CC_ID_MULTI_SHAPE       (-54),  v = 10-bit 0..1023
 *   CC104 MULTI SHIFT SHAPE  -> id CC_ID_MULTI_SHIFT_SHAPE (-104), v = 10-bit 0..1023
 *   CC103 MULTI SUB (type)   -> id CC_ID_MULTI_SUB         (-103), v = zone 0..15
 *   CC96  MOD FX SUB         -> id CC_ID_MODFX_SUB         (-96),  v = raw 0..127
 * (-54 maps to the active engine's SHAPE_x param, -104 to SHIFTSHAPE_x,
 * -103 to SELECT_NOISE/SELECT_VPM/SELECT_USER, -96 to the active MODFX_SUB_x.)
 *
 * Polarity quirks (docs/xd-spec.md §15): CC80 SYNC and CC81 RING receive
 * INVERTED — 0..63 = ON, 64..127 = OFF. FX ON CCs 92/93/94 are normal
 * (>= 64 = ON).
 *
 * The module never touches `navigator` at import time, so it is safe to
 * import in tests / SSR; init() returns false when Web MIDI is unavailable.
 */
import { P } from '../synths/xd/params'

// ---------------------------------------------------------------------------
// Sentinel ids for engine-dependent CCs (resolved by the app).
// ---------------------------------------------------------------------------
export const CC_ID_MULTI_SHAPE = -54
export const CC_ID_MULTI_SHIFT_SHAPE = -104
export const CC_ID_MULTI_SUB = -103
export const CC_ID_MODFX_SUB = -96

// ---------------------------------------------------------------------------
// Handler interface
// ---------------------------------------------------------------------------
export interface MidiHandlers {
  noteOn(note: number, vel: number): void
  noteOff(note: number): void
  bend(v: number): void // -1..1
  sustain(on: boolean): void
  /** Decoded panel param in OUR raw units. Negative id = sentinel (see above). */
  param(id: number, v: number): void
  channelPressure(v: number): void // 0..1
  programChange(bankLsb: number, prog: number): void
  connectionChange(): void
  joyY(v: number): void // CC1 (Joy Y+), 0..1
  joyYMinus(v: number): void // CC2 (Joy Y-), 0..1
  panic(): void // CC120 all sound off / CC123 all notes off
}

// ---------------------------------------------------------------------------
// Structural Web-MIDI-shaped types so tests can inject a fake MIDIAccess.
// ---------------------------------------------------------------------------
export interface MidiMessageEventLike {
  readonly data: Uint8Array | null
}
export interface MidiInputPortLike {
  readonly id: string
  readonly name?: string | null
  onmidimessage: ((e: MidiMessageEventLike) => void) | null
}
export interface MidiAccessLike {
  readonly inputs: { forEach(cb: (port: MidiInputPortLike, id: string) => void): void }
  onstatechange: ((e: unknown) => void) | null
}
export type RequestMidiAccess = () => Promise<MidiAccessLike>

// ---------------------------------------------------------------------------
// CC decode tables (docs/xd-spec.md §13)
// ---------------------------------------------------------------------------
const NO = -32768 // "no mapping" marker (param ids can be 0 or small negatives)

/** CCs whose value is the top 7 bits of a 10-bit param (CC63 = lower 3). */
const TEN_BIT = new Int16Array(128).fill(NO)
/** Zone-switch CCs: param id + number of equal zones dividing 0..127. */
const SWITCH_ID = new Int16Array(128).fill(NO)
const SWITCH_ZONES = new Uint8Array(128)

{
  const ten: ReadonlyArray<readonly [number, number]> = [
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
    [54, CC_ID_MULTI_SHAPE],
    [104, CC_ID_MULTI_SHIFT_SHAPE],
    [105, P.DELAY_TIME],
    [106, P.DELAY_DEPTH],
    [107, P.DELAY_DRYWET],
    [108, P.REVERB_TIME],
    [109, P.REVERB_DEPTH],
    [110, P.REVERB_DRYWET],
  ]
  for (const [cc, id] of ten) TEN_BIT[cc] = id

  const sw: ReadonlyArray<readonly [number, number, number]> = [
    [23, P.EG_TARGET, 3], // thirds: CUTOFF / PITCH 2 / PITCH
    [48, P.VCO1_OCTAVE, 4], // quartiles: 16'/8'/4'/2'
    [49, P.VCO2_OCTAVE, 4],
    [50, P.VCO1_WAVE, 3], // thirds: SQR/TRI/SAW
    [51, P.VCO2_WAVE, 3],
    [53, P.MULTI_TYPE, 3], // NOISE/VPM/USR
    [56, P.LFO_TARGET, 3],
    [57, P.LFO_WAVE, 3],
    [58, P.LFO_MODE, 3],
    [83, P.KEYTRACK, 3],
    [84, P.DRIVE, 3],
    [88, P.MODFX_TYPE, 5], // fifths: CHORUS/ENSEMBLE/PHASER/FLANGER/USER
  ]
  for (const [cc, id, zones] of sw) {
    SWITCH_ID[cc] = id
    SWITCH_ZONES[cc] = zones
  }
}

/** Delay sub table: 12 internal + 8 USER = 20 zones; USER zones ignored. */
const DELAY_SUB_ZONES = 20
const DELAY_SUB_MAX = 11
/** Reverb sub table: 10 internal + 8 USER = 18 zones; USER zones ignored. */
const REVERB_SUB_ZONES = 18
const REVERB_SUB_MAX = 9

export type DecodedCc =
  | { kind: 'param'; id: number; v: number }
  | { kind: 'lsb'; v: number }
  | { kind: 'sustain'; on: boolean }

/**
 * Decode one control change per the xd CC map. Pure — pendingLsb (lower 3
 * bits from a preceding CC63, or null) is passed in explicitly so the decoder
 * is unit-testable without MIDI hardware. Returns null for unmapped CCs and
 * for CCs handled at the port level (CC0/1/2/32/120/123).
 */
export function decodeCc(
  cc: number,
  value: number,
  pendingLsb: number | null
): { kind: 'param'; id: number; v: number } | { kind: 'lsb'; v: number } | { kind: 'sustain'; on: boolean } | null {
  if (!Number.isFinite(cc) || !Number.isFinite(value)) return null
  const c = cc | 0
  if (c < 0 || c > 127) return null
  const v = value <= 0 ? 0 : value >= 127 ? 127 : value | 0

  switch (c) {
    case 63: // 10-bit LSB, arrives before the value CC
      return { kind: 'lsb', v: v & 7 }
    case 64: // sustain pedal
      return { kind: 'sustain', on: v >= 64 }
    case 5: // portamento, 0..127 direct
      return { kind: 'param', id: P.PORTAMENTO, v }
    // NOTE: CC59 is deliberately unmapped (spec §13); decoding it as a 7-bit
    // VM DEPTH would corrupt 14-bit CC27/CC59 MSB/LSB pairs from DAWs.
    case 80: // OSC SYNC — INVERTED receive polarity: 0..63 = ON
      return { kind: 'param', id: P.SYNC, v: v <= 63 ? 1 : 0 }
    case 81: // RING MOD — INVERTED receive polarity: 0..63 = ON
      return { kind: 'param', id: P.RING, v: v <= 63 ? 1 : 0 }
    case 92:
      return { kind: 'param', id: P.MODFX_ON, v: v >= 64 ? 1 : 0 }
    case 93:
      return { kind: 'param', id: P.DELAY_ON, v: v >= 64 ? 1 : 0 }
    case 94:
      return { kind: 'param', id: P.REVERB_ON, v: v >= 64 ? 1 : 0 }
    case 89: {
      const z = (v * DELAY_SUB_ZONES) >> 7
      return z <= DELAY_SUB_MAX ? { kind: 'param', id: P.DELAY_SUB, v: z } : null
    }
    case 90: {
      const z = (v * REVERB_SUB_ZONES) >> 7
      return z <= REVERB_SUB_MAX ? { kind: 'param', id: P.REVERB_SUB, v: z } : null
    }
    case 96: // MOD FX SUB — zone count depends on active type; app resolves
      return { kind: 'param', id: CC_ID_MODFX_SUB, v }
    case 103: // MULTI SUB — 16 zones; app routes to the active engine select
      return { kind: 'param', id: CC_ID_MULTI_SUB, v: v >> 3 }
  }

  const tenId = TEN_BIT[c]
  if (tenId !== NO) {
    const lsb = pendingLsb == null || !Number.isFinite(pendingLsb) ? 0 : pendingLsb & 7
    return { kind: 'param', id: tenId, v: (v << 3) | lsb }
  }

  const swId = SWITCH_ID[c]
  if (swId !== NO) {
    return { kind: 'param', id: swId, v: (v * SWITCH_ZONES[c]) >> 7 }
  }

  return null
}

// ---------------------------------------------------------------------------
// MidiInput — owns MIDIAccess, port attachment, channel/port filtering and
// per-port decode state (pending 10-bit LSB, bank select LSB).
// ---------------------------------------------------------------------------
export class MidiInput {
  private readonly handlers: MidiHandlers
  private readonly requestAccess: RequestMidiAccess | null
  private access: MidiAccessLike | null = null
  private ports = new Map<string, MidiInputPortLike>()
  private pending = new Map<string, number>() // per-port pending 10-bit LSB
  private bankLsb = new Map<string, number>() // per-port CC32 bank select LSB
  private inputFilter: string | 'all' = 'all'
  private channel: number | 'omni' = 'omni' // 1..16 or 'omni'

  /** `requestAccess` is a test seam; production uses navigator.requestMIDIAccess. */
  constructor(handlers: MidiHandlers, requestAccess?: RequestMidiAccess) {
    this.handlers = handlers
    this.requestAccess = requestAccess ?? null
  }

  /** Resolves false if Web MIDI is unsupported or permission is denied. */
  async init(): Promise<boolean> {
    if (this.access) return true
    try {
      let access: MidiAccessLike
      if (this.requestAccess) {
        access = await this.requestAccess()
      } else {
        const nav = (globalThis as { navigator?: Navigator }).navigator
        if (!nav || typeof nav.requestMIDIAccess !== 'function') return false
        access = (await nav.requestMIDIAccess({ sysex: false })) as unknown as MidiAccessLike
      }
      if (!access) return false
      this.access = access
      access.onstatechange = () => {
        this.sync()
        this.handlers.connectionChange()
      }
      this.sync()
      return true
    } catch {
      this.access = null
      return false
    }
  }

  inputs(): { id: string; name: string }[] {
    const out: { id: string; name: string }[] = []
    this.ports.forEach((port) => out.push({ id: port.id, name: port.name ?? port.id }))
    return out
  }

  /** Listen to a single port by id, or 'all' (default). */
  setInput(id: string | 'all'): void {
    this.inputFilter = id
  }

  /** MIDI receive channel 1..16, or 'omni' (default). Invalid values ignored. */
  setChannel(ch: number | 'omni'): void {
    if (ch === 'omni') {
      this.channel = 'omni'
      return
    }
    if (typeof ch !== 'number' || !Number.isFinite(ch)) return
    const c = Math.round(ch)
    if (c >= 1 && c <= 16) this.channel = c
  }

  /** Clear transient decode state (pending LSBs, bank select). */
  reset(): void {
    this.pending.clear()
    this.bankLsb.clear()
  }

  dispose(): void {
    this.ports.forEach((port) => {
      port.onmidimessage = null
    })
    this.ports.clear()
    if (this.access) this.access.onstatechange = null
    this.access = null
    this.reset()
  }

  /** (Re)attach message listeners to every currently-present port. */
  private sync(): void {
    const access = this.access
    if (!access) return
    const prev = this.ports
    const next = new Map<string, MidiInputPortLike>()
    access.inputs.forEach((port) => {
      next.set(port.id, port)
      port.onmidimessage = (e) => this.onMessage(port.id, e ? e.data : null)
    })
    prev.forEach((port, id) => {
      if (!next.has(id)) {
        port.onmidimessage = null
        this.pending.delete(id)
        this.bankLsb.delete(id)
      }
    })
    this.ports = next
  }

  private onMessage(portId: string, data: Uint8Array | null): void {
    if (!this.access || !data || data.length < 1) return
    if (this.inputFilter !== 'all' && portId !== this.inputFilter) return
    const status = data[0] & 0xff
    if (status < 0x80 || status >= 0xf0) return // no running status / system msgs
    if (this.channel !== 'omni' && (status & 0x0f) !== this.channel - 1) return
    const d1 = data.length > 1 ? data[1] & 0x7f : 0
    const d2 = data.length > 2 ? data[2] & 0x7f : 0

    switch (status & 0xf0) {
      case 0x90: // note on (velocity 0 = note off)
        if (data.length < 3) return
        if (d2 === 0) this.handlers.noteOff(d1)
        else this.handlers.noteOn(d1, d2)
        return
      case 0x80:
        if (data.length < 2) return
        this.handlers.noteOff(d1)
        return
      case 0xb0:
        if (data.length < 3) return
        this.handleCc(portId, d1, d2)
        return
      case 0xe0: {
        if (data.length < 3) return
        const raw = (d2 << 7) | d1 // 0..16383, center 8192
        const v = raw >= 8192 ? (raw - 8192) / 8191 : (raw - 8192) / 8192
        this.handlers.bend(v < -1 ? -1 : v > 1 ? 1 : v)
        return
      }
      case 0xd0:
        if (data.length < 2) return
        this.handlers.channelPressure(d1 / 127)
        return
      case 0xc0:
        if (data.length < 2) return
        this.handlers.programChange(this.bankLsb.get(portId) ?? 0, d1)
        return
      default:
        return // 0xa0 poly aftertouch: unused by the xd engine
    }
  }

  private handleCc(portId: string, cc: number, value: number): void {
    // A pending LSB only applies to the immediately following CC.
    const pend = this.pending.get(portId) ?? null
    if (pend !== null) this.pending.delete(portId)

    switch (cc) {
      case 0: // bank select MSB — always 0 on the xd, ignored
        return
      case 32: // bank select LSB — held until the next program change
        this.bankLsb.set(portId, value)
        return
      case 1:
        this.handlers.joyY(value / 127)
        return
      case 2:
        this.handlers.joyYMinus(value / 127)
        return
      case 120: // all sound off
      case 123: // all notes off
        this.handlers.panic()
        return
    }

    const r = decodeCc(cc, value, pend)
    if (!r) return
    if (r.kind === 'lsb') this.pending.set(portId, r.v)
    else if (r.kind === 'sustain') this.handlers.sustain(r.on)
    else this.handlers.param(r.id, r.v)
  }
}
