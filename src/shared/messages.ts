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
  | { t: 'debug'; on: boolean; all?: boolean } // SERVICE MODE telemetry (all = 4-voice taps)
  | { t: 'calibProfile'; id: string } // switch calibration profile (synths/<id>/profiles.ts)

export interface DbgVoice {
  note: number
  on: boolean
  amp: number // amp EG level 0..1
  drift1: number // VCO1 drift, cents
  drift2: number // VCO2 drift, cents (independent, like the hardware)
  modEg: number // mod EG level 0..1
  lfo: number // LFO output -1..1 (free-runs while idle)
  hz: number // sounding base frequency (post-glide/bend), 0 when never played
}

export type FromEngine =
  | { t: 'scope'; data: Float32Array } // post-FX mono frames for the OLED
  | { t: 'step'; i: number } // playhead step index, -1 = stopped
  | { t: 'voices'; notes: number[] } // sounding MIDI notes (key/LED feedback)
  | {
      t: 'dbg' // SERVICE MODE frame (~30/s while enabled)
      // 0-5 mono voice taps: vco1, vco2, multi, mix, postFilter, postVca;
      // 6-11 stereo FX pairs: modFxL, modFxR, delayL, delayR, outL, outR.
      taps: Float32Array[]
      // all-voices mode only: numVoices*6 frames, voice-major [v0 vco1..vca, v1 vco1..].
      vtaps?: Float32Array[]
      voices: DbgVoice[] // numVoices lanes
      load: number // audio-thread load 0..1
      tapped: number // voice index feeding the taps
    }

export const SCOPE_SIZE = 256
