/*
 * Node-side MIDI I/O for the calibration rig, wrapping @julusian/midi
 * (maintained node-midi fork with prebuilt darwin-arm64 binaries and SysEx
 * receive). One MidiRig = one open input+output pair for the whole session.
 *
 * SysEx receive requires ignoreTypes(false, ...) — node-midi filters it out
 * by default. awaitSysEx registers its listener immediately, so call it
 * BEFORE sending the request message to avoid losing a fast reply.
 */
import { Input, Output } from '@julusian/midi'

export interface MidiPorts {
  inputs: string[]
  outputs: string[]
}

export function listPorts(): MidiPorts {
  const input = new Input()
  const output = new Output()
  const inputs: string[] = []
  const outputs: string[] = []
  for (let i = 0; i < input.getPortCount(); i++) inputs.push(input.getPortName(i))
  for (let i = 0; i < output.getPortCount(); i++) outputs.push(output.getPortName(i))
  input.closePort()
  output.closePort()
  return { inputs, outputs }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type SysExWaiter = {
  pred: (msg: Uint8Array) => boolean
  resolve: (msg: Uint8Array) => void
}

export class MidiRig {
  readonly inName: string
  readonly outName: string
  private readonly input: Input
  private readonly output: Output
  private readonly waiters = new Set<SysExWaiter>()

  private constructor(input: Input, output: Output, inName: string, outName: string) {
    this.input = input
    this.output = output
    this.inName = inName
    this.outName = outName
    this.input.ignoreTypes(false, true, true) // receive SysEx; drop timing/active-sense
    this.input.on('message', (_delta: number, message: number[]) => {
      if (message.length === 0 || message[0] !== 0xf0) return
      const bytes = Uint8Array.from(message)
      for (const w of this.waiters) {
        if (w.pred(bytes)) {
          this.waiters.delete(w)
          w.resolve(bytes)
        }
      }
    })
  }

  /**
   * Open an input+output pair whose names contain `portMatch`
   * (case-insensitive). Korg synths expose two pairs over USB: "<name>
   * SOUND"/"<name> KBD/KNOB" talk to the synth engine, while "<name> MIDI
   * IN"/"<name> MIDI OUT" only mirror the 5-pin DIN jacks — so among the
   * matches, prefer the SOUND output and the KBD/KNOB input. Throws with the
   * full port listing when nothing matches.
   */
  static open(portMatch: string): MidiRig {
    const needle = portMatch.toLowerCase()
    const input = new Input()
    const output = new Output()
    const pick = (names: string[], prefer: RegExp): number => {
      const matches = names
        .map((name, i) => ({ name, i }))
        .filter(({ name }) => name.toLowerCase().includes(needle))
      if (matches.length === 0) return -1
      return (matches.find(({ name }) => prefer.test(name)) ?? matches[0]).i
    }
    const inNames: string[] = []
    for (let i = 0; i < input.getPortCount(); i++) inNames.push(input.getPortName(i))
    const outNames: string[] = []
    for (let i = 0; i < output.getPortCount(); i++) outNames.push(output.getPortName(i))
    const inIdx = pick(inNames, /kbd|knob/i)
    const outIdx = pick(outNames, /sound/i)
    if (inIdx < 0 || outIdx < 0) {
      const ports = listPorts()
      throw new Error(
        `MIDI port matching "${portMatch}" not found ` +
          `(inputs: [${ports.inputs.join(', ') || 'none'}], ` +
          `outputs: [${ports.outputs.join(', ') || 'none'}])`
      )
    }
    const inName = input.getPortName(inIdx)
    const outName = output.getPortName(outIdx)
    input.openPort(inIdx)
    output.openPort(outIdx)
    return new MidiRig(input, output, inName, outName)
  }

  send(msg: readonly number[] | Uint8Array): void {
    this.output.sendMessage(Array.from(msg))
  }

  noteOn(note: number, vel = 100, ch = 0): void {
    this.send([0x90 | (ch & 0xf), note & 0x7f, vel & 0x7f])
  }

  noteOff(note: number, ch = 0): void {
    this.send([0x80 | (ch & 0xf), note & 0x7f, 0])
  }

  cc(cc: number, value: number, ch = 0): void {
    this.send([0xb0 | (ch & 0xf), cc & 0x7f, value & 0x7f])
  }

  allNotesOff(ch = 0): void {
    this.cc(123, 0, ch)
  }

  /**
   * Resolve with the first incoming SysEx message matching `pred`, or reject
   * after `timeoutMs`. Register (call) before sending the request.
   */
  awaitSysEx(pred: (msg: Uint8Array) => boolean, timeoutMs: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const waiter: SysExWaiter = { pred, resolve }
      this.waiters.add(waiter)
      setTimeout(() => {
        if (this.waiters.delete(waiter)) {
          reject(new Error(`timed out after ${timeoutMs} ms waiting for SysEx reply`))
        }
      }, timeoutMs)
    })
  }

  close(): void {
    this.input.closePort()
    this.output.closePort()
  }
}
