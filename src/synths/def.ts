/*
 * Synth definition interfaces — the contract between the synth-agnostic app
 * shell (state/, main.ts) and a per-synth definition (src/synths/<id>/).
 *
 * StoreDef is the data half consumed by Store/persist (pure: importable from
 * tests and workers). SynthDef adds app-shell identity. The registry
 * (synths/registry.ts, main-thread only) composes a SynthDef with its worklet
 * URL and UI factory — those stay out of here so this module never touches
 * bundler-specific imports or the DOM.
 */
import type { ParamMeta } from '../shared/paramdef'
import type { Program } from '../shared/program'
import type { ToEngine, FromEngine } from '../shared/messages'
import type { Store } from '../state/store'

export interface StoreDef {
  id: string
  /** Parameter table (dense, id-indexed) + count. */
  params: readonly ParamMeta[]
  paramCount: number
  clampParam(id: number, v: number): number
  initProgram(name?: string): Program
  cloneProgram(p: Program): Program
  serializeProgram(p: Program): string
  deserializeProgram(json: string): Program | null
  factoryPresets: Program[]
  /** localStorage namespace for the program bank. */
  bankKey: string
  numSlots: number
}

export interface SynthDef extends StoreDef {
  /** Display name for the synth selector. */
  title: string
  /** AudioWorkletProcessor registration name. */
  processorName: string
}

/** What the generic bootstrap (main.ts) provides to a synth app. */
export interface SynthAppOpts {
  /** Post a message to the engine (buffered until the worklet is up). */
  send(msg: ToEngine): void
  /** MASTER knob level 0..1 (bootstrap owns the output gain node). */
  onMaster(level: number): void
}

/** A synth's whole main-thread app: store + panel + display + MIDI wiring. */
export interface SynthApp {
  el: HTMLElement
  store: Store
  onEngineMessage(m: FromEngine): void
  initMidi(): Promise<void>
  /** Audio graph is up: the engine's sample rate (SERVICE MODE axes etc). */
  setSampleRate(sr: number): void
  /** Responsive rescale (window resize). */
  fit(): void
}

/** Registry entry: definition + worklet URL + app factory (main-thread only). */
export interface SynthEntry {
  def: SynthDef
  processorUrl: string
  buildApp(opts: SynthAppOpts): SynthApp
}
