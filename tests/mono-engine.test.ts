/*
 * monologue engine tests: mono voice basics (render/decay, NaN sweep across
 * extremes), the EG hard-reset multi-trigger vs portamento single-trigger
 * (docs/monologue-spec.md §5/§14), EG TYPE VCA shapes, FAST audio-rate LFO
 * sidebands, sequencer SLIDE glide (§8), KEY TRG/HOLD transposed playback
 * (§8) and the post-VCA DRIVE saturation (§7).
 */
import { describe, expect, it } from 'vitest'
import { Engine } from '../src/synths/mono/engine'
import { initProgram } from '../src/synths/mono/program'
import { P } from '../src/synths/mono/params'
import { lfoFastHz } from '../src/synths/mono/curves'
import { initSeq, type SeqData } from '../src/shared/program'
import { renderEngine as render, rms, goertzel, SR } from './helpers/audio'

function makeEngine(): Engine {
  const e = new Engine(SR)
  e.loadProgram(initProgram())
  return e
}

/** Monophonic 1-note-per-step sequence, 100% gates, over `notes.length` steps. */
function makeSeq(notes: number[]): SeqData {
  const seq = initSeq()
  seq.stepLength = notes.length
  notes.forEach((n, i) => {
    seq.steps[i] = { on: true, notes: [n], vels: [100], gates: [72] }
  })
  return seq
}

function peak(buf: Float32Array, from = 0, to = buf.length): number {
  let m = 0
  for (let i = from; i < to; i++) {
    const a = buf[i] < 0 ? -buf[i] : buf[i]
    if (a > m) m = a
  }
  return m
}

describe('mono engine basics', () => {
  it('renders audio for a note and decays after release', () => {
    const e = makeEngine()
    e.noteOn(60, 100)
    const on = render(e, 0.3)
    expect(rms(on, SR * 0.1, SR * 0.3)).toBeGreaterThan(0.005)
    e.noteOff(60)
    render(e, 1.2)
    const tail = render(e, 0.2)
    expect(rms(tail)).toBeLessThan(0.002)
  })

  it('never emits NaN across param extremes (drive/res max, FAST LFO, noise-ring)', () => {
    const e = makeEngine()
    e.setParam(P.DRIVE, 1023)
    e.setParam(P.RESONANCE, 1023)
    e.setParam(P.CUTOFF, 1023)
    e.setParam(P.VCO2_WAVE, 0) // NOISE
    e.setParam(P.VCO2_LEVEL, 1023)
    e.setParam(P.SYNC_RING, 0) // RING x noise
    e.setParam(P.LFO_MODE, 2) // FAST
    e.setParam(P.LFO_RATE, 1023) // 2.8 kHz, true audio rate
    e.setParam(P.LFO_INT, 1023)
    e.setParam(P.EG_INT, 1023)
    e.setParam(P.EG_TARGET, 2) // PITCH (both VCOs)
    e.setParam(P.EG_DECAY, 1023)
    e.noteOn(36, 127)
    const out = render(e, 0.5)
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true)
      expect(Math.abs(out[i])).toBeLessThanOrEqual(1.01)
    }
  })
})

describe('mono retrigger rules (spec §5)', () => {
  /** Hold a note through a slow attack, then strike a second key while the
   *  first is held; returns [level before, level right after]. */
  function legatoLevels(portamento: number): [number, number] {
    const e = makeEngine()
    e.setParam(P.PORTAMENTO, portamento)
    e.setParam(P.EG_ATTACK, 800) // ~0.47 s attack
    e.noteOn(60, 100)
    render(e, 1.2) // attack fully arrived, A/G/D holds at max
    const pre = render(e, 0.05)
    e.noteOn(64, 100) // second key while 60 is still held
    const post = render(e, 0.05)
    return [rms(pre), rms(post)]
  }

  it('multi-trigger (portamento off) hard-resets the EG to ZERO: a slow attack dips to silence', () => {
    const [pre, post] = legatoLevels(0)
    expect(pre).toBeGreaterThan(0.05)
    expect(post).toBeLessThan(pre * 0.4) // "uncomfortable silence" [SoS]
  })

  it('portamento on switches to single-trigger legato: no dip on the second key', () => {
    const [pre, post] = legatoLevels(60)
    expect(post).toBeGreaterThan(pre * 0.7)
  })
})

describe('mono EG types (spec §5)', () => {
  it('GATE holds a flat level for as long as the key is held', () => {
    const e = makeEngine()
    e.setParam(P.EG_TYPE, 0) // GATE
    e.noteOn(60, 100)
    const out = render(e, 1.0)
    const early = rms(out, SR * 0.1, SR * 0.3)
    const late = rms(out, SR * 0.8, SR * 1.0)
    expect(late).toBeGreaterThan(0.01)
    expect(late).toBeGreaterThan(early * 0.8) // flat, no time-based change
  })

  it('A/D decays to silence even while the key stays held', () => {
    const e = makeEngine()
    e.setParam(P.EG_TYPE, 2) // A/D
    e.setParam(P.EG_DECAY, 300) // ~26 ms
    e.noteOn(60, 100)
    const out = render(e, 1.0)
    expect(rms(out, 0, SR * 0.05)).toBeGreaterThan(0.01) // the percussive hit
    expect(rms(out, SR * 0.8, SR * 1.0)).toBeLessThan(0.001) // silent while held
  })
})

describe('mono FAST LFO (spec §6)', () => {
  it('audio-rate pitch modulation stays finite and produces sidebands at carrier ± rate', () => {
    function sideband(intRaw: number): number {
      const e = makeEngine()
      e.setParam(P.LFO_MODE, 2) // FAST
      e.setParam(P.LFO_RATE, 700) // ~184 Hz, well clear of 440's harmonics
      e.setParam(P.LFO_INT, intRaw) // 512 = zero depth (bipolar center)
      // LFO TARGET default = PITCH (both VCOs)
      e.noteOn(69, 100) // 440 Hz
      const out = render(e, 0.5)
      for (let i = 0; i < out.length; i += 13) expect(Number.isFinite(out[i])).toBe(true)
      const fm = lfoFastHz(700)
      return goertzel(out, 440 + fm, SR * 0.1, SR * 0.5)
    }
    expect(sideband(600)).toBeGreaterThan(sideband(512) * 5)
  })
})

describe('mono sequencer SLIDE (spec §8)', () => {
  /** Two-step seq 48 -> 72; returns the block-rate hz trajectory. */
  function hzTrajectory(slide: boolean): number[] {
    const e = makeEngine()
    e.setDebug(true) // lastHz telemetry only updates with taps on
    const seq = makeSeq([48, 72])
    seq.steps[0].slide = slide // step 0 glides INTO step 1's note
    e.setSeqData(seq)
    e.setPlaying(true)
    const hz: number[] = []
    render(e, 0.25, () => hz.push(e.debugVoiceInfo(0).hz))
    return hz
  }

  it('a SLIDE-flagged step glides into the next step over the Slide Time', () => {
    // Step 1 (note 72 = ~523 Hz) starts at 0.125 s = block ~47; default
    // Slide Time 50% = 0.25 s, so ~30 ms in the pitch must still be mid-glide.
    const hz = hzTrajectory(true)
    const mid = hz[58] // ~30 ms into step 1
    const later = hz[90] // ~115 ms into step 1
    expect(mid).toBeGreaterThan(140) // left C3 (130.8 Hz)...
    expect(mid).toBeLessThan(420) // ...but nowhere near C5 yet
    expect(later).toBeGreaterThan(mid) // still rising toward the target
    expect(later).toBeLessThan(524)
  })

  it('without the SLIDE flag the next step snaps to pitch', () => {
    const hz = hzTrajectory(false)
    expect(hz[58]).toBeGreaterThan(490) // already at ~523 Hz
  })
})

describe('mono KEY TRG / HOLD (spec §8)', () => {
  it('KEY TRG starts transposed playback instead of playing the key, and stops on release', () => {
    const e = makeEngine()
    e.setSeqData(makeSeq([60, 62, 64, 65]))
    e.setParam(P.KEY_TRIG, 1) // KEY TRG
    e.setDebug(true)
    e.noteOn(65, 100) // +5 semitones vs the C4 reference (UNCONFIRMED ref)
    expect(e.stepSeq.playing).toBe(true)
    const seen = new Set<number>()
    render(e, 0.6, () => {
      const v = e.debugVoiceInfo(0)
      if (v.on) seen.add(v.note)
    })
    // The sequence steps through, transposed — never the held key alone.
    expect(seen.has(65)).toBe(true) // 60 + 5
    expect(seen.has(67)).toBe(true) // 62 + 5
    for (const n of seen) expect([65, 67, 69, 70]).toContain(n)
    e.noteOff(65) // last key up in TRIG mode: playback stops
    expect(e.stepSeq.playing).toBe(false)
    render(e, 1.0)
    expect(rms(render(e, 0.2))).toBeLessThan(0.002)
  })

  it('HOLD latches playback after release; switching Off stops it', () => {
    const e = makeEngine()
    e.setSeqData(makeSeq([60, 62, 64, 65]))
    e.setParam(P.KEY_TRIG, 2) // HOLD
    e.noteOn(72, 100)
    e.noteOff(72)
    expect(e.stepSeq.playing).toBe(true) // latched
    render(e, 0.2)
    e.setParam(P.KEY_TRIG, 0)
    expect(e.stepSeq.playing).toBe(false)
  })

  it('with an empty sequence the keyboard plays normally even with KEY TRG lit', () => {
    const e = makeEngine() // init program: empty sequence
    e.setParam(P.KEY_TRIG, 1)
    e.noteOn(60, 100)
    expect(e.stepSeq.playing).toBe(false)
    const out = render(e, 0.2)
    expect(rms(out, SR * 0.05, SR * 0.2)).toBeGreaterThan(0.005)
    e.noteOff(60)
  })
})

describe('mono DRIVE (spec §7)', () => {
  it('saturates (waveform squares up) without boosting the level', () => {
    function renderDrive(raw: number): Float32Array {
      const e = makeEngine()
      e.setParam(P.DRIVE, raw)
      e.noteOn(48, 100)
      return render(e, 0.4)
    }
    const clean = renderDrive(0)
    const hot = renderDrive(1023)
    const from = SR * 0.2
    const ffClean = rms(clean, from) / peak(clean, from)
    const ffHot = rms(hot, from) / peak(hot, from)
    // tanh compression raises the rms/peak form factor toward a square's.
    expect(ffHot).toBeGreaterThan(ffClean * 1.15)
    // "even fully cranked... nor does it excessively boost the volume" [SoS]
    expect(rms(hot, from)).toBeLessThan(rms(clean, from) * 3)
    expect(rms(hot, from)).toBeGreaterThan(rms(clean, from) * 0.3)
  })
})
