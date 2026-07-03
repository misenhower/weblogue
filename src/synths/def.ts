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
