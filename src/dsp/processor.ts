/// <reference path="./worklet.d.ts" />
/*
 * AudioWorklet processor for the minilogue xd replica.
 *
 * Thin worklet shell around Engine: routes every ToEngine message in, posts
 * FromEngine telemetry out (step / scope / voices). No DOM imports —
 * only shared/* and dsp/*. process() is exception-guarded so the processor
 * can never die, handles any block size, and always returns true.
 */
import { Engine } from './engine'
import { PROCESSOR_NAME, SCOPE_SIZE } from '../shared/messages'
import type { ToEngine } from '../shared/messages'

const SCOPE_INTERVAL_S = 0.05
const VOICES_INTERVAL_S = 0.03

class XdProcessor extends AudioWorkletProcessor {
  private readonly engine = new Engine(sampleRate)

  // Post-FX mono ring for the OLED scope (SCOPE_SIZE-sample frames).
  private scopeOn = false
  private readonly scopeRing = new Float32Array(SCOPE_SIZE)
  private ringW = 0

  private readonly scopeFrames = Math.max(1, Math.round(SCOPE_INTERVAL_S * sampleRate))
  private readonly voicesFrames = Math.max(1, Math.round(VOICES_INTERVAL_S * sampleRate))
  private scopeCount = 0
  private voicesCount = 0

  private lastNotes: number[] = []
  private readonly noteScratch: number[] = []

  /** Right-channel scratch when the node is given a mono output. */
  private scratchR = new Float32Array(128)

  constructor() {
    super()
    this.engine.onStep = (i) => this.port.postMessage({ t: 'step', i })
    this.port.onmessage = (e: MessageEvent) => {
      try {
        this.onMessage(e.data)
      } catch {
        // A malformed message must never take the audio thread down.
      }
    }
  }

  private onMessage(data: unknown): void {
    const m = data as ToEngine
    switch (m.t) {
      case 'noteOn':
        this.engine.noteOn(m.note, m.vel)
        return
      case 'noteOff':
        this.engine.noteOff(m.note)
        return
      case 'allNotesOff':
        this.engine.allNotesOff()
        return
      case 'param':
        this.engine.setParam(m.id, m.v)
        return
      case 'loadProgram':
        this.engine.loadProgram(m.program)
        return
      case 'seq':
        this.engine.setSeqData(m.seq)
        return
      case 'play':
        this.engine.setPlaying(m.on)
        return
      case 'bend':
        this.engine.setBend(m.v)
        return
      case 'joyY':
        this.engine.setJoyY(m.v)
        return
      case 'sustain':
        this.engine.sustain(m.on)
        return
      case 'pressure':
        this.engine.setPressure(m.v)
        return
      case 'scope':
        this.scopeOn = m.on === true
        return
      default:
        break
    }
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]
    if (!out || !out[0]) return true
    const l = out[0]
    let r = out[1]
    if (!r) {
      if (this.scratchR.length < l.length) this.scratchR = new Float32Array(l.length)
      r = this.scratchR
    }
    const frames = l.length
    try {
      this.engine.process(l, r, frames)

      // Scope ring: post-FX mono, written every block (cheap).
      const ring = this.scopeRing
      let w = this.ringW
      for (let i = 0; i < frames; i++) {
        ring[w] = (l[i] + r[i]) * 0.5
        w = (w + 1) % SCOPE_SIZE
      }
      this.ringW = w

      this.scopeCount += frames
      if (this.scopeCount >= this.scopeFrames) {
        this.scopeCount = 0
        if (this.scopeOn) this.postScope()
      }

      this.voicesCount += frames
      if (this.voicesCount >= this.voicesFrames) {
        this.voicesCount = 0
        this.postVoicesIfChanged()
      }
    } catch {
      // Never let the processor die: emit silence for this block.
      for (let c = 0; c < out.length; c++) out[c].fill(0)
    }
    return true
  }

  private postScope(): void {
    // Fresh copy in ring order (oldest -> newest), transferred to the UI.
    const data = new Float32Array(SCOPE_SIZE)
    const ring = this.scopeRing
    const w = this.ringW
    const tail = SCOPE_SIZE - w
    data.set(ring.subarray(w), 0)
    data.set(ring.subarray(0, w), tail)
    this.port.postMessage({ t: 'scope', data }, [data.buffer])
  }

  private postVoicesIfChanged(): void {
    const notes = this.noteScratch
    this.engine.collectActiveNotes(notes)
    const last = this.lastNotes
    let same = notes.length === last.length
    if (same) {
      for (let i = 0; i < notes.length; i++) {
        if (notes[i] !== last[i]) {
          same = false
          break
        }
      }
    }
    if (same) return
    this.lastNotes = notes.slice()
    this.port.postMessage({ t: 'voices', notes: this.lastNotes })
  }
}

registerProcessor(PROCESSOR_NAME, XdProcessor)
