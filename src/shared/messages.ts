/*
 * UI <-> AudioWorklet message protocol.
 *
 * The UI owns the Program (including sequence/motion data); the engine holds a
 * live copy for playback. Continuous knob moves are sent as individual param
 * messages; program loads and sequence edits replace state wholesale.
 */
import type { Program, SeqData } from './program'

export type ToEngine =
  | { t: 'noteOn'; note: number; vel: number }
  | { t: 'noteOff'; note: number }
  | { t: 'allNotesOff' }
  | { t: 'param'; id: number; v: number }
  | { t: 'loadProgram'; program: Program }
  | { t: 'seq'; seq: SeqData }
  | { t: 'play'; on: boolean }
  | { t: 'bend'; v: number } // -1..1 (joystick X / MIDI pitch bend)
  | { t: 'joyY'; v: number } // -1..1
  | { t: 'sustain'; on: boolean }
  | { t: 'scope'; on: boolean }

export type FromEngine =
  | { t: 'scope'; data: Float32Array } // post-FX mono frames for the OLED
  | { t: 'step'; i: number } // playhead step index, -1 = stopped
  | { t: 'voices'; notes: number[] } // sounding MIDI notes (key/LED feedback)
  | { t: 'level'; v: number } // output meter 0..1

/** AudioWorkletProcessor registration name. */
export const PROCESSOR_NAME = 'xd-processor'
export const SCOPE_SIZE = 256
