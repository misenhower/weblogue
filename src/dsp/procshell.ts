/// <reference path="./worklet.d.ts" />
/*
 * Shared AudioWorklet processor shell for the 'logue-family replicas
 * (worklet-side, DOM-free — only shared/*).
 *
 * registerSynthProcessor wraps a synth Engine in the thin shell both synths
 * share: routes every ToEngine message in, posts FromEngine telemetry out
 * (step / scope / voices / dbg). process() is exception-guarded so the
 * processor can never die, handles any block size, and always returns true.
 */
import { SCOPE_SIZE } from '../shared/messages'
import type { ToEngine, DbgVoice } from '../shared/messages'
import type { Program, SeqData } from '../shared/program'

/** The engine surface the shell consumes (see the synths' engine.ts). */
export interface EngineShell {
  process(outL: Float32Array, outR: Float32Array, n: number): void
  noteOn(note: number, vel: number): void
  noteOff(note: number): void
  allNotesOff(): void
  setParam(id: number, v: number): void
  loadProgram(p: Program): void
  setSeqData(seq: SeqData): void
  setPlaying(on: boolean): void
  setBend(v: number): void
  setJoyY(v: number): void
  sustain(on: boolean): void
  setPressure(v: number): void
  setDebug(on: boolean): void
  setDebugAll(all: boolean): void
  copyDebugTaps(dst: Float32Array[]): void
  copyDebugVoiceTaps(dst: Float32Array[]): void
  debugVoiceInfo(i: number): DbgVoice
  collectActiveNotes(dst: number[]): number
  /** Playhead callback ({t:'step'} messages). */
  onStep: ((i: number) => void) | null
  readonly debugOn: boolean
  readonly debugAll: boolean
  readonly debugVoice: number
}

const SCOPE_INTERVAL_S = 0.05
const VOICES_INTERVAL_S = 0.03
const DBG_INTERVAL_S = 0.033 // ~30 fps service-mode telemetry

const nowMs: () => number =
  typeof globalThis.performance?.now === 'function'
    ? () => globalThis.performance.now()
    : () => Date.now()

/**
 * Register the shared worklet shell under `name`, wrapping the engine the
 * factory builds. `dbgTapSize` is the engine's SERVICE-MODE tap ring length
 * (its exported DBG_TAP_SIZE).
 */
export function registerSynthProcessor(
  name: string,
  dbgTapSize: number,
  factory: (sampleRate: number) => EngineShell,
): void {
  class SynthProcessor extends AudioWorkletProcessor {
    private readonly engine = factory(sampleRate)

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

    // SERVICE MODE telemetry (only while the debug panel is open).
    private readonly dbgFrames = Math.max(1, Math.round(DBG_INTERVAL_S * sampleRate))
    private dbgCount = 0
    private busyMs = 0
    private wallFrames = 0
    private load = 0

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
        case 'debug':
          this.engine.setDebug(m.on === true)
          this.engine.setDebugAll(m.all === true)
          this.busyMs = 0
          this.wallFrames = 0
          this.dbgCount = 0
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
        const dbg = this.engine.debugOn
        const t0 = dbg ? nowMs() : 0
        this.engine.process(l, r, frames)
        if (dbg) {
          this.busyMs += nowMs() - t0
          this.wallFrames += frames
        }

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

        if (this.engine.debugOn) {
          this.dbgCount += frames
          if (this.dbgCount >= this.dbgFrames) {
            this.dbgCount = 0
            this.postDebug()
          }
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

    private postDebug(): void {
      // Audio-thread load: engine time vs realtime budget over the window.
      if (this.wallFrames > 0) {
        const wallMs = (this.wallFrames / sampleRate) * 1000
        this.load = Math.min(1, this.busyMs / wallMs)
        this.busyMs = 0
        this.wallFrames = 0
      }
      const taps: Float32Array[] = []
      for (let t = 0; t < 12; t++) taps.push(new Float32Array(dbgTapSize))
      this.engine.copyDebugTaps(taps)
      let vtaps: Float32Array[] | undefined
      if (this.engine.debugAll) {
        vtaps = []
        for (let t = 0; t < 24; t++) vtaps.push(new Float32Array(dbgTapSize))
        this.engine.copyDebugVoiceTaps(vtaps)
      }
      const voices = [0, 1, 2, 3].map((i) => this.engine.debugVoiceInfo(i))
      const transfer = taps.map((a) => a.buffer)
      if (vtaps) for (const a of vtaps) transfer.push(a.buffer)
      this.port.postMessage(
        { t: 'dbg', taps, vtaps, voices, load: this.load, tapped: this.engine.debugVoice },
        transfer,
      )
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

  registerProcessor(name, SynthProcessor)
}
