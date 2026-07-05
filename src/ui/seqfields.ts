/*
 * SEQ EDIT field definitions shared by the OLED menu (display.ts) and the
 * settings drawer (settings.ts): one source of truth for label, edit step,
 * clamp range (mirrors store.setSeqField) and value formatting.
 */
import type { SeqData } from '../shared/program'
import { NUM_STEPS, STEP_RESOLUTIONS } from '../shared/program'

export interface SeqFieldDef {
  field: 'bpm' | 'stepLength' | 'stepResolution' | 'swing' | 'defaultGate'
  label: string
  step: number
  min: number
  max: number
  /** Present for enumerated fields (drawer renders a picker). */
  labels?: readonly string[]
  get(seq: SeqData): number
  fmt(v: number): string
}

export const SEQ_FIELDS: readonly SeqFieldDef[] = [
  {
    field: 'bpm',
    label: 'BPM',
    step: 0.5,
    min: 10,
    max: 300,
    get: (s) => s.bpm,
    fmt: (v) => v.toFixed(1),
  },
  {
    field: 'stepLength',
    label: 'STEP LENGTH',
    step: 1,
    min: 1,
    max: NUM_STEPS,
    get: (s) => s.stepLength,
    fmt: String,
  },
  {
    field: 'stepResolution',
    label: 'STEP RESOLUTION',
    step: 1,
    min: 0,
    max: STEP_RESOLUTIONS.length - 1,
    labels: STEP_RESOLUTIONS.map((r) => r.label),
    get: (s) => s.stepResolution,
    fmt: (v) => STEP_RESOLUTIONS[v]?.label ?? String(v),
  },
  {
    field: 'swing',
    label: 'SWING',
    step: 1,
    min: -75,
    max: 75,
    get: (s) => s.swing,
    fmt: (v) => (v > 0 ? '+' : '') + v + '%',
  },
  {
    field: 'defaultGate',
    label: 'DEFAULT GATE',
    step: 1,
    min: 0,
    max: 72,
    get: (s) => s.defaultGate,
    fmt: (v) => Math.round((v / 72) * 100) + '%',
  },
]
