/*
 * minilogue xd program init + serialization, bound to the xd param table.
 * Serialization is by stable param key so saved programs survive id changes.
 */
import type { Program, SeqData } from '../../shared/program'
import { initSeq, NUM_STEPS, NUM_MOTION_LANES, NOTES_PER_STEP, MOTION_POINTS } from '../../shared/program'
import { PARAMS, PARAM_BY_KEY, clampParam } from './params'

export const SYNTH_ID = 'xd'

export function initProgram(name = 'Init Program'): Program {
  return {
    synthId: SYNTH_ID,
    name,
    params: PARAMS.map((p) => p.def),
    seq: initSeq(),
  }
}

export function cloneProgram(p: Program): Program {
  return deserializeProgram(serializeProgram(p)) ?? initProgram()
}

export function serializeProgram(p: Program): string {
  const params: Record<string, number> = {}
  for (const meta of PARAMS) params[meta.key] = p.params[meta.id]
  return JSON.stringify({ v: 2, synthId: SYNTH_ID, name: p.name, params, seq: p.seq })
}

export function deserializeProgram(json: string): Program | null {
  try {
    const o = JSON.parse(json)
    if (!o || typeof o !== 'object') return null
    // v1 predates synthId and is always an xd program; refuse other synths'
    // programs rather than silently loading them as xd defaults.
    if (typeof o.synthId === 'string' && o.synthId !== SYNTH_ID) return null
    const prog = initProgram(typeof o.name === 'string' ? o.name.slice(0, 16) : 'Program')
    if (o.params && typeof o.params === 'object') {
      for (const [key, val] of Object.entries(o.params)) {
        const meta = PARAM_BY_KEY.get(key)
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
