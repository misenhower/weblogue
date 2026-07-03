import { describe, expect, it } from 'vitest'
import { Engine } from '../src/synths/og/engine'
import { initProgram } from '../src/synths/og/program'
import { P } from '../src/synths/og/params'
import { renderEngine as render, rms, SR } from './helpers/audio'

function makeEngine(): Engine {
  const e = new Engine(SR)
  e.loadProgram(initProgram())
  return e
}

function soundingNotes(e: Engine): number[] {
  const out: number[] = []
  for (let i = 0; i < 4; i++) {
    const v = e.debugVoiceInfo(i)
    if (v.on) out.push(v.note)
  }
  return out.sort((a, b) => a - b)
}

describe('OG engine basics', () => {
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

  it('never emits NaN across param extremes', () => {
    const e = makeEngine()
    e.setParam(P.CUTOFF, 1023)
    e.setParam(P.RESONANCE, 1023)
    e.setParam(P.NOISE_LEVEL, 1023)
    e.setParam(P.VCO2_LEVEL, 1023)
    e.setParam(P.SYNC, 1)
    e.setParam(P.RING, 1)
    e.setParam(P.CROSS_MOD, 1023)
    e.setParam(P.FILTER_TYPE, 1)
    e.noteOn(36, 127)
    const out = render(e, 0.5)
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true)
      expect(Math.abs(out[i])).toBeLessThanOrEqual(1.01)
    }
  })

  it('FILTER TYPE 4-pole darkens the output vs 2-pole', () => {
    function energyAt(poles: 0 | 1): number {
      const e = makeEngine()
      e.setParam(P.CUTOFF, 350) // low cutoff so slope dominates
      e.setParam(P.FILTER_TYPE, poles)
      e.noteOn(84, 100) // high note: harmonics well above cutoff
      const out = render(e, 0.4)
      return rms(out, SR * 0.2, SR * 0.4)
    }
    expect(energyAt(1)).toBeLessThan(energyAt(0) * 0.8)
  })
})

describe('OG voice modes', () => {
  it('POLY allocates four voices round-robin', () => {
    const e = makeEngine()
    for (const n of [60, 64, 67, 71]) e.noteOn(n, 100)
    render(e, 0.05)
    expect(e.activeVoiceCount()).toBe(4)
    expect(soundingNotes(e)).toEqual([60, 64, 67, 71])
  })

  it('POLY invert raises the k lowest held notes an octave', () => {
    const e = makeEngine()
    e.setParam(P.VM_DEPTH, 250) // ~zone 2: invert = 2
    for (const n of [60, 64, 67]) e.noteOn(n, 100)
    render(e, 0.05)
    // two lowest (60, 64) up an octave -> 67, 72, 76
    expect(soundingNotes(e)).toEqual([67, 72, 76])
  })

  it('MONO brings in sub voices an octave and two octaves down', () => {
    const e = makeEngine()
    e.setParam(P.VOICE_MODE, 3)
    e.setParam(P.VM_DEPTH, 1023) // full: both sub stages in
    e.noteOn(60, 100)
    render(e, 0.05)
    expect(soundingNotes(e)).toEqual([36, 48, 48, 60])
  })

  it('CHORD plays the selected chord and cycles voice sets', () => {
    const e = makeEngine()
    e.setParam(P.VOICE_MODE, 4)
    e.setParam(P.VM_DEPTH, 250) // zone: 'Maj' (220-292)
    e.noteOn(60, 100)
    render(e, 0.05)
    expect(soundingNotes(e)).toEqual([60, 64, 67])
  })

  it('UNISON stacks all four voices on one note', () => {
    const e = makeEngine()
    e.setParam(P.VOICE_MODE, 2)
    e.setParam(P.VM_DEPTH, 512)
    e.noteOn(48, 100)
    render(e, 0.05)
    expect(e.activeVoiceCount()).toBe(4)
    expect(soundingNotes(e)).toEqual([48, 48, 48, 48])
  })

  it('DUO gives 2-note polyphony in pairs', () => {
    const e = makeEngine()
    e.setParam(P.VOICE_MODE, 1)
    e.setParam(P.VM_DEPTH, 800)
    e.noteOn(60, 100)
    e.noteOn(67, 100)
    render(e, 0.05)
    expect(e.activeVoiceCount()).toBe(4)
    expect(soundingNotes(e)).toEqual([60, 60, 67, 67])
  })

  it('DELAY mode fires echo voices at the depth-selected spacing', () => {
    const e = makeEngine()
    e.setParam(P.VOICE_MODE, 5)
    e.setParam(P.VM_DEPTH, 1000) // 1/4 note = 0.5 s at 120 bpm
    e.noteOn(60, 100)
    render(e, 0.1)
    expect(e.activeVoiceCount()).toBe(1) // echoes not yet due
    render(e, 0.5) // past the first echo (0.5 s)
    expect(e.activeVoiceCount()).toBe(2)
    render(e, 0.5)
    expect(e.activeVoiceCount()).toBe(3)
  })

  it('SIDE CHAIN ducks older voices when a new note strikes', () => {
    function heldLevel(depth: number): number {
      const e = makeEngine()
      e.setParam(P.VOICE_MODE, 7)
      e.setParam(P.VM_DEPTH, depth)
      e.setParam(P.AMP_SUSTAIN, 1023)
      e.noteOn(48, 100)
      render(e, 0.3)
      e.noteOn(72, 1) // near-silent strike: its own output is negligible
      const out = render(e, 0.08)
      return rms(out)
    }
    expect(heldLevel(1023)).toBeLessThan(heldLevel(0) * 0.6)
  })

  it('ARP mode arpeggiates held keys', () => {
    const e = makeEngine()
    e.setParam(P.VOICE_MODE, 6)
    e.setParam(P.VM_DEPTH, 200) // RISE 1 zone (158-236)
    e.noteOn(60, 100)
    e.noteOn(64, 100)
    e.noteOn(67, 100)
    const seen = new Set<number>()
    for (let k = 0; k < 40; k++) {
      render(e, 0.05)
      for (const n of soundingNotes(e)) seen.add(n)
    }
    expect(seen.has(60)).toBe(true)
    expect(seen.has(64)).toBe(true)
    expect(seen.has(67)).toBe(true)
  })
})

describe('OG delay block', () => {
  it('BYPASS routing leaves no tail; PRE routing echoes after release', () => {
    function tailEnergy(routing: number): number {
      const e = makeEngine()
      e.setParam(P.DELAY_ROUTING, routing)
      e.setParam(P.DELAY_TIME, 700) // long-ish delay
      e.setParam(P.DELAY_FEEDBACK, 700)
      e.setParam(P.AMP_RELEASE, 0)
      e.noteOn(60, 100)
      render(e, 0.2)
      e.noteOff(60)
      render(e, 0.3) // let the dry tail die
      const tail = render(e, 1.0)
      return rms(tail)
    }
    expect(tailEnergy(0)).toBeLessThan(0.001)
    expect(tailEnergy(1)).toBeGreaterThan(0.002)
  })

  it('POST routing thins low end vs PRE (HPF on dry+wet)', () => {
    function lowNoteLevel(routing: number): number {
      const e = makeEngine()
      e.setParam(P.DELAY_ROUTING, routing)
      e.setParam(P.DELAY_HIPASS, 1023) // HPF high up
      e.setParam(P.DELAY_TIME, 100)
      e.setParam(P.DELAY_FEEDBACK, 0)
      e.noteOn(36, 100) // low note
      const out = render(e, 0.4)
      return rms(out, SR * 0.2, SR * 0.4)
    }
    expect(lowNoteLevel(2)).toBeLessThan(lowNoteLevel(1) * 0.7)
  })
})

describe('OG modulation', () => {
  it('EG MOD = RATE accelerates the LFO with the envelope (stays finite)', () => {
    const e = makeEngine()
    e.setParam(P.LFO_EG_MOD, 1)
    e.setParam(P.LFO_RATE, 400)
    e.setParam(P.LFO_INT, 700)
    e.setParam(P.LFO_TARGET, 2) // pitch
    e.setParam(P.EG_ATTACK, 300)
    e.setParam(P.EG_SUSTAIN, 1023)
    e.noteOn(60, 100)
    const out = render(e, 0.6)
    for (let i = 0; i < out.length; i += 7) expect(Number.isFinite(out[i])).toBe(true)
    expect(rms(out, SR * 0.3, SR * 0.6)).toBeGreaterThan(0.005)
  })

  it('PITCH EG INT sweeps VCO2 only (audible beating vs static)', () => {
    function spectralMotion(egInt: number): number {
      const e = makeEngine()
      e.setParam(P.VCO2_LEVEL, 1023)
      e.setParam(P.PITCH_EG_INT, egInt)
      e.setParam(P.EG_ATTACK, 0)
      e.setParam(P.EG_DECAY, 600)
      e.setParam(P.EG_SUSTAIN, 0)
      e.noteOn(60, 100)
      const out = render(e, 0.5)
      // motion proxy: variance of short-window RMS across the render
      const w = 2400
      let mean = 0
      const levels: number[] = []
      for (let i = 0; i + w <= out.length; i += w) {
        const v = rms(out, i, i + w)
        levels.push(v)
        mean += v
      }
      mean /= levels.length
      let varAcc = 0
      for (const v of levels) varAcc += (v - mean) * (v - mean)
      return varAcc / levels.length
    }
    expect(spectralMotion(900)).toBeGreaterThan(spectralMotion(512) * 1.5)
  })
})

describe('OG LFO rate + voice sync', () => {
  /** Max |lfo(v0) - lfo(v1)| sampled at block boundaries over `seconds`. */
  function maxLfoDiff(e: Engine, seconds: number): number {
    let worst = 0
    const l = new Float32Array(128)
    const r = new Float32Array(128)
    const blocks = Math.floor((seconds * SR) / 128)
    for (let b = 0; b < blocks; b++) {
      e.process(l, r, 128)
      const d = Math.abs(e.debugVoiceInfo(0).lfo - e.debugVoiceInfo(1).lfo)
      if (d > worst) worst = d
    }
    return worst
  }

  it('RATE knob changes reach idle voices immediately (phases stay locked)', () => {
    // Regression: setLfoFreq used to defer to tick(), so idle voices kept the
    // old rate until their next note and voice phases scattered permanently.
    const e = makeEngine()
    e.setDebug(true)
    render(e, 0.2) // all idle, free-running in phase at the default rate
    e.setParam(P.LFO_RATE, 950) // big rate jump while idle
    e.noteOn(60, 100) // voice 0 becomes active; voices 1-3 stay idle
    const worst = maxLfoDiff(e, 0.6)
    expect(worst).toBeLessThan(0.05) // same rate + same phase on all voices
  })

  it('LFO Voice Sync holds a chord together under per-voice EG-MOD=RATE', () => {
    function run(sync: 0 | 1): number {
      const e = makeEngine()
      e.setDebug(true)
      e.setParam(P.LFO_VOICE_SYNC, sync)
      e.setParam(P.LFO_EG_MOD, 1) // RATE: each voice's EG sweeps its own LFO
      e.setParam(P.EG_ATTACK, 0)
      e.setParam(P.EG_SUSTAIN, 1023) // hold the sweep at full
      e.noteOn(60, 100)
      render(e, 0.3) // voice 0 sweeps fast; the others free-run at base rate
      e.noteOn(64, 100) // voice 1 starts from a wildly different phase...
      return maxLfoDiff(e, 0.4)
    }
    expect(run(1)).toBeLessThan(0.2) // ...but voice sync re-shares the phase
    expect(run(0)).toBeGreaterThan(0.3) // independent LFOs keep their offset
  })
})
