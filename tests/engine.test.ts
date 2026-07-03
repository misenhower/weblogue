/*
 * Engine acceptance tests: construct Engine directly (never the worklet) and
 * render audio offline in 128-frame blocks.
 */
import { describe, it, expect } from 'vitest'
import { Engine } from '../src/synths/xd/engine'
import { initProgram } from '../src/synths/xd/program'
import { P, PARAMS, PARAM_COUNT } from '../src/synths/xd/params'
import { FACTORY_PRESETS } from '../src/state/presets'

const SR = 48000
const BLOCK = 128

/** Render `seconds` of audio; cb runs before each block. Returns mono (L). */
function render(e: Engine, seconds: number, cb?: (blockIndex: number, done: number) => void): Float32Array {
  const total = Math.round(seconds * SR)
  const out = new Float32Array(total)
  const l = new Float32Array(BLOCK)
  const r = new Float32Array(BLOCK)
  let done = 0
  let b = 0
  while (done < total) {
    const n = Math.min(BLOCK, total - done)
    if (cb) cb(b++, done)
    e.process(l, r, n)
    out.set(l.subarray(0, n), done)
    done += n
  }
  return out
}

function rms(buf: Float32Array, from = 0, to = buf.length): number {
  let sum = 0
  const n = Math.max(1, to - from)
  for (let i = from; i < to; i++) sum += buf[i] * buf[i]
  return Math.sqrt(sum / n)
}

function assertFiniteBounded(buf: Float32Array): void {
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i]
    if (!Number.isFinite(v) || v < -2 || v > 2) {
      throw new Error(`sample ${i} out of bounds: ${v}`)
    }
  }
}

/** Mean frequency estimate via positive-going zero crossings. */
function zcFreq(buf: Float32Array, from: number, to: number): number {
  let crossings = 0
  for (let i = from + 1; i < to; i++) {
    if (buf[i - 1] <= 0 && buf[i] > 0) crossings++
  }
  return (crossings * SR) / (to - from)
}

/** mulberry32 — deterministic fuzz. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), s | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// -----------------------------------------------------------------------------

describe('engine basics', () => {
  it('init program: noteOn renders nonzero finite audio, noteOff releases to silence', () => {
    const e = new Engine(SR)
    e.loadProgram(initProgram())
    e.noteOn(60, 100)
    const held = render(e, 0.2)
    assertFiniteBounded(held)
    expect(rms(held, Math.floor(0.05 * SR))).toBeGreaterThan(1e-4)
    e.noteOff(60)
    const rel = render(e, 0.5)
    assertFiniteBounded(rel)
    // Init program has fast release and no FX: fully silent by the tail.
    expect(rms(rel, rel.length - Math.floor(0.1 * SR))).toBeLessThan(1e-5)
  })
})

describe('all factory presets render', () => {
  for (const preset of FACTORY_PRESETS) {
    it(`"${preset.name}" produces bounded, audible output`, () => {
      const e = new Engine(SR)
      e.loadProgram(preset)
      // C-minor triad. ARP presets route these keys into the arpeggiator,
      // whose hook noteOns re-enter the poly allocator during process().
      e.noteOn(60, 100)
      e.noteOn(63, 100)
      e.noteOn(67, 100)
      const held = render(e, 0.3)
      assertFiniteBounded(held)
      expect(rms(held, Math.floor(0.05 * SR))).toBeGreaterThan(1e-4)
      e.noteOff(60)
      e.noteOff(63)
      e.noteOff(67)
      const rel = render(e, 0.2)
      assertFiniteBounded(rel)
    })
  }
})

describe('voice modes', () => {
  function leadProgram() {
    const p = initProgram()
    p.params[P.VCO1_LEVEL] = 600
    p.params[P.PROGRAM_LEVEL] = 82 // -4 dB: keep the unison sum in the linear zone
    p.params[P.AMP_ATTACK] = 0
    p.params[P.AMP_SUSTAIN] = 1023
    return p
  }

  it('UNISON single note carries ~4x the energy of one POLY voice (ratio > 2x)', () => {
    const poly = new Engine(SR)
    poly.loadProgram(leadProgram())
    poly.noteOn(60, 100)
    const a = render(poly, 0.3)
    const rmsPoly = rms(a, Math.floor(0.05 * SR))

    const prog = leadProgram()
    prog.params[P.VOICE_MODE] = 2 // UNISON
    prog.params[P.VM_DEPTH] = 0 // no detune: coherent stack
    const uni = new Engine(SR)
    uni.loadProgram(prog)
    uni.noteOn(60, 100)
    const b = render(uni, 0.3)
    const rmsUni = rms(b, Math.floor(0.05 * SR))

    assertFiniteBounded(a)
    assertFiniteBounded(b)
    expect(uni.activeVoiceCount()).toBe(4)
    expect(rmsUni).toBeGreaterThan(2 * rmsPoly)
  })

  it('CHORD mode: one key sounds multiple voices', () => {
    const prog = initProgram()
    prog.params[P.VOICE_MODE] = 1 // CHORD
    prog.params[P.VM_DEPTH] = 400 // m7 zone: 4 chord tones
    const e = new Engine(SR)
    e.loadProgram(prog)
    e.noteOn(60, 100)
    const buf = render(e, 0.2)
    assertFiniteBounded(buf)
    expect(e.activeVoiceCount()).toBeGreaterThanOrEqual(2)
    expect(rms(buf, Math.floor(0.05 * SR))).toBeGreaterThan(1e-4)
  })

  it('live steal: victim fades first, pended restart still fires (no deadlock)', () => {
    const e = new Engine(SR)
    const p = initProgram()
    p.params[P.AMP_SUSTAIN] = 1023
    e.loadProgram(p)
    for (const n of [60, 62, 64, 65]) e.noteOn(n, 100)
    render(e, 0.05)
    e.noteOn(67, 100) // arrives between blocks: kill ramp must run first
    render(e, 0.05) // fade completes, then the pended restart fires
    const notes: number[] = []
    e.collectActiveNotes(notes)
    expect(notes).toContain(67) // restarted
    expect(notes).not.toContain(60) // oldest voice was the victim
    expect(e.activeVoiceCount()).toBe(4)
  })

  it('voice stealing: 8 rapid noteOns -> no crash, <=4 active, finite', () => {
    const e = new Engine(SR)
    e.loadProgram(initProgram())
    for (let k = 0; k < 8; k++) {
      e.noteOn(60 + k, 100)
      render(e, 0.01) // a block or two between presses (pending restarts fire)
    }
    const buf = render(e, 0.2)
    assertFiniteBounded(buf)
    expect(e.activeVoiceCount()).toBeLessThanOrEqual(4)
    expect(e.activeVoiceCount()).toBeGreaterThan(0)
    expect(rms(buf)).toBeGreaterThan(1e-4)
  })
})

describe('robustness', () => {
  it('param fuzz: 2 s of random params on a held note stays finite and bounded', () => {
    const e = new Engine(SR)
    e.loadProgram(initProgram())
    e.noteOn(60, 100)
    const rng = makeRng(0xfeedbeef)
    const reNoteEvery = Math.round(0.25 * SR)
    let nextNote = reNoteEvery
    const buf = render(e, 2.0, (_b, done) => {
      for (let k = 0; k < 3; k++) {
        const id = Math.floor(rng() * PARAM_COUNT)
        const m = PARAMS[id]
        e.setParam(id, m.min + rng() * (m.max - m.min))
      }
      if (rng() < 0.1) e.setBend(rng() * 2 - 1)
      if (rng() < 0.1) e.setJoyY(rng() * 2 - 1)
      if (done >= nextNote) {
        nextNote += reNoteEvery
        e.noteOn(48 + Math.floor(rng() * 24), 1 + Math.floor(rng() * 126))
      }
    })
    assertFiniteBounded(buf)
  })

  it('sync + ring + cross mod all engaged: finite and audibly different from plain', () => {
    function osc2Program() {
      const p = initProgram()
      p.params[P.VCO1_LEVEL] = 800
      p.params[P.VCO2_LEVEL] = 800
      p.params[P.VCO2_PITCH] = 700 // ~+340 cents
      p.params[P.AMP_ATTACK] = 0
      p.params[P.AMP_SUSTAIN] = 1023
      return p
    }
    const plainE = new Engine(SR)
    plainE.loadProgram(osc2Program())
    plainE.noteOn(48, 100)
    const plain = render(plainE, 0.3)

    const prog = osc2Program()
    prog.params[P.SYNC] = 1
    prog.params[P.RING] = 1
    prog.params[P.CROSS_MOD] = 900
    const dirtyE = new Engine(SR)
    dirtyE.loadProgram(prog)
    dirtyE.noteOn(48, 100)
    const dirty = render(dirtyE, 0.3)

    assertFiniteBounded(plain)
    assertFiniteBounded(dirty)
    // Same deterministic drift seeds: any difference is sync/ring/xmod.
    const from = Math.floor(0.05 * SR)
    let diff = 0
    for (let i = from; i < plain.length; i++) {
      const d = plain[i] - dirty[i]
      diff += d * d
    }
    const diffRms = Math.sqrt(diff / (plain.length - from))
    expect(diffRms).toBeGreaterThan(0.1 * rms(plain, from))
  })
})

describe('VPM menu trims', () => {
  /** Multi-only VPM patch (Fat1: baked feedback + internal drive). */
  function vpmProgram() {
    const p = initProgram()
    p.params[P.MULTI_TYPE] = 1 // VPM
    p.params[P.SELECT_VPM] = 8 // Fat1
    p.params[P.SHAPE_VPM] = 700
    p.params[P.SHIFTSHAPE_VPM] = 0
    p.params[P.MULTI_LEVEL] = 1023
    p.params[P.VCO1_LEVEL] = 0
    p.params[P.VCO2_LEVEL] = 0
    p.params[P.AMP_ATTACK] = 0
    p.params[P.AMP_SUSTAIN] = 1023
    return p
  }

  function renderWith(prep: (e: Engine) => void): Float32Array {
    const e = new Engine(SR)
    prep(e)
    e.noteOn(60, 100)
    return render(e, 0.3)
  }

  function diffRms(a: Float32Array, b: Float32Array, from: number): number {
    let sum = 0
    for (let i = from; i < a.length; i++) {
      const d = a[i] - b[i]
      sum += d * d
    }
    return Math.sqrt(sum / (a.length - from))
  }

  const FROM = Math.floor(0.05 * SR)

  it('setParam(VPM_FEEDBACK, 200) changes the rendered output', () => {
    const base = renderWith((e) => e.loadProgram(vpmProgram()))
    const fb = renderWith((e) => {
      e.loadProgram(vpmProgram())
      e.setParam(P.VPM_FEEDBACK, 200)
    })
    assertFiniteBounded(base)
    assertFiniteBounded(fb)
    expect(rms(base, FROM)).toBeGreaterThan(1e-4)
    // Same deterministic drift seeds: any difference is the feedback trim.
    expect(diffRms(base, fb, FROM)).toBeGreaterThan(1e-4)
  })

  it('neutral trim values (100) leave the output unchanged', () => {
    const base = renderWith((e) => e.loadProgram(vpmProgram()))
    const neutral = renderWith((e) => {
      e.loadProgram(vpmProgram())
      e.setParam(P.VPM_FEEDBACK, 100)
      e.setParam(P.VPM_NOISE_DEPTH, 100)
      e.setParam(P.VPM_SHAPE_MOD_INT, 100)
      e.setParam(P.VPM_MOD_ATTACK, 100)
      e.setParam(P.VPM_MOD_DECAY, 100)
      e.setParam(P.VPM_KEY_TRACK, 100)
    })
    expect(diffRms(base, neutral, 0)).toBeLessThan(1e-12)
  })

  it('loadProgram applies stored trims (identical to the setParam path)', () => {
    const prog = vpmProgram()
    prog.params[P.VPM_FEEDBACK] = 200
    prog.params[P.VPM_NOISE_DEPTH] = 180
    const fromLoad = renderWith((e) => e.loadProgram(prog))
    const fromSet = renderWith((e) => {
      e.loadProgram(vpmProgram())
      e.setParam(P.VPM_FEEDBACK, 200)
      e.setParam(P.VPM_NOISE_DEPTH, 180)
    })
    const base = renderWith((e) => e.loadProgram(vpmProgram()))
    assertFiniteBounded(fromLoad)
    // trims took effect...
    expect(diffRms(fromLoad, base, FROM)).toBeGreaterThan(1e-4)
    // ...and both application paths land on the same audio
    let maxDiff = 0
    for (let i = 0; i < fromLoad.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(fromLoad[i] - fromSet[i]))
    }
    expect(maxDiff).toBeLessThan(1e-7)
  })
})

describe('portamento', () => {
  it('glide: pitch moves gradually between sequential notes', () => {
    const prog = initProgram()
    prog.params[P.PORTAMENTO] = 70 // ~180 ms
    prog.params[P.PORTAMENTO_MODE] = 1 // On (always glide)
    prog.params[P.AMP_ATTACK] = 0
    prog.params[P.AMP_SUSTAIN] = 1023
    const e = new Engine(SR)
    e.loadProgram(prog)
    e.noteOn(48, 100) // C2 ~130.8 Hz
    render(e, 0.4) // settle
    e.noteOff(48)
    render(e, 0.05) // voice fully idle
    e.noteOn(72, 100) // C5 ~523.3 Hz
    const buf = render(e, 1.0)
    assertFiniteBounded(buf)
    const fEarly = zcFreq(buf, 0, Math.floor(0.06 * SR))
    const fMid = zcFreq(buf, Math.floor(0.1 * SR), Math.floor(0.16 * SR))
    const fLate = zcFreq(buf, Math.floor(0.8 * SR), Math.floor(0.95 * SR))
    expect(fEarly).toBeLessThan(300) // still near the old note
    expect(fMid).toBeGreaterThan(fEarly) // moving up
    expect(fLate).toBeGreaterThan(fMid) // still converging upward
    expect(fLate).toBeGreaterThan(420) // essentially arrived at C5
    expect(fLate).toBeLessThan(650)
  })
})

describe('joystick Y assign', () => {
  it('Y- with -100% range closes the filter (deflection sign not double-applied)', () => {
    const e = new Engine(SR)
    const p = initProgram()
    p.params[P.CUTOFF] = 512
    e.loadProgram(p)
    // init defaults: Y- assign = CUTOFF, Y- range = -100%
    e.setJoyY(-1)
    render(e, 0.01)
    expect(e.effectiveParam(P.CUTOFF)).toBe(0) // full down CLOSES the filter
    e.setJoyY(0)
    render(e, 0.01)
    expect(e.effectiveParam(P.CUTOFF)).toBe(512)
  })

  it('Y+ with +100% range raises its destination (LFO INT default)', () => {
    const e = new Engine(SR)
    e.loadProgram(initProgram()) // Y+ assign = LFO INT, Y+ range = +100%
    e.setJoyY(1)
    render(e, 0.01)
    expect(e.effectiveParam(P.LFO_INT)).toBe(1023)
  })
})

describe('arp key buffer hygiene', () => {
  it('keys released after leaving ARP mode do not become ghost arp keys', () => {
    const e = new Engine(SR)
    const p = initProgram()
    p.params[P.VOICE_MODE] = 0 // ARP
    e.loadProgram(p)
    e.noteOn(60, 100)
    render(e, 0.05)
    expect(e.seq.arpHeldCount()).toBe(1)
    e.setParam(P.VOICE_MODE, 3) // switch to POLY while the key is held
    e.noteOff(60) // released outside ARP mode
    expect(e.seq.arpHeldCount()).toBe(0) // buffer cleared, no stuck note
    e.setParam(P.VOICE_MODE, 0) // back to ARP with nothing held
    const buf = render(e, 0.5)
    assertFiniteBounded(buf)
    // no ghost arpeggio: fully silent by the tail
    expect(rms(buf, buf.length - Math.floor(0.1 * SR))).toBeLessThan(1e-5)
  })
})

describe('sustain pedal in mono modes', () => {
  it('UNISON: releasing a key with the damper down keeps its pitch sounding', () => {
    const prog = initProgram()
    prog.params[P.VOICE_MODE] = 2 // UNISON
    const e = new Engine(SR)
    e.loadProgram(prog)
    e.sustain(true)
    e.noteOn(60, 100)
    render(e, 0.05)
    e.noteOn(64, 100) // legato: now sounding E4
    render(e, 0.05)
    e.noteOff(64) // released while the pedal is held
    render(e, 0.05)
    const notes: number[] = []
    e.collectActiveNotes(notes)
    expect(notes).toEqual([64]) // E4 keeps sounding; no fall-back to C4
    // pedal up: the deferred release fires and falls back to the held C4
    e.sustain(false)
    render(e, 0.05)
    e.collectActiveNotes(notes)
    expect(notes).toEqual([60])
  })
})

describe('motion override lifecycle', () => {
  it('disabling a lane mid-play releases its override (knob regains control)', () => {
    const prog = initProgram()
    prog.seq.steps[0] = { on: true, notes: [60], vels: [100], gates: [54] }
    prog.seq.motion[0].paramId = P.CUTOFF
    prog.seq.motion[0].on = true
    prog.seq.motion[0].data[0] = [100, 100, 100, 100, 100]
    const e = new Engine(SR)
    e.loadProgram(prog)
    e.setParam(P.CUTOFF, 900)
    e.setPlaying(true)
    render(e, 0.05)
    expect(e.effectiveParam(P.CUTOFF)).toBe(100) // motion asserting
    prog.seq.motion[0].on = false // user turns the lane OFF in the menu
    e.setSeqData(prog.seq)
    expect(e.effectiveParam(P.CUTOFF)).toBe(900) // knob is live again
    e.setPlaying(false)
  })
})

describe('sequencer roundtrip', () => {
  it('a factory seq preset plays notes and its motion lane overrides its param', () => {
    const preset = FACTORY_PRESETS.find((p) => p.seq.steps.some((s) => s.on && s.notes.length > 0))
    expect(preset).toBeDefined()
    const lane = preset!.seq.motion.find((m) => m.on && m.paramId >= 0)
    expect(lane).toBeDefined()
    const pid = lane!.paramId

    const e = new Engine(SR)
    e.loadProgram(preset!)
    const rawKnob = e.getParam(pid)
    e.setPlaying(true)
    let sawVoices = false
    let sawMotion = false
    const buf = render(e, 2.0, () => {
      if (e.activeVoiceCount() > 0) sawVoices = true
      if (Math.abs(e.effectiveParam(pid) - rawKnob) > 1) sawMotion = true
    })
    assertFiniteBounded(buf)
    expect(rms(buf)).toBeGreaterThan(1e-4) // notes actually sounded
    expect(sawVoices).toBe(true)
    expect(sawMotion).toBe(true)

    // Stopping the transport clears motion overrides.
    e.setPlaying(false)
    expect(e.effectiveParam(pid)).toBe(rawKnob)
  })
})
