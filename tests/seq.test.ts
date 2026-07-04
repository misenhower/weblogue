import { describe, it, expect } from 'vitest'
import { StepSeq, type StepSeqHooks } from '../src/dsp/stepseq'
import { Arp } from '../src/dsp/arp'
import { MOTION_META } from '../src/synths/xd/params'
import { initSeq } from '../src/shared/program'
import type { SeqData } from '../src/shared/program'
import { GATE_TIE } from '../src/shared/program'
import { P } from '../src/synths/xd/params'
import { MOTION_GATE_TIME } from '../src/shared/paramdef'

const SR = 48000
const BLOCK = 128
const STEP = 6000 // samples per 1/16 step at 120 bpm, 48 kHz

interface NoteEv {
  t: number
  type: 'on' | 'off'
  note: number
  vel: number
  slide?: boolean
}

function makeRec() {
  const events: NoteEv[] = []
  const motion: { t: number; id: number; v: number }[] = []
  const steps: { t: number; i: number }[] = []
  let now = 0
  const hooks: StepSeqHooks = {
    noteOn: (note, vel, slide) => events.push({ t: now, type: 'on', note, vel, slide }),
    noteOff: (note) => events.push({ t: now, type: 'off', note, vel: 0 }),
    motionValue: (id, v) => motion.push({ t: now, id, v }),
    stepChanged: (i) => steps.push({ t: now, i }),
  }
  return {
    events,
    motion,
    steps,
    hooks,
    setNow(t: number) {
      now = t
    },
  }
}

/** Process `seconds` of audio in BLOCK-frame chunks, time-stamping hooks. */
function run(s: { process(n: number): void }, rec: ReturnType<typeof makeRec>, seconds: number, t0 = 0): number {
  const frames = Math.round(seconds * SR)
  let done = 0
  while (done < frames) {
    rec.setNow(t0 + done)
    const n = Math.min(BLOCK, frames - done)
    s.process(n)
    done += n
  }
  return t0 + frames
}

function ons(rec: ReturnType<typeof makeRec>, note?: number): NoteEv[] {
  return rec.events.filter((e) => e.type === 'on' && (note === undefined || e.note === note))
}
function offs(rec: ReturnType<typeof makeRec>, note?: number): NoteEv[] {
  return rec.events.filter((e) => e.type === 'off' && (note === undefined || e.note === note))
}

function noteStep(notes: number[], gates: number[], vels?: number[]) {
  return { on: true, notes, vels: vels ?? notes.map(() => 100), gates }
}

/** 16 steps, a C4 note (50% gate) on every step, 120 bpm, 1/16. */
function fullSeq(): SeqData {
  const seq = initSeq()
  seq.bpm = 120
  seq.stepResolution = 0
  for (let i = 0; i < 16; i++) seq.steps[i] = noteStep([60], [36])
  return seq
}

function arpCfg(o: Partial<{ enabled: boolean; typeIndex: number; latch: boolean; rateBeats: number; gate01: number; swing: number }> = {}) {
  return { enabled: true, typeIndex: 2, latch: false, rateBeats: 0.25, gate01: 0.5, swing: 0, ...o }
}

/** Run an Arp at a fixed 120 bpm through the block-chunking helper. */
function arpProc(a: Arp): { process(n: number): void } {
  return { process: (n) => a.process(n, 120) }
}

describe('sequencer timing', () => {
  it('fires ~64 noteOns over exactly 8 s at 120 bpm, 1/16, 16 steps', () => {
    const rec = makeRec()
    const s = new StepSeq(SR, rec.hooks, MOTION_META)
    s.setSeq(fullSeq())
    s.setPlaying(true)
    expect(s.playing).toBe(true)
    run(s, rec, 8)
    const n = ons(rec).length
    expect(n).toBeGreaterThanOrEqual(63)
    expect(n).toBeLessThanOrEqual(65)
    // every noteOn eventually gets a noteOff (gate 50% < step end)
    expect(offs(rec).length).toBeGreaterThanOrEqual(n - 1)
  })

  it('holds a 2-step TIE: one noteOn, released when a later step retriggers', () => {
    const seq = initSeq()
    seq.stepLength = 4
    seq.steps[0] = noteStep([60], [GATE_TIE]) // TIE
    seq.steps[2] = noteStep([62], [36]) // different note -> releases the tie
    const rec = makeRec()
    const s = new StepSeq(SR, rec.hooks, MOTION_META)
    s.setSeq(seq)
    s.setPlaying(true)
    run(s, rec, 0.45) // 21600 frames: stops before the pattern wraps at 24000
    expect(ons(rec, 60).length).toBe(1)
    const off60 = offs(rec, 60)
    expect(off60.length).toBe(1)
    // released at the start of step 2 (sample 12000), +/- 2 blocks
    expect(Math.abs(off60[0].t - 2 * STEP)).toBeLessThanOrEqual(2 * BLOCK)
    // the noteOff of the tied note precedes the new step's noteOn
    const on62 = ons(rec, 62)
    expect(on62.length).toBe(1)
    expect(rec.events.indexOf(off60[0])).toBeLessThan(rec.events.indexOf(on62[0]))
    expect(offs(rec, 62).length).toBe(1)
    expect(Math.abs(offs(rec, 62)[0].t - (2 * STEP + STEP / 2))).toBeLessThanOrEqual(2 * BLOCK)
  })

  it('swing +50 shifts odd steps later by 25% of a step', () => {
    const seq = fullSeq()
    seq.swing = 50
    const rec = makeRec()
    const s = new StepSeq(SR, rec.hooks, MOTION_META)
    s.setSeq(seq)
    s.setPlaying(true)
    run(s, rec, 1.2)
    const t = ons(rec).map((e) => e.t)
    expect(t.length).toBeGreaterThanOrEqual(8)
    expect(t[0]).toBe(0)
    expect(Math.abs(t[1] - 1.25 * STEP)).toBeLessThanOrEqual(2 * BLOCK) // 7500
    expect(Math.abs(t[2] - 2 * STEP)).toBeLessThanOrEqual(2 * BLOCK) // 12000
    expect(Math.abs(t[3] - 3.25 * STEP)).toBeLessThanOrEqual(2 * BLOCK) // 19500
    expect(Math.abs(t[4] - 4 * STEP)).toBeLessThanOrEqual(2 * BLOCK) // 24000
  })

  it('skipped (inactive) steps shorten the cycle instead of resting', () => {
    const seq = fullSeq()
    for (let i = 0; i < 16; i++) seq.activeSteps[i] = i % 2 === 0 // 8 active
    const rec = makeRec()
    const s = new StepSeq(SR, rec.hooks, MOTION_META)
    s.setSeq(seq)
    s.setPlaying(true)
    run(s, rec, 2.5)
    // only even ORIGINAL indices are shown on the playhead
    const shown = rec.steps.filter((e) => e.i >= 0)
    expect(shown.length).toBeGreaterThan(8)
    for (const e of shown) expect(e.i % 2).toBe(0)
    // cycle is 8 steps (48000 samples), not 16 (96000)
    const zeros = rec.steps.filter((e) => e.i === 0)
    expect(zeros.length).toBeGreaterThanOrEqual(2)
    expect(Math.abs(zeros[1].t - 8 * STEP)).toBeLessThanOrEqual(2 * BLOCK)
  })
})

describe('motion lanes', () => {
  it('smooth lane interpolates the 5 points monotonically within a step', () => {
    const seq = initSeq()
    seq.motion[0] = {
      paramId: P.CUTOFF,
      on: true,
      smooth: true,
      data: [[0, 200, 400, 600, 800], ...Array.from({ length: 15 }, () => null)],
    }
    const rec = makeRec()
    const s = new StepSeq(SR, rec.hooks, MOTION_META)
    s.setSeq(seq)
    s.setPlaying(true)
    run(s, rec, 0.125) // exactly one 1/16 step at 120 bpm
    const vals = rec.motion.filter((m) => m.id === P.CUTOFF).map((m) => m.v)
    expect(vals.length).toBeGreaterThan(20)
    expect(vals[0]).toBe(0)
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThanOrEqual(vals[i - 1])
    expect(vals[vals.length - 1]).toBeGreaterThan(750) // reached the last segment
    // step 1 has data == null: nothing further is emitted
    const before = rec.motion.length
    run(s, rec, 0.1, 6000)
    expect(rec.motion.length).toBe(before)
  })

  it('non-smooth lane emits point 1 once at each step start', () => {
    const seq = initSeq()
    seq.stepLength = 2
    seq.motion[0] = {
      paramId: P.CUTOFF,
      on: true,
      smooth: false,
      data: [[100, 900, 900, 900, 900], [300, 0, 0, 0, 0], ...Array.from({ length: 14 }, () => null)],
    }
    const rec = makeRec()
    const s = new StepSeq(SR, rec.hooks, MOTION_META)
    s.setSeq(seq)
    s.setPlaying(true)
    run(s, rec, 0.24) // just under two full steps
    const got = rec.motion.filter((m) => m.id === P.CUTOFF)
    expect(got.map((m) => m.v)).toEqual([100, 300])
    expect(Math.abs(got[1].t - STEP)).toBeLessThanOrEqual(2 * BLOCK)
  })

  it('GATE TIME lane overrides step gates (consumed internally, never emitted)', () => {
    const seq = fullSeq() // gate 36 = 50% on every step
    seq.motion[0].paramId = MOTION_GATE_TIME
    seq.motion[0].on = true
    seq.motion[0].data[0] = [7, 7, 7, 7, 7] // ~10% gate on step 0 only
    const rec = makeRec()
    const s = new StepSeq(SR, rec.hooks, MOTION_META)
    s.setSeq(seq)
    s.setPlaying(true)
    run(s, rec, 0.3)
    const off = offs(rec, 60)
    expect(off.length).toBeGreaterThanOrEqual(2)
    // step 0: shortened to ~10% (~600 samples), not the stored 50% (3000)
    expect(off[0].t).toBeLessThanOrEqual(600 + 2 * BLOCK)
    // step 1 has no lane data: back to the stored 50% gate
    expect(Math.abs(off[1].t - (STEP + STEP / 2))).toBeLessThanOrEqual(2 * BLOCK)
    // the lane never reaches the motion hook (engine would just drop it)
    expect(rec.motion.filter((m) => m.id === MOTION_GATE_TIME).length).toBe(0)
  })

  it('setGateTimeOffset (joystick GATE TIME) offsets gates live', () => {
    const seq = fullSeq() // gate 36 = 50%
    const rec = makeRec()
    const s = new StepSeq(SR, rec.hooks, MOTION_META)
    s.setSeq(seq)
    s.setGateTimeOffset(-29) // 36 - 29 = 7 -> ~10% gate
    s.setPlaying(true)
    run(s, rec, 0.125)
    const off = offs(rec, 60)
    expect(off.length).toBe(1)
    expect(off[0].t).toBeLessThanOrEqual(600 + 2 * BLOCK)
  })
})

describe('slide flag (monologue spec §8)', () => {
  it('a flagged step glides INTO the next: only that noteOn gets slide=true', () => {
    const seq = initSeq()
    seq.stepLength = 4
    seq.steps[0] = noteStep([60], [36])
    seq.steps[1] = { ...noteStep([62], [36]), slide: true }
    seq.steps[2] = noteStep([64], [36])
    const rec = makeRec()
    const s = new StepSeq(SR, rec.hooks, MOTION_META)
    s.setSeq(seq)
    s.setPlaying(true)
    run(s, rec, 0.45) // covers steps 0..2, stops before the wrap at 24000
    expect(ons(rec, 60)[0].slide).toBe(false) // sequence start: no slide
    expect(ons(rec, 62)[0].slide).toBe(false) // step 0 not flagged
    expect(ons(rec, 64)[0].slide).toBe(true) // step 1 flagged: glide into step 2
  })
})

describe('TIE continuation', () => {
  it('TIE + same note next step continues without retriggering (spec §11)', () => {
    const seq = initSeq()
    seq.stepLength = 4
    seq.steps[0] = noteStep([60], [GATE_TIE])
    seq.steps[1] = noteStep([60], [36]) // continuation: ends at this step's gate
    const rec = makeRec()
    const s = new StepSeq(SR, rec.hooks, MOTION_META)
    s.setSeq(seq)
    s.setPlaying(true)
    run(s, rec, 0.45) // 21600 frames: stops before the pattern wraps at 24000
    expect(ons(rec, 60).length).toBe(1) // ONE attack across the chain
    const off60 = offs(rec, 60)
    expect(off60.length).toBe(1)
    // released mid-step-1 at its 50% gate (sample 6000 + 3000)
    expect(Math.abs(off60[0].t - (STEP + STEP / 2))).toBeLessThanOrEqual(2 * BLOCK)
  })

  it('chained TIEs hold through several steps and end on the final gate', () => {
    const seq = initSeq()
    seq.stepLength = 4
    seq.steps[0] = noteStep([60], [GATE_TIE])
    seq.steps[1] = noteStep([60], [GATE_TIE])
    seq.steps[2] = noteStep([60], [72]) // 100% gate: ends at step 2's boundary
    const rec = makeRec()
    const s = new StepSeq(SR, rec.hooks, MOTION_META)
    s.setSeq(seq)
    s.setPlaying(true)
    run(s, rec, 0.45)
    expect(ons(rec, 60).length).toBe(1)
    const off60 = offs(rec, 60)
    expect(off60.length).toBe(1)
    expect(Math.abs(off60[0].t - 3 * STEP)).toBeLessThanOrEqual(2 * BLOCK)
  })

  it('a tied note NOT present in the next note step still releases first', () => {
    const seq = initSeq()
    seq.stepLength = 4
    seq.steps[0] = noteStep([60], [GATE_TIE])
    seq.steps[1] = noteStep([62], [36]) // different note: tie releases, 62 triggers
    const rec = makeRec()
    const s = new StepSeq(SR, rec.hooks, MOTION_META)
    s.setSeq(seq)
    s.setPlaying(true)
    run(s, rec, 0.45)
    expect(ons(rec, 60).length).toBe(1)
    expect(offs(rec, 60).length).toBe(1)
    expect(ons(rec, 62).length).toBe(1)
    expect(rec.events.indexOf(offs(rec, 60)[0])).toBeLessThan(rec.events.indexOf(ons(rec, 62)[0]))
  })
})

describe('arpeggiator', () => {
  it('RISE 1 with held C-E-G repeats C,E,G ascending', () => {
    const rec = makeRec()
    const a = new Arp(SR, rec.hooks)
    a.setConfig(arpCfg({ typeIndex: 2 })) // RISE 1
    a.keyDown(64, 100) // press order E, C, G — RISE sorts ascending
    a.keyDown(60, 100)
    a.keyDown(67, 100)
    expect(a.heldCount()).toBe(3)
    run(arpProc(a), rec, 1) // 16th steps at 120 bpm = 6000 samples each
    const notes = ons(rec).map((e) => e.note)
    expect(notes.length).toBeGreaterThanOrEqual(8)
    expect(notes.slice(0, 8)).toEqual([60, 64, 67, 60, 64, 67, 60, 64])
    // gate 0.5 -> each noteOff lands ~3000 samples after its noteOn
    const firstOff = offs(rec, 60)[0]
    expect(Math.abs(firstOff.t - STEP / 2)).toBeLessThanOrEqual(2 * BLOCK)
  })

  it('latch keeps arpeggiating after key release and re-arms on next press', () => {
    const rec = makeRec()
    const a = new Arp(SR, rec.hooks)
    a.setConfig(arpCfg({ latch: true }))
    a.keyDown(60, 100)
    let t = run(arpProc(a), rec, 0.3)
    a.keyUp(60)
    expect(a.heldCount()).toBe(1) // still feeding the arp
    const before = ons(rec).length
    t = run(arpProc(a), rec, 0.5, t)
    expect(ons(rec).length).toBeGreaterThan(before + 2) // kept going
    // new press re-arms the latch set
    a.keyDown(62, 100)
    expect(a.heldCount()).toBe(1)
    const mark = rec.events.length
    run(arpProc(a), rec, 0.3, t)
    const later = rec.events.slice(mark).filter((e) => e.type === 'on')
    expect(later.length).toBeGreaterThan(0)
    for (const e of later) expect(e.note).toBe(62)
  })

  it('without latch, releasing all keys stops the arp and releases its note', () => {
    const rec = makeRec()
    const a = new Arp(SR, rec.hooks)
    a.setConfig(arpCfg({ gate01: 1 })) // full gate: note held to the boundary
    a.keyDown(60, 100)
    let t = run(arpProc(a), rec, 0.05)
    a.keyUp(60)
    t = run(arpProc(a), rec, 0.3, t)
    expect(a.heldCount()).toBe(0)
    expect(ons(rec, 60).length).toBe(1)
    expect(offs(rec, 60).length).toBe(1)
  })
})

describe('stop / cleanup', () => {
  it('stop releases everything: noteOn/noteOff counts pair up', () => {
    const seq = initSeq()
    seq.stepLength = 4
    seq.steps[0] = noteStep([60], [GATE_TIE])
    seq.steps[2] = noteStep([63, 67], [72, GATE_TIE])
    const rec = makeRec()
    const s = new StepSeq(SR, rec.hooks, MOTION_META)
    const a = new Arp(SR, rec.hooks)
    const both = { process: (n: number) => { s.process(n); a.process(n, 120) } }
    s.setSeq(seq)
    a.setConfig(arpCfg({ typeIndex: 8, latch: true })) // POLY 1 chord + latch
    a.keyDown(48, 90)
    a.keyDown(52, 90)
    a.keyUp(48)
    a.keyUp(52)
    s.setPlaying(true)
    let t = run(both, rec, 1)
    expect(s.currentStep).toBeGreaterThanOrEqual(0)
    s.setPlaying(false)
    a.setConfig(arpCfg({ enabled: false }))
    run(both, rec, 0.1, t)
    // paired on/off per note
    const counts = new Map<number, number>()
    for (const e of rec.events) {
      counts.set(e.note, (counts.get(e.note) ?? 0) + (e.type === 'on' ? 1 : -1))
    }
    for (const [note, c] of counts) expect(c, `note ${note} on/off balance`).toBe(0)
    expect(rec.events.length).toBeGreaterThan(10)
    // playhead reported stopped
    expect(rec.steps[rec.steps.length - 1].i).toBe(-1)
    expect(s.playing).toBe(false)
    expect(s.currentStep).toBe(-1)
  })

  it('reset() silently clears all state', () => {
    const rec = makeRec()
    const s = new StepSeq(SR, rec.hooks, MOTION_META)
    s.setSeq(fullSeq())
    s.setPlaying(true)
    run(s, rec, 0.3)
    const n = rec.events.length
    s.reset()
    expect(rec.events.length).toBe(n) // no hooks fired by reset
    expect(s.playing).toBe(false)
    expect(s.currentStep).toBe(-1)
    run(s, rec, 0.3)
    expect(rec.events.length).toBe(n) // stays silent until told to play
  })
})
