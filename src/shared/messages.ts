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
  | { t: 'pressure'; v: number } // 0..1 channel aftertouch -> MIDI_AT_ASSIGN dest
  | { t: 'scope'; on: boolean }
  | { t: 'debug'; on: boolean } // SERVICE MODE telemetry stream

export interface DbgVoice {
  note: number
  on: boolean
  amp: number // amp EG level 0..1
  drift1: number // VCO1 drift, cents
  drift2: number // VCO2 drift, cents (independent, like the hardware)
}

export type FromEngine =
  | { t: 'scope'; data: Float32Array } // post-FX mono frames for the OLED
  | { t: 'step'; i: number } // playhead step index, -1 = stopped
  | { t: 'voices'; notes: number[] } // sounding MIDI notes (key/LED feedback)
  | { t: 'level'; v: number } // output meter 0..1
  | {
      t: 'dbg' // SERVICE MODE frame (~12/s while enabled)
      taps: Float32Array[] // [vco1, vco2, mix, postFilter], DBG_TAP_SIZE each
      postFx: Float32Array // post-FX mono, SCOPE_SIZE
      voices: DbgVoice[] // 4 lanes
      load: number // audio-thread load 0..1
      tapped: number // voice index feeding the taps
    }

/** AudioWorkletProcessor registration name. */
export const PROCESSOR_NAME = 'xd-processor'
export const SCOPE_SIZE = 256
