/*
 * Program (patch) data model: parameters + sequence + motion data.
 * Synth-agnostic; a synth definition supplies its own init/serialization
 * bound to its parameter table (src/synths/<id>/program.ts).
 */

export const NUM_STEPS = 16
export const NUM_MOTION_LANES = 4
export const NOTES_PER_STEP = 8
export const MOTION_POINTS = 5 // per step, hardware-accurate

/** Step resolutions shared across the 'logue family sequencers. */
export const STEP_RESOLUTIONS: ReadonlyArray<{ label: string; beatsPerStep: number }> = [
  { label: '1/16', beatsPerStep: 0.25 },
  { label: '1/8', beatsPerStep: 0.5 },
  { label: '1/4', beatsPerStep: 1 },
  { label: '1/2', beatsPerStep: 2 },
  { label: '1/1', beatsPerStep: 4 },
]

/** Per-note/step gate byte: 0..72 = 0..100%, 73..127 = TIE. */
export const GATE_TIE = 73
export function gateTo01(gate: number): number {
  return gate >= GATE_TIE ? 1 : Math.max(0, Math.min(72, gate)) / 72
}
export function isTie(gate: number): boolean {
  return gate >= GATE_TIE
}

export interface SeqStep {
  on: boolean
  /** MIDI notes; parallel arrays. Empty = rest. */
  notes: number[]
  vels: number[]
  /** Per-note gate: 0..72 = 0..100%, 73+ = TIE. */
  gates: number[]
}

export interface MotionLane {
  /** Param id, MOTION_PITCH_BEND, MOTION_GATE_TIME, or -1 = unassigned. */
  paramId: number
  on: boolean
  smooth: boolean
  /** Per step: null = no data, else MOTION_POINTS values (raw param units). */
  data: (number[] | null)[]
}

export interface SeqData {
  bpm: number // 10.0..300.0
  stepLength: number // 1..16
  stepResolution: number // index into STEP_RESOLUTIONS
  swing: number // -75..75
  defaultGate: number // 0..72 (= 0..100%)
  activeSteps: boolean[] // 16, skip mask (false = skipped)
  steps: SeqStep[] // 16
  motion: MotionLane[] // 4
}

export interface Program {
  name: string
  params: number[] // indexed by param id
  seq: SeqData
}

export function initSeq(): SeqData {
  return {
    bpm: 120,
    stepLength: 16,
    stepResolution: 0,
    swing: 0,
    defaultGate: 54, // 75%
    activeSteps: Array.from({ length: NUM_STEPS }, () => true),
    steps: Array.from({ length: NUM_STEPS }, () => ({ on: false, notes: [], vels: [], gates: [] })),
    motion: Array.from({ length: NUM_MOTION_LANES }, () => ({
      paramId: -1,
      on: false,
      smooth: false,
      data: Array.from({ length: NUM_STEPS }, () => null),
    })),
  }
}
