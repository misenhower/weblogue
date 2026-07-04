/*
 * VoiceBank + NoteStack unit tests: pin the synth-agnostic voice-allocation
 * contract (rotor round-robin, released fallback, steal + pended restarts,
 * damper semantics, pair allocation) that 'logue-family engines build on.
 * Fake BankVoice objects stand in for real voices: kill() leaves the voice
 * active until the test "finishes the ramp" by calling stop().
 */
import { describe, expect, it } from 'vitest'
import { NoteStack, VoiceBank, type BankVoice } from '../src/dsp/voicebank'

class FakeVoice implements BankVoice {
  active = false
  kills = 0
  offs = 0
  kill(): void {
    this.kills++ // kill ramp: stays active until stop()
  }
  noteOff(): void {
    this.offs++
  }
  start(): void {
    this.active = true
  }
  stop(): void {
    this.active = false
  }
}

function makeBank(n = 4): { bank: VoiceBank<FakeVoice>; voices: FakeVoice[] } {
  const voices = Array.from({ length: n }, () => new FakeVoice())
  return { bank: new VoiceBank(voices), voices }
}

/** alloc + start + book-keep, returning the voice index. */
function startNote(bank: VoiceBank<FakeVoice>, voices: FakeVoice[], key: number): number {
  const i = bank.alloc()
  expect(i).toBeGreaterThanOrEqual(0)
  voices[i].start()
  bank.started(i, key, key, false)
  return i
}

describe('VoiceBank alloc: rotor round-robin', () => {
  it('walks voices in order and wraps after the last one', () => {
    const { bank, voices } = makeBank()
    expect(startNote(bank, voices, 60)).toBe(0)
    expect(startNote(bank, voices, 61)).toBe(1)
    expect(startNote(bank, voices, 62)).toBe(2)
    expect(startNote(bank, voices, 63)).toBe(3)
    for (const v of voices) v.stop()
    expect(bank.alloc()).toBe(0) // rotor wrapped past the end
  })

  it('resumes from the rotor, not from the first free voice', () => {
    const { bank, voices } = makeBank()
    startNote(bank, voices, 60) // 0
    startNote(bank, voices, 61) // 1
    voices[0].stop() // 0 is free again, but the rotor sits at 2
    expect(bank.alloc()).toBe(2)
  })

  it('falls back to the oldest gate-released voice when none are idle', () => {
    const { bank, voices } = makeBank()
    for (let k = 0; k < 4; k++) startNote(bank, voices, 60 + k)
    bank.gateOff(2)
    bank.gateOff(1)
    expect(bank.alloc()).toBe(1) // oldest by start generation, not release order
  })

  it('returns -1 when every voice is busy and none are released', () => {
    const { bank, voices } = makeBank()
    for (let k = 0; k < 4; k++) startNote(bank, voices, 60 + k)
    expect(bank.alloc()).toBe(-1)
  })
})

describe('VoiceBank steal + drainPend restart flow', () => {
  it('oldest() picks the lowest generation, tracking restarts', () => {
    const { bank, voices } = makeBank()
    for (let k = 0; k < 4; k++) startNote(bank, voices, 60 + k)
    expect(bank.oldest()).toBe(0)
    bank.started(0, 72, 72, false) // re-gen voice 0: now the newest
    expect(bank.oldest()).toBe(1)
  })

  it('steal kills now and drainPend fires only once the ramp has faded', () => {
    const { bank, voices } = makeBank()
    for (let k = 0; k < 4; k++) startNote(bank, voices, 60 + k)
    const t = bank.oldest()
    bank.steal(t, 72, 74, 99, true, 0.5, 0.9, false)
    expect(voices[t].kills).toBe(1)
    expect(bank.keyOf(t)).toBe(72) // identity flips to the new note immediately
    expect(bank.noteOf(t)).toBe(74)
    expect(bank.isReleased(t)).toBe(false)

    const fired: unknown[][] = []
    const cb = (i: number, key: number, note: number, vel: number, glide: boolean, det: number, gain: number, stacked: boolean): void => {
      fired.push([i, key, note, vel, glide, det, gain, stacked])
      voices[i].start()
      bank.started(i, key, note, stacked)
    }
    bank.drainPend(cb)
    expect(fired).toEqual([]) // voice still active: ramp not finished

    voices[t].stop() // kill ramp done
    bank.drainPend(cb)
    expect(fired).toEqual([[t, 72, 74, 99, true, 0.5, 0.9, false]])

    bank.drainPend(cb) // started() cleared the pend: nothing left
    expect(fired.length).toBe(1)
  })

  it('a stolen voice is not re-allocated while its restart is pending', () => {
    const { bank, voices } = makeBank()
    for (let k = 0; k < 4; k++) startNote(bank, voices, 60 + k)
    bank.steal(0, 72, 72, 100, false, 0, 1, false)
    voices[0].stop() // faded, but the pend has not fired yet
    expect(bank.alloc()).toBe(-1)
  })

  it('releaseKey cancels a pended restart that never fired', () => {
    const { bank, voices } = makeBank()
    for (let k = 0; k < 4; k++) startNote(bank, voices, 60 + k)
    bank.steal(1, 72, 72, 100, false, 0, 1, false)
    bank.releaseKey(72, false) // key up before the ramp finished
    expect(bank.keyOf(1)).toBe(-1)
    voices[1].stop()
    let fired = 0
    bank.drainPend(() => fired++)
    expect(fired).toBe(0)
  })
})

describe('VoiceBank damper semantics', () => {
  it('releaseKey: sustain defers the release until flushSustained', () => {
    const { bank, voices } = makeBank()
    startNote(bank, voices, 60)
    bank.releaseKey(60, true)
    expect(voices[0].offs).toBe(0) // deferred, still gated
    expect(bank.isReleased(0)).toBe(false)
    bank.flushSustained(() => true) // key still held somewhere: keep it
    expect(voices[0].offs).toBe(0)
    bank.releaseKey(60, true) // defer again (flush cleared the flag)
    bank.flushSustained(() => false) // pedal up, key gone
    expect(voices[0].offs).toBe(1)
    expect(bank.isReleased(0)).toBe(true)
  })

  it('releaseAll: releases every gated voice, or defers them all with sustain', () => {
    const { bank, voices } = makeBank()
    startNote(bank, voices, 60)
    startNote(bank, voices, 64)
    bank.releaseAll(true)
    expect(voices[0].offs + voices[1].offs).toBe(0) // all deferred
    bank.flushSustained(() => false)
    expect(voices[0].offs).toBe(1)
    expect(voices[1].offs).toBe(1)

    const second = makeBank()
    startNote(second.bank, second.voices, 60)
    startNote(second.bank, second.voices, 64)
    second.bank.releaseAll(false)
    expect(second.voices[0].offs).toBe(1)
    expect(second.voices[1].offs).toBe(1)
  })

  it('hardReleaseAll ignores the damper and clears deferrals', () => {
    const { bank, voices } = makeBank()
    startNote(bank, voices, 60)
    bank.releaseAll(true) // deferred behind the pedal
    bank.hardReleaseAll()
    expect(voices[0].offs).toBe(1)
    bank.flushSustained(() => false) // deferral was cleared: no double release
    expect(voices[0].offs).toBe(1)
  })

  it('releaseAll cancels pended restarts', () => {
    const { bank, voices } = makeBank()
    for (let k = 0; k < 4; k++) startNote(bank, voices, 60 + k)
    bank.steal(0, 72, 72, 100, false, 0, 1, false)
    bank.releaseAll(false)
    voices[0].stop()
    let fired = 0
    bank.drainPend(() => fired++)
    expect(fired).toBe(0)
  })
})

describe('VoiceBank pair + rotor claiming', () => {
  it('allocPair: idle pairs via the pair rotor, then released, then steal', () => {
    const { bank, voices } = makeBank()
    expect(bank.allocPair()).toEqual({ pair: 0, kind: 'idle' })
    voices[0].start()
    voices[1].start()
    bank.started(0, 48, 48, false)
    bank.started(1, 48, 48, true)
    expect(bank.allocPair()).toEqual({ pair: 1, kind: 'idle' }) // rotor advanced
    voices[2].start()
    voices[3].start()
    bank.started(2, 50, 50, false)
    bank.started(3, 50, 50, true)

    bank.gateOff(2)
    bank.gateOff(3) // pair 1 fully released
    expect(bank.allocPair()).toEqual({ pair: 1, kind: 'released' })

    bank.started(2, 52, 52, false) // pair 1 gated again: nothing released
    bank.started(3, 52, 52, true)
    expect(bank.allocPair()).toEqual({ pair: 0, kind: 'steal' }) // oldest pair
  })

  it('allocPair on a single-voice bank returns pair -1 (misuse guard)', () => {
    const { bank } = makeBank(1)
    expect(bank.allocPair()).toEqual({ pair: -1, kind: 'steal' })
  })

  it('takeRotor claims consecutive indices and wraps modulo the bank size', () => {
    const { bank } = makeBank()
    expect(bank.takeRotor(3)).toBe(0)
    expect(bank.takeRotor(3)).toBe(3) // wraps: next rotor = (3 + 3) % 4
    expect(bank.takeRotor(2)).toBe(2)
    expect(bank.takeRotor(1)).toBe(0)
  })

  it('setNote re-voices a sounding note without touching its key', () => {
    const { bank, voices } = makeBank()
    startNote(bank, voices, 60)
    bank.setNote(0, 48) // e.g. POLY-invert re-voicing
    expect(bank.noteOf(0)).toBe(48)
    expect(bank.keyOf(0)).toBe(60)
  })
})

describe('NoteStack', () => {
  it('push/top/remove/count keep last-note priority order', () => {
    const s = new NoteStack()
    s.push(60, 100)
    s.push(64, 110)
    expect(s.count).toBe(2)
    expect(s.topNote()).toBe(64)
    expect(s.topVel()).toBe(110)
    s.remove(60) // removing below the top keeps the top
    expect(s.count).toBe(1)
    expect(s.topNote()).toBe(64)
    s.remove(64)
    expect(s.count).toBe(0)
    expect(s.topNote()).toBe(-1)
    expect(s.topVel()).toBe(0)
  })

  it('remove drops the most recent instance of a duplicated note', () => {
    const s = new NoteStack()
    s.push(60, 100)
    s.push(62, 100)
    s.push(60, 100) // retrigger of 60
    s.remove(60)
    expect(s.count).toBe(2)
    expect(s.topNote()).toBe(62) // the earlier 60 is still below
    expect(s.contains(60)).toBe(true)
  })

  it('overflowing the stack drops the oldest entry', () => {
    const s = new NoteStack()
    for (let n = 0; n < 65; n++) s.push(n, 100)
    expect(s.count).toBe(64)
    expect(s.contains(0)).toBe(false)
    expect(s.topNote()).toBe(64)
  })

  it('tracks physically-held keys and clears them with a callback', () => {
    const s = new NoteStack()
    s.setHeld(60, true)
    s.setHeld(64, true)
    expect(s.isHeld(60)).toBe(true)
    const cleared: number[] = []
    s.clearHeld((n) => cleared.push(n))
    expect(cleared).toEqual([60, 64])
    expect(s.isHeld(60)).toBe(false)
  })

  it('flushMonoSustained releases the current mono note LAST', () => {
    const s = new NoteStack()
    s.setMonoSustained(60, true)
    s.setMonoSustained(64, true)
    s.setMonoSustained(67, true)
    const released: number[] = []
    s.flushMonoSustained(64, (n) => released.push(n))
    expect(released).toEqual([60, 67, 64]) // current note after the others
    expect(s.isMonoSustained(60)).toBe(false)
  })

  it('flushMonoSustained skips (but clears) keys that are still held', () => {
    const s = new NoteStack()
    s.setMonoSustained(60, true)
    s.setMonoSustained(64, true)
    s.setHeld(60, true)
    const released: number[] = []
    s.flushMonoSustained(-1, (n) => released.push(n))
    expect(released).toEqual([64])
    expect(s.isMonoSustained(60)).toBe(false) // deferral consumed either way
  })
})
