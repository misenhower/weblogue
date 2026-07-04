/*
 * prologue engine tests: 16-voice render/decay + NaN safety, the bitimbral
 * dispatch (LAYER/SPLIT/XFADE/BALANCE + per-timbre voice modes over the
 * shared pool), the exclusive DELAY-or-REVERB block + MOD FX routing over
 * the timbre buses, the program-global arpeggiator (ON/LATCH), the
 * replica-only VOICE CAP, and the per-timbre mod-wheel offset layers.
 */
import { describe, expect, it } from 'vitest'
import { Engine } from '../src/synths/prologue/engine'
import { initProgram } from '../src/synths/prologue/program'
import { P, RP, TIMBRE_BLOCKS } from '../src/synths/prologue/params'
import { renderEngine as render, rms, SR } from './helpers/audio'

const [T1, T2] = TIMBRE_BLOCKS
const NV = 16

function makeEngine(): Engine {
  const e = new Engine(SR, 16)
  e.loadProgram(initProgram())
  return e
}

function soundingNotes(e: Engine): number[] {
  const out: number[] = []
  for (let i = 0; i < NV; i++) {
    const v = e.debugVoiceInfo(i)
    if (v.on) out.push(v.note)
  }
  return out.sort((a, b) => a - b)
}

/** Timbre tags of the currently sounding voices, sorted. */
function soundingTimbres(e: Engine): number[] {
  const out: number[] = []
  for (let i = 0; i < NV; i++) {
    if (e.debugVoiceInfo(i).on) out.push(e.timbreOf(i))
  }
  return out.sort((a, b) => a - b)
}

describe('prologue engine basics', () => {
  it('renders audio for a note and decays after release', () => {
    const e = makeEngine()
    e.noteOn(60, 100)
    const on = render(e, 0.3)
    expect(rms(on, SR * 0.1, SR * 0.3)).toBeGreaterThan(0.003)
    e.noteOff(60)
    render(e, 1.2)
    const tail = render(e, 0.2)
    expect(rms(tail)).toBeLessThan(0.002)
  })

  it('POLY allocates all 16 voices round-robin and steals past the pool', () => {
    const e = makeEngine()
    for (let n = 48; n < 64; n++) e.noteOn(n, 100)
    render(e, 0.05)
    expect(e.activeVoiceCount()).toBe(16)
    e.noteOn(70, 100) // 17th note: steal-oldest, count stays at the pool
    render(e, 0.05)
    expect(e.activeVoiceCount()).toBe(16)
    expect(soundingNotes(e)).toContain(70)
  })

  it('never emits NaN across param extremes (both timbres driven hard)', () => {
    const e = makeEngine()
    e.setParam(P.SUB_ON, 1)
    for (const T of [T1, T2]) {
      e.setParam(T.cutoff, 0)
      e.setParam(T.resonance, 1023)
      e.setParam(T.syncRing, 0) // RING
      e.setParam(T.crossMod, 1023)
      e.setParam(T.vco2Level, 1023)
      e.setParam(T.multiLevel, 1023)
      e.setParam(T.drive, 2)
      e.setParam(T.lowCut, 1)
      e.setParam(T.lfoMode, 2) // FAST (audio rate)
      e.setParam(T.lfoRate, 1023)
      e.setParam(T.lfoInt, 1023)
      e.setParam(T.lfoTarget, 2) // pitch
      e.setParam(T.pitchEgTarget, 2) // ALL
      e.setParam(T.pitchEgInt, 1023)
      e.setParam(T.egSustain, 1023)
    }
    e.setParam(P.MODFX_ON, 1)
    e.setParam(P.MODFX_DEPTH, 1023)
    e.setParam(P.DLRV_SELECT, 1)
    e.setParam(RP.LF_COMP_ON, 1)
    e.setParam(RP.LF_COMP_GAIN, 1023)
    e.noteOn(36, 127)
    e.noteOn(84, 127)
    const out = render(e, 0.5)
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true)
      expect(Math.abs(out[i])).toBeLessThanOrEqual(1.01)
    }
  })
})

describe('prologue bitimbral dispatch', () => {
  it('LAYER starts one voice per timbre for every key', () => {
    const e = makeEngine()
    e.setParam(P.SUB_ON, 1) // TIMBRE TYPE default = LAYER
    e.noteOn(60, 100)
    render(e, 0.05)
    expect(e.activeVoiceCount()).toBe(2)
    expect(soundingTimbres(e)).toEqual([0, 1])
    e.noteOn(64, 100)
    render(e, 0.05)
    expect(e.activeVoiceCount()).toBe(4)
    expect(soundingTimbres(e)).toEqual([0, 0, 1, 1])
  })

  it('SPLIT routes by key against SPLIT POINT; POSITION swaps sides', () => {
    const e = makeEngine()
    e.setParam(P.SUB_ON, 1)
    e.setParam(P.TIMBRE_TYPE, 2) // SPLIT
    e.setParam(P.SPLIT_POINT, 60)
    e.noteOn(48, 100) // below the split: SUB side (POSITION 0 = Sub<>Main)
    render(e, 0.02)
    expect(e.activeVoiceCount()).toBe(1)
    expect(soundingTimbres(e)).toEqual([1])
    e.noteOn(72, 100) // at/above the split: MAIN side
    render(e, 0.02)
    expect(soundingTimbres(e)).toEqual([0, 1])
    e.noteOff(48)
    e.noteOff(72)
    render(e, 0.3)
    e.setParam(P.POSITION, 1) // Main<>Sub: sides swap
    e.noteOn(48, 100)
    render(e, 0.02)
    expect(soundingTimbres(e)).toEqual([0])
  })

  it('XFADE weights shift with key position (main-heavy vs sub-heavy)', () => {
    // Sub timbre muted (its levels 0): only the MAIN weight is audible.
    // The same high key is main-heavy under POSITION 0 and sub-heavy under
    // POSITION 1, so its level must drop when POSITION flips.
    function level(position: 0 | 1): number {
      const e = makeEngine()
      e.setParam(P.SUB_ON, 1)
      e.setParam(P.TIMBRE_TYPE, 1) // XFADE
      e.setParam(P.POSITION, position)
      e.setParam(T2.vco1Level, 0) // sub silent
      e.noteOn(96, 100)
      const out = render(e, 0.3)
      return rms(out, SR * 0.1, SR * 0.3)
    }
    expect(level(0)).toBeGreaterThan(level(1) * 2)
  })

  it('BALANCE scales the timbre gains globally (extremes mute a side)', () => {
    // Sub muted at the source: BALANCE 127 = full MAIN (loud), BALANCE 0 =
    // full SUB (near-silent since the sub makes no sound).
    function level(balance: number): number {
      const e = makeEngine()
      e.setParam(P.SUB_ON, 1) // LAYER
      e.setParam(T2.vco1Level, 0)
      e.setParam(P.BALANCE, balance)
      e.noteOn(60, 100)
      const out = render(e, 0.3)
      return rms(out, SR * 0.1, SR * 0.3)
    }
    expect(level(127)).toBeGreaterThan(0.003)
    expect(level(0)).toBeLessThan(level(127) * 0.05)
  })

  it('per-timbre modes coexist: main POLY + sub UNISON over the shared pool', () => {
    const e = makeEngine()
    e.setParam(P.SUB_ON, 1) // LAYER; each timbre gets 8 of the 16 voices
    e.setParam(T2.voiceMode, 2) // sub UNISON: all 8 of its voices
    e.noteOn(60, 100)
    render(e, 0.05)
    expect(e.activeVoiceCount()).toBe(1 + 8)
    const timbres = soundingTimbres(e)
    expect(timbres.filter((t) => t === 0).length).toBe(1)
    expect(timbres.filter((t) => t === 1).length).toBe(8)
    e.noteOn(64, 100) // main adds a poly voice; sub re-strikes its stack
    render(e, 0.05)
    expect(e.activeVoiceCount()).toBe(2 + 8)
  })

  it('MONO mode brings in the OG sub-voice stack within the timbre', () => {
    const e = makeEngine()
    e.setParam(T1.voiceMode, 1) // MONO (sub timbre off)
    e.setParam(T1.vmDepth, 1023) // both sub stages fully in
    e.noteOn(60, 100)
    render(e, 0.05)
    expect(soundingNotes(e)).toEqual([36, 48, 48, 60])
  })

  it('CHORD mode plays the family chord table per timbre', () => {
    const e = makeEngine()
    e.setParam(T1.voiceMode, 3) // CHORD
    e.setParam(T1.vmDepth, 250) // 'Maj' zone (220..292)
    e.noteOn(60, 100)
    render(e, 0.05)
    expect(soundingNotes(e)).toEqual([60, 64, 67])
  })

  it('DUO zone of POLY stacks two voices per key', () => {
    const e = makeEngine()
    e.setParam(T1.vmDepth, 800) // POLY depth past 256 = DUO
    e.noteOn(60, 100)
    render(e, 0.05)
    expect(e.activeVoiceCount()).toBe(2)
    expect(soundingNotes(e)).toEqual([60, 60])
  })
})

describe('prologue FX block', () => {
  /** Tail energy after the dry note has died (release is ~5 ms here). */
  function tailEnergy(select: number): number {
    const e = makeEngine()
    e.setParam(P.DLRV_SELECT, select)
    e.setParam(P.DLRV_TIME, 700)
    e.setParam(P.DLRV_DEPTH, 800)
    e.noteOn(60, 100)
    render(e, 0.2)
    e.noteOff(60)
    render(e, 0.3) // let the dry tail die
    const tail = render(e, 1.0)
    return rms(tail)
  }

  it('DELAY and REVERB are exclusive: each leaves a tail, OFF leaves none', () => {
    const off = tailEnergy(0)
    expect(off).toBeLessThan(0.001)
    expect(tailEnergy(1)).toBeGreaterThan(Math.max(0.002, off * 5)) // DELAY
    expect(tailEnergy(2)).toBeGreaterThan(Math.max(0.002, off * 5)) // REVERB
  })

  it('MOD FX routing MAIN leaves the sub bus dry', () => {
    // SPLIT routes the played key to the SUB side only, so the MAIN bus is
    // exactly silent. With the chorus routed MAIN it must not touch the
    // audible signal at all (bit-identical to MOD FX off); routed MAIN+SUB
    // it must.
    function run(modFxOn: 0 | 1, routing: number): Float32Array {
      const e = makeEngine()
      e.setParam(P.SUB_ON, 1)
      e.setParam(P.TIMBRE_TYPE, 2) // SPLIT (POSITION 0: low side = SUB)
      e.setParam(P.SPLIT_POINT, 60)
      e.setParam(P.MODFX_ON, modFxOn)
      e.setParam(P.MODFX_DEPTH, 1023)
      e.setParam(P.MODFX_ROUTING, routing)
      e.noteOn(48, 100) // below the split: sub timbre only
      return render(e, 0.4)
    }
    const dry = run(0, 0)
    const mainOnly = run(1, 1)
    const both = run(1, 0)
    let dMain = 0
    let dBoth = 0
    for (let i = 0; i < dry.length; i++) {
      dMain += (mainOnly[i] - dry[i]) * (mainOnly[i] - dry[i])
      dBoth += (both[i] - dry[i]) * (both[i] - dry[i])
    }
    dMain = Math.sqrt(dMain / dry.length)
    dBoth = Math.sqrt(dBoth / dry.length)
    expect(dMain).toBeLessThan(1e-8) // excluded bus routed around the fx
    expect(dBoth).toBeGreaterThan(1e-4) // included bus audibly processed
  })
})

describe('prologue arpeggiator (program-global)', () => {
  it('ON routes held keys to the arp and cycles them', () => {
    const e = makeEngine()
    e.setParam(P.ARP_ON_LATCH, 1)
    e.noteOn(60, 100)
    e.noteOn(64, 100)
    e.noteOn(67, 100)
    const seen = new Set<number>()
    for (let k = 0; k < 24; k++) {
      render(e, 0.05)
      for (const n of soundingNotes(e)) seen.add(n)
    }
    expect(seen.has(60)).toBe(true)
    expect(seen.has(64)).toBe(true)
    expect(seen.has(67)).toBe(true)
    // Releasing every key stops the arp (no latch).
    e.noteOff(60)
    e.noteOff(64)
    e.noteOff(67)
    render(e, 0.4)
    expect(e.activeVoiceCount()).toBe(0)
  })

  it('LATCH keeps firing after the keys are released', () => {
    const e = makeEngine()
    e.setParam(P.ARP_ON_LATCH, 2)
    e.noteOn(60, 100)
    e.noteOff(60)
    let maxActive = 0
    for (let k = 0; k < 12; k++) {
      render(e, 0.05)
      maxActive = Math.max(maxActive, e.activeVoiceCount())
    }
    expect(maxActive).toBeGreaterThan(0)
  })

  it('ARP TARGET routes fired notes to the selected timbre', () => {
    const e = makeEngine()
    e.setParam(P.SUB_ON, 1) // LAYER: live keys would hit both timbres
    e.setParam(P.ARP_ON_LATCH, 1)
    e.setParam(P.ARP_TARGET, 2) // Sub only
    e.noteOn(60, 100)
    let sawMain = false
    let sawSub = false
    for (let k = 0; k < 12; k++) {
      render(e, 0.05)
      for (const t of soundingTimbres(e)) {
        if (t === 0) sawMain = true
        else sawSub = true
      }
    }
    expect(sawSub).toBe(true)
    expect(sawMain).toBe(false)
  })
})

describe('prologue voice cap (replica-only)', () => {
  it('VOICE CAP 8 bounds allocation (the prologue-8 variant)', () => {
    const e = makeEngine()
    e.setParam(RP.VOICE_CAP, 8)
    for (let n = 48; n < 60; n++) e.noteOn(n, 100) // 12 keys
    render(e, 0.05)
    expect(e.activeVoiceCount()).toBeLessThanOrEqual(8)
    expect(e.activeVoiceCount()).toBeGreaterThan(0)
  })

  it('lowering the cap releases voices stranded above it', () => {
    const e = makeEngine()
    for (let n = 48; n < 64; n++) e.noteOn(n, 100)
    render(e, 0.05)
    expect(e.activeVoiceCount()).toBe(16)
    e.setParam(RP.VOICE_CAP, 4)
    render(e, 0.5) // released tails die (~5 ms release)
    expect(e.activeVoiceCount()).toBeLessThanOrEqual(4)
  })
})

describe('prologue mod wheel (per-timbre offset layers)', () => {
  it('one deflection moves each timbre\'s OWN assigned destination', () => {
    const e = makeEngine()
    e.setParam(T1.cutoff, 300)
    e.setParam(T2.cutoff, 300)
    e.setParam(T1.wheelAssign, 14) // CUTOFF
    e.setParam(T1.wheelRange, 200) // +100%
    e.setParam(T2.wheelAssign, 15) // RESONANCE
    e.setParam(T2.wheelRange, 200)
    e.setJoyY(1)
    render(e, 0.05) // layers resolve at block rate
    // T1's wheel raises ITS cutoff; T2's cutoff is untouched (its wheel
    // drives resonance instead).
    expect(e.effectiveParam(T1.cutoff)).toBeGreaterThan(1000)
    expect(e.effectiveParam(T2.cutoff)).toBe(300)
    expect(e.effectiveParam(T2.resonance)).toBeGreaterThan(1000)
    expect(e.effectiveParam(T1.resonance)).toBe(0)
    // Wheel back to zero: offsets clear.
    e.setJoyY(0)
    render(e, 0.05)
    expect(e.effectiveParam(T1.cutoff)).toBe(300)
    expect(e.effectiveParam(T2.resonance)).toBe(0)
  })

  it('the wheel offset is audible on the assigned timbre', () => {
    function level(wheel: number): number {
      const e = makeEngine()
      e.setParam(T1.cutoff, 120) // nearly closed
      e.setParam(T1.wheelAssign, 14) // CUTOFF, +100%
      e.setParam(T1.wheelRange, 200)
      e.setJoyY(wheel)
      e.noteOn(48, 100)
      const out = render(e, 0.3)
      return rms(out, SR * 0.1, SR * 0.3)
    }
    expect(level(1)).toBeGreaterThan(level(0) * 1.5)
  })
})
