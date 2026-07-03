/*
 * Program (patch) data model: parameters + sequence + motion data.
 * Synth-agnostic; a synth definition binds makeProgramCodec to its own
 * parameter table (src/synths/<id>/program.ts).
 */
import type { ParamMeta } from './paramdef'

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
  /** Which synth definition this program belongs to (e.g. 'xd'). */
  synthId: string
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

export interface ProgramCodecConfig {
  synthId: string
  /** Dense id-indexed param table; supplies defaults + serialization keys. */
  params: readonly ParamMeta[]
  paramByKey: ReadonlyMap<string, ParamMeta>
  clampParam: (id: number, v: number) => number
  /** v1 files predate synthId; only the synth they belonged to accepts them. */
  acceptLegacyNoSynthId: boolean
}

export interface ProgramCodec {
  initProgram: (name?: string) => Program
  cloneProgram: (p: Program) => Program
  serializeProgram: (p: Program) => string
  deserializeProgram: (json: string) => Program | null
}

/**
 * Program init + serialization bound to a synth's param table. Serialization
 * is by stable param key so saved programs survive id changes; deserialization
 * is defensive (clamps, defaults, refuses other synths' programs).
 */
export function makeProgramCodec(cfg: ProgramCodecConfig): ProgramCodec {
  const { synthId, params, paramByKey, clampParam } = cfg

  function initProgram(name = 'Init Program'): Program {
    return {
      synthId,
      name,
      params: params.map((p) => p.def),
      seq: initSeq(),
    }
  }

  function cloneProgram(p: Program): Program {
    return deserializeProgram(serializeProgram(p)) ?? initProgram()
  }

  function serializeProgram(p: Program): string {
    const byKey: Record<string, number> = {}
    for (const meta of params) byKey[meta.key] = p.params[meta.id]
    return JSON.stringify({ v: 2, synthId, name: p.name, params: byKey, seq: p.seq })
  }

  function deserializeProgram(json: string): Program | null {
    try {
      const o = JSON.parse(json)
      if (!o || typeof o !== 'object') return null
      // Refuse other synths' programs rather than silently loading them as
      // this synth's defaults; a missing synthId (v1 file) is accepted only
      // by the synth the v1 format belonged to.
      if (cfg.acceptLegacyNoSynthId) {
        if (typeof o.synthId === 'string' && o.synthId !== synthId) return null
      } else {
        if (o.synthId !== synthId) return null
      }
      const prog = initProgram(typeof o.name === 'string' ? o.name.slice(0, 16) : 'Program')
      if (o.params && typeof o.params === 'object') {
        for (const [key, val] of Object.entries(o.params)) {
          const meta = paramByKey.get(key)
          if (meta && typeof val === 'number' && Number.isFinite(val)) {
            prog.params[meta.id] = clampParam(meta.id, val)
          }
        }
      }
      if (o.seq && typeof o.seq === 'object') {
        const s = o.seq
        const seq: SeqData = prog.seq
        if (Number.isFinite(s.bpm)) seq.bpm = Math.max(10, Math.min(300, s.bpm))
        if (Number.isFinite(s.stepLength)) seq.stepLength = Math.max(1, Math.min(16, Math.round(s.stepLength)))
        if (Number.isFinite(s.stepResolution)) seq.stepResolution = Math.max(0, Math.min(4, Math.round(s.stepResolution)))
        if (Number.isFinite(s.swing)) seq.swing = Math.max(-75, Math.min(75, Math.round(s.swing)))
        if (Number.isFinite(s.defaultGate)) seq.defaultGate = Math.max(0, Math.min(72, Math.round(s.defaultGate)))
        if (Array.isArray(s.activeSteps)) {
          for (let i = 0; i < NUM_STEPS; i++) seq.activeSteps[i] = s.activeSteps[i] !== false
        }
        if (Array.isArray(s.steps)) {
          for (let i = 0; i < NUM_STEPS && i < s.steps.length; i++) {
            const st = s.steps[i]
            if (!st || typeof st !== 'object') continue
            const notes = Array.isArray(st.notes) ? st.notes.filter((n: unknown) => Number.isFinite(n)).slice(0, NOTES_PER_STEP) : []
            const vels = Array.isArray(st.vels) ? st.vels : []
            const gates = Array.isArray(st.gates) ? st.gates : []
            seq.steps[i] = {
              on: st.on === true && notes.length > 0,
              notes: notes.map((n: number) => Math.max(0, Math.min(127, Math.round(n)))),
              vels: notes.map((_: number, j: number) => (Number.isFinite(vels[j]) ? Math.max(1, Math.min(127, Math.round(vels[j]))) : 100)),
              gates: notes.map((_: number, j: number) => (Number.isFinite(gates[j]) ? Math.max(0, Math.min(127, Math.round(gates[j]))) : -1)).map((g: number) => (g < 0 ? seq.defaultGate : g)),
            }
          }
        }
        if (Array.isArray(s.motion)) {
          for (let i = 0; i < NUM_MOTION_LANES && i < s.motion.length; i++) {
            const lane = s.motion[i]
            if (!lane || typeof lane !== 'object') continue
            const data: (number[] | null)[] = Array.from({ length: NUM_STEPS }, () => null)
            if (Array.isArray(lane.data)) {
              for (let j = 0; j < NUM_STEPS && j < lane.data.length; j++) {
                const d = lane.data[j]
                if (Array.isArray(d) && d.length > 0 && d.every((x: unknown) => Number.isFinite(x))) {
                  const pts = d.slice(0, MOTION_POINTS)
                  while (pts.length < MOTION_POINTS) pts.push(pts[pts.length - 1])
                  data[j] = pts
                }
              }
            }
            seq.motion[i] = {
              paramId: Number.isFinite(lane.paramId) ? lane.paramId : -1,
              on: lane.on === true,
              smooth: lane.smooth === true,
              data,
            }
          }
        }
      }
      return prog
    } catch {
      return null
    }
  }

  return { initProgram, cloneProgram, serializeProgram, deserializeProgram }
}
