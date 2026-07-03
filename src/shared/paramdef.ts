/*
 * Parameter framework — synth-agnostic. A synth definition (src/synths/*)
 * declares its own parameter table with the factories here; ids are stable
 * and append-only per synth. Continuous panel knobs use hardware-style raw
 * values 0..1023; switches/enums use small ints; menu params use the
 * hardware's stored ranges.
 */
import { fmtRaw } from './maps'

/** Virtual motion-sequence targets that are not program parameters. */
export const MOTION_PITCH_BEND = 1000
export const MOTION_GATE_TIME = 1001

export interface ParamMeta {
  id: number
  key: string // stable serialization key
  label: string // OLED / tooltip name
  kind: 'knob' | 'switch' | 'menu'
  min: number
  max: number
  def: number
  labels?: readonly string[] // for enums: display per value
  fmt?: (raw: number) => string
  motion?: boolean // recordable in a motion lane
  motionSmooth?: boolean // continuous (smoothable) vs switch-type
}

export function knob(id: number, key: string, label: string, def: number, extra?: Partial<ParamMeta>): ParamMeta {
  return { id, key, label, kind: 'knob', min: 0, max: 1023, def, motion: true, motionSmooth: true, fmt: fmtRaw, ...extra }
}
export function sw(id: number, key: string, label: string, labels: readonly string[], def: number, extra?: Partial<ParamMeta>): ParamMeta {
  return { id, key, label, kind: 'switch', min: 0, max: labels.length - 1, def, labels, motion: true, motionSmooth: false, ...extra }
}
export function menu(id: number, key: string, label: string, min: number, max: number, def: number, extra?: Partial<ParamMeta>): ParamMeta {
  return { id, key, label, kind: 'menu', min, max, def, motion: false, motionSmooth: false, ...extra }
}

/** Dense id-indexed table; throws at startup on duplicate or missing ids. */
export function buildParamTable(defs: readonly ParamMeta[], count: number): readonly ParamMeta[] {
  const arr = new Array<ParamMeta>(count)
  for (const d of defs) {
    if (arr[d.id]) throw new Error('duplicate param id ' + d.id)
    arr[d.id] = d
  }
  for (let i = 0; i < count; i++) {
    if (!arr[i]) throw new Error('missing param id ' + i)
  }
  return arr
}

export function clampParamIn(table: readonly ParamMeta[], id: number, v: number): number {
  const m = table[id]
  if (!m) return v
  return Math.max(m.min, Math.min(m.max, Math.round(v)))
}

export function formatParamIn(table: readonly ParamMeta[], id: number, v: number): string {
  const m = table[id]
  if (!m) return String(v)
  if (m.labels) return m.labels[Math.max(m.min, Math.min(m.max, Math.round(v)))] ?? String(v)
  if (m.fmt) return m.fmt(v)
  return String(Math.round(v))
}

/** Params recordable into motion lanes (plus the two virtual targets). */
export function motionParamIdsOf(table: readonly ParamMeta[]): readonly number[] {
  return [...table.filter((p) => p.motion).map((p) => p.id), MOTION_PITCH_BEND, MOTION_GATE_TIME]
}

export function motionParamLabelIn(table: readonly ParamMeta[], id: number): string {
  if (id === MOTION_PITCH_BEND) return 'PITCH BEND'
  if (id === MOTION_GATE_TIME) return 'GATE TIME'
  return table[id]?.label ?? 'None'
}
