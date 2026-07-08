/*
 * Offline replica replay of a calibration job point: the same Program the
 * hardware receives over SysEx, the same note plan, rendered sample-exactly
 * through the xd Engine (headless, deterministic — drift/noise are seeded).
 */
import { Engine } from '../../../src/synths/xd/engine'
import type { CalibJob } from './job'
import { jobProgram, expandNotes } from './job'

export const RENDER_SR = 48000
const BLOCK = 128

export interface RenderResult {
  samples: Float32Array
  sr: number
  /** exact onset: the first note-on, in samples */
  onsetSample: number
}

/** Render one job point through the replica; returns the L channel. */
export function renderJobPoint(job: CalibJob, point: number | null): RenderResult {
  const e = new Engine(RENDER_SR)
  e.loadProgram(jobProgram(job, point))

  const total = Math.round(job.captureSec * RENDER_SR)
  const out = new Float32Array(total)
  const l = new Float32Array(BLOCK)
  const r = new Float32Array(BLOCK)
  const events: { at: number; on: boolean; midi: number; vel: number }[] = []
  for (const n of expandNotes(job)) {
    events.push({ at: Math.round(n.onSec * RENDER_SR), on: true, midi: n.midi, vel: n.vel })
    events.push({ at: Math.round(n.offSec * RENDER_SR), on: false, midi: n.midi, vel: 0 })
  }
  events.sort((a, b) => a.at - b.at)

  let done = 0
  let ev = 0
  while (done < total) {
    while (ev < events.length && events[ev].at <= done) {
      const x = events[ev++]
      if (x.on) e.noteOn(x.midi, x.vel)
      else e.noteOff(x.midi)
    }
    const n = Math.min(BLOCK, total - done)
    e.process(l, r, n)
    out.set(l.subarray(0, n), done)
    done += n
  }
  return { samples: out, sr: RENDER_SR, onsetSample: Math.round(job.notes[0].onSec * RENDER_SR) }
}
