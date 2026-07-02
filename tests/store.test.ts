/*
 * Store + persistence tests: param get/set/clamp/listeners, bank seeding and
 * write/reload roundtrips (Map-backed localStorage shim), step/realtime/motion
 * recording behaviors from docs/xd-spec.md §11, and seq message coalescing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/state/store'
import { NUM_SLOTS } from '../src/state/persist'
import { P, MOTION_PITCH_BEND, PARAMS } from '../src/shared/params'
import { initProgram, NOTES_PER_STEP, MOTION_POINTS, type Program } from '../src/shared/program'
import { GATE_TIE, STEP_RESOLUTIONS } from '../src/shared/maps'
import type { ToEngine } from '../src/shared/messages'

// ---------------------------------------------------------------- test shims

class LocalStorageMock {
  private map = new Map<string, string>()
  /** Every key passed to getItem, in order (for lazy-load assertions). */
  gets: string[] = []
  getItem(key: string): string | null {
    this.gets.push(key)
    const v = this.map.get(key)
    return v === undefined ? null : v
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
  get length(): number {
    return this.map.size
  }
  key(i: number): string | null {
    return Array.from(this.map.keys())[i] ?? null
  }
}

let mock: LocalStorageMock
const hadLocalStorage = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage')
const originalLocalStorage = hadLocalStorage ? (globalThis as { localStorage?: unknown }).localStorage : undefined

beforeEach(() => {
  mock = new LocalStorageMock()
  Object.defineProperty(globalThis, 'localStorage', {
    value: mock,
    configurable: true,
    writable: true,
  })
})

afterEach(() => {
  if (hadLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', {
      value: originalLocalStorage,
      configurable: true,
      writable: true,
    })
  } else {
    delete (globalThis as { localStorage?: unknown }).localStorage
  }
})

function makeFactory(): Program[] {
  const a = initProgram('Fat Bass')
  a.params[P.CUTOFF] = 400
  const b = initProgram('Pad Two')
  b.params[P.RESONANCE] = 333
  return [a, b]
}

function capture(store: Store): ToEngine[] {
  const msgs: ToEngine[] = []
  store.connect((m) => msgs.push(m))
  return msgs
}

function seqMsgs(msgs: ToEngine[]): ToEngine[] {
  return msgs.filter((m) => m.t === 'seq')
}

const SLOT_KEY_RE = /^xd-web-bank-v1\/\d+$/

// ------------------------------------------------------------------- params

describe('Store params', () => {
  it('gets and sets param values', () => {
    const s = new Store(makeFactory())
    s.setParam(P.RESONANCE, 512)
    expect(s.getParam(P.RESONANCE)).toBe(512)
  })

  it('clamps via param meta (knob, dry/wet, switch, menu)', () => {
    const s = new Store(makeFactory())
    s.setParam(P.CUTOFF, 5000)
    expect(s.getParam(P.CUTOFF)).toBe(1023)
    s.setParam(P.CUTOFF, -3)
    expect(s.getParam(P.CUTOFF)).toBe(0)
    s.setParam(P.DELAY_DRYWET, 9999)
    expect(s.getParam(P.DELAY_DRYWET)).toBe(1024) // dry/wet max is 1024
    s.setParam(P.VCO1_WAVE, 7)
    expect(s.getParam(P.VCO1_WAVE)).toBe(2)
    s.setParam(P.PROGRAM_LEVEL, 0)
    expect(s.getParam(P.PROGRAM_LEVEL)).toBe(12) // menu min
    s.setParam(P.EG_INT, 300.6)
    expect(s.getParam(P.EG_INT)).toBe(301) // rounds
  })

  it('ignores NaN values and out-of-range ids', () => {
    const s = new Store(makeFactory())
    const before = s.getParam(P.CUTOFF)
    s.setParam(P.CUTOFF, NaN)
    s.setParam(P.CUTOFF, Infinity)
    expect(s.getParam(P.CUTOFF)).toBe(before)
    expect(() => s.setParam(-1, 5)).not.toThrow()
    expect(() => s.setParam(99999, 5)).not.toThrow()
    expect(s.getParam(99999)).toBe(0) // guarded read
  })

  it('notifies listeners with (id, value, source) and supports unsubscribe', () => {
    const s = new Store(makeFactory())
    const events: Array<[number, number, string]> = []
    const off = s.onParam((id, v, src) => events.push([id, v, src]))
    s.setParam(P.CUTOFF, 700)
    s.setParam(P.CUTOFF, 800, 'midi')
    expect(events).toEqual([
      [P.CUTOFF, 700, 'ui'],
      [P.CUTOFF, 800, 'midi'],
    ])
    off()
    s.setParam(P.CUTOFF, 900)
    expect(events.length).toBe(2)
  })

  it('forwards {t:"param"} to the sink with the clamped value', () => {
    const s = new Store(makeFactory())
    const msgs = capture(s)
    s.setParam(P.CUTOFF, 5000)
    const pm = msgs.filter((m) => m.t === 'param')
    expect(pm).toEqual([{ t: 'param', id: P.CUTOFF, v: 1023 }])
  })

  it('does not echo engine-sourced params back to the sink', () => {
    const s = new Store(makeFactory())
    const msgs = capture(s)
    s.setParam(P.CUTOFF, 600, 'engine')
    expect(msgs.filter((m) => m.t === 'param').length).toBe(0)
    expect(s.getParam(P.CUTOFF)).toBe(600) // still applied
  })

  it('marks dirty on ui/midi changes but not on silent load', () => {
    const s = new Store(makeFactory())
    expect(s.dirty).toBe(false)
    s.setParam(P.CUTOFF, s.getParam(P.CUTOFF)) // no-op set
    expect(s.dirty).toBe(false)
    s.setParam(P.CUTOFF, 222, 'load') // silent load: applies, not dirty
    expect(s.getParam(P.CUTOFF)).toBe(222)
    expect(s.dirty).toBe(false)
    s.setParam(P.CUTOFF, 333)
    expect(s.dirty).toBe(true)
  })
})

// ------------------------------------------------------------- bank/persist

describe('bank persistence', () => {
  it('seeds factory presets + Init Programs on first run', () => {
    const s = new Store(makeFactory())
    expect(s.program.name).toBe('Fat Bass')
    expect(s.getParam(P.CUTOFF)).toBe(400)
    const names = s.slotNames()
    expect(names.length).toBe(NUM_SLOTS)
    expect(NUM_SLOTS).toBe(500)
    expect(names[0]).toBe('Fat Bass')
    expect(names[1]).toBe('Pad Two')
    expect(names[2]).toBe('Init Program')
    expect(names[499]).toBe('Init Program')
    s.loadSlot(250)
    expect(s.program.name).toBe('Init Program')
  })

  it('roundtrips write -> reload through localStorage', () => {
    const s = new Store(makeFactory())
    s.setParam(P.CUTOFF, 123)
    s.setName('My Patch')
    s.writeSlot(7)
    expect(s.slot).toBe(7)
    expect(s.dirty).toBe(false)

    const s2 = new Store(makeFactory())
    expect(s2.slotNames()[7]).toBe('My Patch')
    s2.loadSlot(7)
    expect(s2.program.name).toBe('My Patch')
    expect(s2.getParam(P.CUTOFF)).toBe(123)
    expect(s2.dirty).toBe(false)
  })

  it('falls back to Init Program on corrupt slot entries', () => {
    new Store(makeFactory()) // first run seeds
    mock.setItem('xd-web-bank-v1/0', '{definitely not json')
    mock.setItem('xd-web-bank-v1/1', '"just a string"')
    const s = new Store(makeFactory())
    expect(s.program.name).toBe('Init Program') // slot 0 was corrupt
    s.loadSlot(1)
    expect(s.program.name).toBe('Init Program')
  })

  it('lazy-loads slots: startup reads only the current slot', () => {
    new Store(makeFactory()) // seed pass
    mock.gets.length = 0
    const s = new Store(makeFactory())
    const slotReads = mock.gets.filter((k) => SLOT_KEY_RE.test(k))
    expect(slotReads).toEqual(['xd-web-bank-v1/0'])
    // slot names come from the cheap index, not per-slot deserialization
    expect(s.slotNames().length).toBe(NUM_SLOTS)
    expect(mock.gets.filter((k) => SLOT_KEY_RE.test(k)).length).toBe(1)
    // touching another slot reads exactly that one
    s.loadSlot(42)
    const after = mock.gets.filter((k) => SLOT_KEY_RE.test(k))
    expect(after).toEqual(['xd-web-bank-v1/0', 'xd-web-bank-v1/42'])
  })

  it('writeSlot persists O(1): one slot entry + the names index', () => {
    const s = new Store(makeFactory())
    const setCounts = new Map<string, number>()
    const origSet = mock.setItem.bind(mock)
    mock.setItem = (k: string, v: string) => {
      setCounts.set(k, (setCounts.get(k) ?? 0) + 1)
      origSet(k, v)
    }
    s.setName('Solo Write')
    s.writeSlot(300)
    const slotWrites = Array.from(setCounts.keys()).filter((k) => SLOT_KEY_RE.test(k))
    expect(slotWrites).toEqual(['xd-web-bank-v1/300'])
    expect(setCounts.get('xd-web-bank-v1/names')).toBe(1)
  })

  it('runs the dirty-flag lifecycle across loadSlot/writeSlot', () => {
    const s = new Store(makeFactory())
    expect(s.dirty).toBe(false)
    s.setParam(P.CUTOFF, 999)
    expect(s.dirty).toBe(true)
    s.writeSlot() // defaults to current slot
    expect(s.slot).toBe(0)
    expect(s.dirty).toBe(false)
    s.setParam(P.CUTOFF, 111)
    expect(s.dirty).toBe(true)
    s.loadSlot(0) // discard edits
    expect(s.dirty).toBe(false)
    expect(s.getParam(P.CUTOFF)).toBe(999) // written value came back
    s.setName('Renamed')
    expect(s.dirty).toBe(true)
  })

  it('writeSlot returns false and stays dirty when the storage write fails', () => {
    const s = new Store(makeFactory())
    s.setParam(P.CUTOFF, 222)
    s.setName('No Room')
    expect(s.dirty).toBe(true)
    mock.setItem = () => {
      throw new DOMException('quota exceeded', 'QuotaExceededError')
    }
    expect(s.writeSlot(5)).toBe(false)
    expect(s.dirty).toBe(true) // still needs a (re)write
    expect(s.slot).toBe(5) // the in-memory bank switch still happened
    expect(s.slotNames()[5]).toBe('No Room') // live name index updated
    s.loadSlot(5)
    expect(s.program.name).toBe('No Room') // in-memory bank has the program
  })

  it('writeSlot returns true when persistence succeeds', () => {
    const s = new Store(makeFactory())
    s.setParam(P.CUTOFF, 321)
    expect(s.writeSlot(9)).toBe(true)
    expect(s.dirty).toBe(false)
  })

  it('edits do not leak into the bank until writeSlot', () => {
    const s = new Store(makeFactory())
    s.setParam(P.CUTOFF, 50)
    s.loadSlot(1)
    s.loadSlot(0)
    expect(s.getParam(P.CUTOFF)).toBe(400) // factory value, edit dropped
  })
})

// -------------------------------------------------------- program load/init

describe('program load / init', () => {
  it('connect immediately syncs the sink with a loadProgram', () => {
    const s = new Store(makeFactory())
    const msgs = capture(s)
    expect(msgs.length).toBe(1)
    expect(msgs[0].t).toBe('loadProgram')
  })

  it('loadSlot sends loadProgram and notifies params with source "load"', () => {
    const s = new Store(makeFactory())
    const msgs = capture(s)
    const sources = new Set<string>()
    let progEvents = 0
    s.onParam((_id, _v, src) => sources.add(src))
    s.onProgram(() => progEvents++)
    s.loadSlot(1)
    const loads = msgs.filter((m) => m.t === 'loadProgram')
    expect(loads.length).toBe(2) // connect + loadSlot
    expect(s.program.name).toBe('Pad Two')
    expect(sources).toEqual(new Set(['load']))
    expect(msgs.filter((m) => m.t === 'param').length).toBe(0) // silent
    expect(progEvents).toBe(1)
    expect(s.slot).toBe(1)
  })

  it('initCurrent resets to Init Program, marks dirty, sends loadProgram', () => {
    const s = new Store(makeFactory())
    const msgs = capture(s)
    s.initCurrent()
    expect(s.program.name).toBe('Init Program')
    expect(s.getParam(P.CUTOFF)).toBe(PARAMS[P.CUTOFF].def)
    expect(s.dirty).toBe(true)
    expect(msgs.filter((m) => m.t === 'loadProgram').length).toBe(2)
  })

  it('loadProgramData installs external program data', () => {
    const s = new Store(makeFactory())
    const msgs = capture(s)
    const p = initProgram('Imported')
    p.params[P.RESONANCE] = 777
    s.loadProgramData(p)
    expect(s.program.name).toBe('Imported')
    expect(s.getParam(P.RESONANCE)).toBe(777)
    expect(s.dirty).toBe(true)
    expect(msgs.filter((m) => m.t === 'loadProgram').length).toBe(2)
    // deep copy: mutating the source does not touch the store
    p.params[P.RESONANCE] = 1
    expect(s.getParam(P.RESONANCE)).toBe(777)
  })
})

// ------------------------------------------------------------ seq mutations

describe('sequencer editing', () => {
  it('coalesces seq mutations into one sink message per microtask', async () => {
    const s = new Store(makeFactory())
    const msgs = capture(s)
    let seqEvents = 0
    s.onSeq(() => seqEvents++)
    s.setSeqField('bpm', 140)
    s.setStep(0, [60], [100], [54])
    s.toggleActiveStep(4)
    s.setMotionLane(0, { paramId: P.CUTOFF, on: true })
    expect(seqMsgs(msgs).length).toBe(0) // nothing until the microtask
    expect(seqEvents).toBe(0)
    await Promise.resolve()
    expect(seqMsgs(msgs).length).toBe(1)
    expect(seqEvents).toBe(1)
    // a later mutation coalesces into its own single message
    s.setSeqField('swing', 20)
    s.clearStep(0)
    await Promise.resolve()
    expect(seqMsgs(msgs).length).toBe(2)
    expect(seqEvents).toBe(2)
  })

  it('clamps setSeqField values', () => {
    const s = new Store(makeFactory())
    s.setSeqField('bpm', 500)
    expect(s.program.seq.bpm).toBe(300)
    s.setSeqField('bpm', 3)
    expect(s.program.seq.bpm).toBe(10)
    s.setSeqField('bpm', 123.45)
    expect(s.program.seq.bpm).toBeCloseTo(123.5, 5) // 0.1 BPM resolution
    s.setSeqField('stepLength', 0)
    expect(s.program.seq.stepLength).toBe(1)
    s.setSeqField('stepLength', 99)
    expect(s.program.seq.stepLength).toBe(16)
    s.setSeqField('stepResolution', 9)
    expect(s.program.seq.stepResolution).toBe(4)
    s.setSeqField('swing', -200)
    expect(s.program.seq.swing).toBe(-75)
    s.setSeqField('defaultGate', 100)
    expect(s.program.seq.defaultGate).toBe(72)
    s.setSeqField('bpm', NaN)
    expect(s.program.seq.bpm).toBe(123.5)
  })

  it('setStep caps notes, fills default vels/gates; clearStep empties', () => {
    const s = new Store(makeFactory())
    const notes = Array.from({ length: 12 }, (_, i) => 60 + i)
    s.setStep(3, notes, [200], [])
    const st = s.program.seq.steps[3]
    expect(st.notes.length).toBe(NOTES_PER_STEP)
    expect(st.on).toBe(true)
    expect(st.vels[0]).toBe(127) // clamped
    expect(st.vels[1]).toBe(100) // default velocity
    expect(st.gates.every((g) => g === s.program.seq.defaultGate)).toBe(true)
    s.clearStep(3)
    expect(s.program.seq.steps[3]).toEqual({ on: false, notes: [], vels: [], gates: [] })
  })

  it('toggleStep only mutes/unmutes steps that have notes', () => {
    const s = new Store(makeFactory())
    s.toggleStep(0) // empty step: no-op
    expect(s.program.seq.steps[0].on).toBe(false)
    s.setStep(0, [60], [100], [54])
    expect(s.program.seq.steps[0].on).toBe(true)
    s.toggleStep(0)
    expect(s.program.seq.steps[0].on).toBe(false)
    expect(s.program.seq.steps[0].notes).toEqual([60]) // content kept
    s.toggleStep(0)
    expect(s.program.seq.steps[0].on).toBe(true)
  })

  it('toggleActiveStep flips the skip mask; clearSequence keeps settings', () => {
    const s = new Store(makeFactory())
    s.toggleActiveStep(5)
    expect(s.program.seq.activeSteps[5]).toBe(false)
    s.setSeqField('bpm', 99)
    s.setSeqField('stepLength', 12)
    s.setStep(2, [60], [100], [54])
    s.setMotionLane(0, { paramId: P.CUTOFF, on: true })
    s.clearSequence()
    const q = s.program.seq
    expect(q.bpm).toBe(99)
    expect(q.stepLength).toBe(12)
    expect(q.steps.every((st) => !st.on && st.notes.length === 0)).toBe(true)
    expect(q.activeSteps.every((a) => a)).toBe(true)
    expect(q.motion.every((l) => l.paramId === -1 && !l.on)).toBe(true)
  })
})

// ----------------------------------------------------------------- step rec

describe('step recording', () => {
  it('collects held keys and writes the chord when all are released', () => {
    const s = new Store(makeFactory())
    s.setRecMode('step')
    expect(s.recMode).toBe('step')
    expect(s.stepRecCursor).toBe(0)
    s.recNoteOn(60, 100)
    s.recNoteOn(64, 90)
    expect(s.stepRecCursor).toBe(0) // nothing written while held
    s.recNoteOff(60)
    expect(s.stepRecCursor).toBe(0) // one key still held
    expect(s.program.seq.steps[0].notes).toEqual([])
    s.recNoteOff(64)
    const st = s.program.seq.steps[0]
    expect(st.notes).toEqual([60, 64])
    expect(st.vels).toEqual([100, 90])
    expect(st.gates).toEqual([s.program.seq.defaultGate, s.program.seq.defaultGate])
    expect(st.on).toBe(true)
    expect(s.stepRecCursor).toBe(1) // advanced
  })

  it('recRest with no keys writes a rest and advances', () => {
    const s = new Store(makeFactory())
    s.setStep(0, [55], [100], [54]) // pre-existing content gets cleared
    s.setRecMode('step')
    s.recRest()
    const st = s.program.seq.steps[0]
    expect(st.on).toBe(false)
    expect(st.notes).toEqual([])
    expect(s.stepRecCursor).toBe(1)
  })

  it('recRest while keys held writes a TIE and continues the note', () => {
    const s = new Store(makeFactory())
    s.setRecMode('step')
    s.recNoteOn(55, 80)
    s.recRest() // tie
    expect(s.program.seq.steps[0].notes).toEqual([55])
    expect(s.program.seq.steps[0].gates).toEqual([GATE_TIE])
    expect(s.stepRecCursor).toBe(1)
    s.recRest() // still held: chains another tie
    expect(s.program.seq.steps[1].gates).toEqual([GATE_TIE])
    expect(s.stepRecCursor).toBe(2)
    s.recNoteOff(55) // release ends the tie chain with a normal gate
    expect(s.program.seq.steps[2].notes).toEqual([55])
    expect(s.program.seq.steps[2].vels).toEqual([80])
    expect(s.program.seq.steps[2].gates).toEqual([s.program.seq.defaultGate])
    expect(s.stepRecCursor).toBe(3)
  })

  it('exits rec mode when the cursor reaches stepLength', () => {
    const s = new Store(makeFactory())
    s.setSeqField('stepLength', 2)
    s.setRecMode('step')
    let recEvents = 0
    s.onRecChange(() => recEvents++)
    s.recNoteOn(60, 100)
    s.recNoteOff(60)
    expect(s.recMode).toBe('step')
    expect(s.stepRecCursor).toBe(1)
    s.recNoteOn(62, 100)
    s.recNoteOff(62)
    expect(s.recMode).toBe('off') // auto-exit
    expect(s.stepRecCursor).toBe(-1)
    expect(recEvents).toBeGreaterThan(0)
  })

  it('jumpStepRec moves the cursor (clamped to stepLength)', () => {
    const s = new Store(makeFactory())
    s.jumpStepRec(5) // not recording: no-op
    expect(s.stepRecCursor).toBe(-1)
    s.setRecMode('step')
    s.jumpStepRec(9)
    expect(s.stepRecCursor).toBe(9)
    s.recNoteOn(48, 100)
    s.recNoteOff(48)
    expect(s.program.seq.steps[9].notes).toEqual([48])
    expect(s.stepRecCursor).toBe(10)
    s.setSeqField('stepLength', 8)
    s.jumpStepRec(12)
    expect(s.stepRecCursor).toBe(7) // clamped to stepLength - 1
  })

  it('caps a collected chord at NOTES_PER_STEP', () => {
    const s = new Store(makeFactory())
    s.setRecMode('step')
    for (let i = 0; i < 10; i++) s.recNoteOn(40 + i, 100)
    for (let i = 0; i < 10; i++) s.recNoteOff(40 + i)
    expect(s.program.seq.steps[0].notes.length).toBe(NOTES_PER_STEP)
    expect(s.stepRecCursor).toBe(1)
  })

  it('starting playback cancels step rec', () => {
    const s = new Store(makeFactory())
    s.setRecMode('step')
    s.setPlaying(true)
    expect(s.recMode).toBe('off')
    expect(s.playing).toBe(true)
    s.setPlaying(false)
    expect(s.playing).toBe(false)
  })
})

// ------------------------------------------------------------- realtime rec

describe('realtime recording', () => {
  function playingStore(): Store {
    const s = new Store(makeFactory())
    s.setPlaying(true)
    s.setRecMode('realtime')
    s.setPlayhead(3)
    return s
  }

  it('overdubs notes onto the current playhead step, capped at 8', () => {
    const s = playingStore()
    s.recNoteOn(60, 100)
    s.recNoteOn(64, 90)
    const st = s.program.seq.steps[3]
    expect(st.notes).toEqual([60, 64])
    expect(st.on).toBe(true)
    for (let i = 0; i < 10; i++) s.recNoteOn(70 + i, 80)
    expect(st.notes.length).toBe(NOTES_PER_STEP)
    // overdubbing an existing note refreshes its velocity, no duplicate
    s.recNoteOn(60, 55)
    expect(st.notes.filter((n) => n === 60).length).toBe(1)
    expect(st.vels[0]).toBe(55)
  })

  it('recRest during realtime rec clears the current playhead step', () => {
    const s = playingStore()
    s.recNoteOn(60, 100)
    s.setPlayhead(4)
    s.recNoteOn(62, 100)
    s.recRest()
    expect(s.program.seq.steps[4]).toEqual({ on: false, notes: [], vels: [], gates: [] })
    expect(s.program.seq.steps[3].notes).toEqual([60]) // other steps untouched
  })

  it('does nothing when not playing or playhead invalid', () => {
    const s = new Store(makeFactory())
    s.setRecMode('realtime')
    s.recNoteOn(60, 100) // not playing
    expect(s.program.seq.steps.every((st) => st.notes.length === 0)).toBe(true)
    s.setPlaying(true)
    s.setPlayhead(-1)
    s.recNoteOn(60, 100)
    expect(s.program.seq.steps.every((st) => st.notes.length === 0)).toBe(true)
  })

  it('stopping playback exits realtime rec', () => {
    const s = playingStore()
    s.setPlaying(false)
    expect(s.recMode).toBe('off')
    expect(s.playhead).toBe(-1)
  })

  it('records real gate lengths: staccato vs held notes differ', () => {
    vi.useFakeTimers()
    try {
      const s = playingStore()
      const stepMs = (STEP_RESOLUTIONS[s.program.seq.stepResolution].beatsPerStep * 60000) / s.program.seq.bpm
      expect(stepMs).toBe(125) // 120 BPM, 1/16 steps
      s.recNoteOn(60, 100) // staccato: ~20% of the step
      vi.advanceTimersByTime(25)
      s.recNoteOff(60)
      s.setPlayhead(4)
      s.recNoteOn(62, 100) // held: ~80% of the step
      vi.advanceTimersByTime(100)
      s.recNoteOff(62)
      const g0 = s.program.seq.steps[3].gates[0]
      const g1 = s.program.seq.steps[4].gates[0]
      expect(g0).toBe(Math.round((72 * 25) / 125)) // 14
      expect(g1).toBe(Math.round((72 * 100) / 125)) // 58
      expect(g0).toBeLessThan(g1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a hold across a step boundary writes TIE and chains into the next step', () => {
    vi.useFakeTimers()
    try {
      const s = playingStore()
      s.recNoteOn(60, 90)
      vi.advanceTimersByTime(125) // full step elapses
      s.setPlayhead(4) // boundary: TIE into step 3, note re-added to step 4
      expect(s.program.seq.steps[3].gates).toEqual([GATE_TIE])
      expect(s.program.seq.steps[4].notes).toEqual([60])
      expect(s.program.seq.steps[4].vels).toEqual([90])
      expect(s.program.seq.steps[4].on).toBe(true)
      vi.advanceTimersByTime(62) // release ~half-way into step 4
      s.recNoteOff(60)
      expect(s.program.seq.steps[4].gates).toEqual([Math.round((72 * 62) / 125)]) // 36
    } finally {
      vi.useRealTimers()
    }
  })

  it('a hold across two boundaries chains TIE, TIE, then the remainder', () => {
    vi.useFakeTimers()
    try {
      const s = playingStore()
      s.recNoteOn(48, 100)
      vi.advanceTimersByTime(125)
      s.setPlayhead(4)
      vi.advanceTimersByTime(125)
      s.setPlayhead(5)
      vi.advanceTimersByTime(125)
      s.recNoteOff(48) // full third step: clamps at 100%
      expect(s.program.seq.steps[3].gates).toEqual([GATE_TIE])
      expect(s.program.seq.steps[4].gates).toEqual([GATE_TIE])
      expect(s.program.seq.steps[5].notes).toEqual([48])
      expect(s.program.seq.steps[5].gates).toEqual([72])
    } finally {
      vi.useRealTimers()
    }
  })

  it('notes still held when playback stops finalize with what elapsed', () => {
    vi.useFakeTimers()
    try {
      const s = playingStore()
      s.recNoteOn(60, 100)
      vi.advanceTimersByTime(50)
      s.setPlaying(false) // exits realtime rec: finalize held notes
      expect(s.recMode).toBe('off')
      expect(s.program.seq.steps[3].gates).toEqual([Math.round((72 * 50) / 125)]) // 29
    } finally {
      vi.useRealTimers()
    }
  })

  it('very short taps still record a non-zero gate', () => {
    vi.useFakeTimers()
    try {
      const s = playingStore()
      s.recNoteOn(60, 100)
      s.recNoteOff(60) // zero elapsed: gate clamps to 1, not 0
      expect(s.program.seq.steps[3].gates).toEqual([1])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports playhead updates to listeners', () => {
    const s = new Store(makeFactory())
    const seen: number[] = []
    s.onPlayhead((i) => seen.push(i))
    s.setPlayhead(0)
    s.setPlayhead(15)
    s.setPlayhead(16) // out of range -> -1
    expect(seen).toEqual([0, 15, -1])
    expect(s.playhead).toBe(-1)
  })
})

// --------------------------------------------------------------- motion rec

describe('motion recording', () => {
  function playingStore(): Store {
    const s = new Store(makeFactory())
    s.setPlaying(true)
    s.setRecMode('realtime')
    s.setPlayhead(2)
    return s
  }

  it('setParam during realtime rec allocates a lane and fills 5 points', () => {
    const s = playingStore()
    s.setParam(P.CUTOFF, 700)
    expect(s.getParam(P.CUTOFF)).toBe(700) // param always applies live
    const lane = s.findMotionLane(P.CUTOFF)
    expect(lane).toBe(0)
    const l = s.program.seq.motion[lane]
    expect(l.on).toBe(true)
    expect(l.smooth).toBe(true) // knob param meta
    expect(l.data[2]).toEqual([700, 700, 700, 700, 700])
  })

  it('subsequent writes in the same step shift-in to trace the movement', () => {
    const s = playingStore()
    s.setParam(P.CUTOFF, 700)
    s.setParam(P.CUTOFF, 720)
    expect(s.program.seq.motion[0].data[2]).toEqual([700, 700, 700, 700, 720])
    s.setParam(P.CUTOFF, 740)
    s.setParam(P.CUTOFF, 760)
    s.setParam(P.CUTOFF, 780)
    expect(s.program.seq.motion[0].data[2]).toEqual([700, 720, 740, 760, 780])
    s.setParam(P.CUTOFF, 800) // 6th write keeps tracing
    expect(s.program.seq.motion[0].data[2]).toEqual([720, 740, 760, 780, 800])
  })

  it('a new step (or loop wrap) starts a fresh fill', () => {
    const s = playingStore()
    s.setParam(P.CUTOFF, 700)
    s.setParam(P.CUTOFF, 750)
    s.setPlayhead(3)
    s.setParam(P.CUTOFF, 500)
    expect(s.program.seq.motion[0].data[3]).toEqual([500, 500, 500, 500, 500])
    expect(s.program.seq.motion[0].data[2]).toEqual([700, 700, 700, 700, 750])
    s.setPlayhead(2) // wrap back: overwrite, don't continue the shift-in
    s.setParam(P.CUTOFF, 900)
    expect(s.program.seq.motion[0].data[2]).toEqual([900, 900, 900, 900, 900])
  })

  it('records switch params stepwise and virtual targets smooth/unclamped', () => {
    const s = playingStore()
    expect(s.recKnob(P.VCO1_WAVE, 1)).toBe(true)
    const wl = s.findMotionLane(P.VCO1_WAVE)
    expect(s.program.seq.motion[wl].smooth).toBe(false)
    expect(s.program.seq.motion[wl].data[2]).toEqual([1, 1, 1, 1, 1])
    expect(s.recKnob(MOTION_PITCH_BEND, 0.5)).toBe(true)
    const bl = s.findMotionLane(MOTION_PITCH_BEND)
    expect(s.program.seq.motion[bl].smooth).toBe(true)
    expect(s.program.seq.motion[bl].data[2]).toEqual([0.5, 0.5, 0.5, 0.5, 0.5])
  })

  it('rejects non-recordable params and NaN, and respects the 4-lane limit', () => {
    const s = playingStore()
    expect(s.recKnob(P.DRIVE, 1)).toBe(false) // DRIVE not motion-recordable
    expect(s.recKnob(P.CUTOFF, NaN)).toBe(false)
    expect(s.recKnob(P.CUTOFF, 500)).toBe(true)
    expect(s.recKnob(P.RESONANCE, 100)).toBe(true)
    expect(s.recKnob(P.VCO1_PITCH, 600)).toBe(true)
    expect(s.recKnob(P.LFO_RATE, 300)).toBe(true)
    expect(s.recKnob(P.VCO2_PITCH, 512)).toBe(false) // lanes full
    expect(s.findMotionLane(P.VCO2_PITCH)).toBe(-1)
    expect(s.findMotionLane(P.VCO2_PITCH, true)).toBe(-1) // full even with allocate
    expect(s.recKnob(P.CUTOFF, 501)).toBe(true) // existing lane still records
  })

  it('returns false when not in realtime rec while playing', () => {
    const s = new Store(makeFactory())
    expect(s.recKnob(P.CUTOFF, 500)).toBe(false) // rec off
    s.setRecMode('realtime')
    expect(s.recKnob(P.CUTOFF, 500)).toBe(false) // not playing
    s.setPlaying(true)
    s.setPlayhead(-1)
    expect(s.recKnob(P.CUTOFF, 500)).toBe(false) // no playhead
  })

  it('findMotionLane reuses an existing lane and allocates on demand', () => {
    const s = new Store(makeFactory())
    expect(s.findMotionLane(P.CUTOFF)).toBe(-1)
    const a = s.findMotionLane(P.CUTOFF, true)
    expect(a).toBe(0)
    expect(s.findMotionLane(P.CUTOFF)).toBe(0) // reuse
    expect(s.findMotionLane(P.CUTOFF, true)).toBe(0) // allocate reuses too
    const b = s.findMotionLane(P.RESONANCE, true)
    expect(b).toBe(1)
  })

  it('writeMotionStep pads/clamps points; clearMotionLane resets the lane', () => {
    const s = new Store(makeFactory())
    s.setMotionLane(0, { paramId: P.CUTOFF, on: true, smooth: true })
    s.writeMotionStep(0, 4, [2000])
    expect(s.program.seq.motion[0].data[4]).toEqual([1023, 1023, 1023, 1023, 1023])
    s.writeMotionStep(0, 5, [100, 200, 300])
    expect(s.program.seq.motion[0].data[5]).toEqual([100, 200, 300, 300, 300])
    expect(s.program.seq.motion[0].data[5]?.length).toBe(MOTION_POINTS)
    s.writeMotionStep(0, 4, [])
    expect(s.program.seq.motion[0].data[4]).toBeNull()
    s.clearMotionLane(0)
    const l = s.program.seq.motion[0]
    expect(l.paramId).toBe(-1)
    expect(l.on).toBe(false)
    expect(l.data.every((d) => d === null)).toBe(true)
  })
})

// -------------------------------------------------------------- persistence
// of everything through a full write/reload cycle (seq + motion included)

describe('full program roundtrip through the bank', () => {
  it('persists sequence and motion data across a reload', () => {
    const s = new Store(makeFactory())
    s.setStep(0, [60, 64, 67], [100, 90, 80], [54, 54, GATE_TIE])
    s.toggleActiveStep(7)
    s.setSeqField('bpm', 174)
    s.setMotionLane(1, { paramId: P.CUTOFF, on: true, smooth: true })
    s.writeMotionStep(1, 0, [10, 20, 30, 40, 50])
    s.setName('Seq Prog')
    s.writeSlot(33)

    const s2 = new Store(makeFactory())
    s2.loadSlot(33)
    const q = s2.program.seq
    expect(s2.program.name).toBe('Seq Prog')
    expect(q.bpm).toBe(174)
    expect(q.steps[0].notes).toEqual([60, 64, 67])
    expect(q.steps[0].gates[2]).toBe(GATE_TIE)
    expect(q.activeSteps[7]).toBe(false)
    expect(q.motion[1].paramId).toBe(P.CUTOFF)
    expect(q.motion[1].on).toBe(true)
    expect(q.motion[1].data[0]).toEqual([10, 20, 30, 40, 50])
  })
})
