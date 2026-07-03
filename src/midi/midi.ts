/*
 * Web MIDI input plumbing, synth-agnostic: owns MIDIAccess, port attachment,
 * channel/port filtering, note/bend/pressure/program-change dispatch, and
 * per-port decode state (pending 10-bit LSB from CC63, CC32 bank select).
 * Per-synth CC maps are injected as a pure CcDecoder via MidiHandlers.decodeCc
 * (the xd's lives in synths/xd/cc.ts).
 *
 * Generic CCs handled here: CC0/CC32 bank select, CC1/CC2 mod (the xd's
 * joystick Y+/Y-), CC120/CC123 panic. Everything else goes to the decoder.
 *
 * The module never touches `navigator` at import time, so it is safe to
 * import in tests / SSR; init() returns false when Web MIDI is unavailable.
 */

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
  /** Per-synth CC map; unmapped/absent = CC ignored. */
  decodeCc?: CcDecoder
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

export type DecodedCc =
  | { kind: 'param'; id: number; v: number }
  | { kind: 'lsb'; v: number }
  | { kind: 'sustain'; on: boolean }


/** Per-synth CC decoder (e.g. synths/xd/cc.ts decodeCc). */
export type CcDecoder = (cc: number, value: number, pendingLsb: number | null) => DecodedCc | null

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

    const r = this.handlers.decodeCc ? this.handlers.decodeCc(cc, value, pend) : null
    if (!r) return
    if (r.kind === 'lsb') this.pending.set(portId, r.v)
    else if (r.kind === 'sustain') this.handlers.sustain(r.on)
    else this.handlers.param(r.id, r.v)
  }
}
