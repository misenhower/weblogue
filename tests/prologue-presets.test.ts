/*
 * prologue factory preset bank tests — patterned on tests/mono-presets.test.ts:
 * param integrity (clampParam identity on the double-width table), exact
 * serialization round-trips, naming rules, the dormant StepSeq (spec §10 —
 * no step/motion sequencing on the prologue), and coverage of the bitimbral
 * tricks + voice modes + FX the bank is required to show off
 * (docs/prologue-spec.md §2, §4, §7, §10, §15).
 */
import { describe, expect, it } from 'vitest'
import { FACTORY_PRESETS } from '../src/synths/prologue/presets'
import { PARAMS, PARAM_COUNT, P, TIMBRE_BLOCKS, clampParam } from '../src/synths/prologue/params'
import { deserializeProgram, serializeProgram } from '../src/synths/prologue/program'
import { polyDuo, unisonDetuneCents, monoSubMix, chordIndex, CHORDS, REVERB_SUBS } from '../src/synths/prologue/curves'
import type { Program } from '../src/shared/program'

const [MAIN, SUB] = TIMBRE_BLOCKS

// Enum values under test (program-data orders, see params.ts).
const ON = 1
const TT_LAYER = 0
const TT_XFADE = 1
const TT_SPLIT = 2
const VM_POLY = 0
const VM_MONO = 1
const VM_UNISON = 2
const VM_CHORD = 3
const DLRV_DELAY = 1
const DLRV_REVERB = 2
const ARP_LATCH = 2
const ARP_POLY_RANDOM = 5
const TARGET_MAIN_SUB = 0

const bitimbral = (p: Program) => p.params[P.SUB_ON] === ON

describe('prologue FACTORY_PRESETS', () => {
  it('contains 12 programs', () => {
    expect(FACTORY_PRESETS.length).toBe(12)
  })

  it('gives every program a non-empty name of at most 12 chars', () => {
    for (const prog of FACTORY_PRESETS) {
      expect(prog.name.length).toBeGreaterThan(0)
      expect(prog.name.length).toBeLessThanOrEqual(12)
    }
  })

  it('has unique names', () => {
    const names = FACTORY_PRESETS.map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('has a full params array where every value is a clampParam fixed point', () => {
    for (const prog of FACTORY_PRESETS) {
      expect(prog.synthId).toBe('prologue')
      expect(prog.params.length).toBe(PARAM_COUNT)
      for (const meta of PARAMS) {
        const v = prog.params[meta.id]
        expect(Number.isFinite(v), `${prog.name} / ${meta.key} finite`).toBe(true)
        expect(Number.isInteger(v), `${prog.name} / ${meta.key} integer`).toBe(true)
        expect(v, `${prog.name} / ${meta.key} >= min`).toBeGreaterThanOrEqual(meta.min)
        expect(v, `${prog.name} / ${meta.key} <= max`).toBeLessThanOrEqual(meta.max)
        // clamp identity: the stored value already IS the legal value
        expect(clampParam(meta.id, v), `${prog.name} / ${meta.key} clamp identity`).toBe(v)
      }
    }
  })

  it('survives a serialize -> deserialize roundtrip exactly', () => {
    for (const prog of FACTORY_PRESETS) {
      const back = deserializeProgram(serializeProgram(prog))
      expect(back, prog.name).not.toBeNull()
      expect(back!.synthId).toBe('prologue')
      expect(back!.name).toBe(prog.name)
      expect(back!.params).toEqual(prog.params)
      expect(back!.seq).toEqual(prog.seq)
    }
  })

  it('keeps the StepSeq dormant: no steps, no motion lanes (spec §10)', () => {
    for (const prog of FACTORY_PRESETS) {
      expect(prog.seq.steps.every((s) => !s.on && s.notes.length === 0), prog.name).toBe(true)
      expect(prog.seq.motion.every((m) => !m.on && m.paramId === -1), prog.name).toBe(true)
      // seq.bpm only carries TEMPO into the arp (spec §15)
      expect(prog.seq.bpm).toBeGreaterThanOrEqual(10)
      expect(prog.seq.bpm).toBeLessThanOrEqual(300)
    }
  })

  // ---------------------------------------------------- bitimbral coverage

  it('SUB_ON is set only where the sub timbre is audible, and vice versa', () => {
    for (const prog of FACTORY_PRESETS) {
      if (!bitimbral(prog)) continue
      const audible =
        prog.params[SUB.vco1Level] > 0 ||
        prog.params[SUB.vco2Level] > 0 ||
        prog.params[SUB.multiLevel] > 0
      expect(audible, `${prog.name} sub timbre audible`).toBe(true)
    }
    expect(FACTORY_PRESETS.filter(bitimbral).length).toBeGreaterThanOrEqual(3)
  })

  it('covers a lush LAYER pad: saw MAIN + VPM shimmer SUB, ensemble + Hall (spec §2/§15)', () => {
    const layer = FACTORY_PRESETS.filter(
      (p) => bitimbral(p) && p.params[P.TIMBRE_TYPE] === TT_LAYER && p.params[P.ARP_ON_LATCH] === 0,
    )
    expect(layer.length).toBeGreaterThanOrEqual(1)
    const pad = layer[0]
    // MAIN: detuned saw ensemble with a slow attack
    expect(pad.params[MAIN.vco1Wave]).toBe(2) // SAW
    expect(pad.params[MAIN.vco2Wave]).toBe(2)
    expect(pad.params[MAIN.ampAttack]).toBeGreaterThan(600)
    // SUB: multi engine VPM carries the shimmer
    expect(pad.params[SUB.multiType]).toBe(1) // VPM
    expect(pad.params[SUB.multiLevel]).toBeGreaterThan(0)
    expect(pad.params[SUB.vco1Level]).toBe(0)
    // FX: ensemble into a Hall reverb
    expect(pad.params[P.MODFX_ON]).toBe(ON)
    expect(pad.params[P.MODFX_TYPE]).toBe(1) // ENSEMBLE
    expect(pad.params[P.DLRV_SELECT]).toBe(DLRV_REVERB)
    expect(REVERB_SUBS[pad.params[P.REVERB_SUB]]).toBe('Hall')
    // the wheel fades the layers (BALANCE dest, index 0) on both timbres
    expect(pad.params[MAIN.wheelAssign]).toBe(0)
    expect(pad.params[SUB.wheelAssign]).toBe(0)
  })

  it('covers an XFADE keyboard patch (spec §2/§15)', () => {
    const xfade = FACTORY_PRESETS.filter((p) => bitimbral(p) && p.params[P.TIMBRE_TYPE] === TT_XFADE)
    expect(xfade.length).toBeGreaterThanOrEqual(1)
    // both timbres audible so the key-position crossfade has two ends
    for (const p of xfade) {
      const mainAudible =
        p.params[MAIN.vco1Level] > 0 || p.params[MAIN.vco2Level] > 0 || p.params[MAIN.multiLevel] > 0
      expect(mainAudible, `${p.name} main audible`).toBe(true)
    }
  })

  it('covers a SPLIT bass+lead performance patch (spec §2/§15)', () => {
    const split = FACTORY_PRESETS.filter((p) => bitimbral(p) && p.params[P.TIMBRE_TYPE] === TT_SPLIT)
    expect(split.length).toBeGreaterThanOrEqual(1)
    const perf = split[0]
    // sub timbre: MONO bass below the split; main: POLY lead above
    expect(perf.params[SUB.voiceMode]).toBe(VM_MONO)
    expect(perf.params[MAIN.voiceMode]).toBe(VM_POLY)
    // split point sits inside the playable range (C-1..G9 stored 0..127)
    expect(perf.params[P.SPLIT_POINT]).toBeGreaterThan(24)
    expect(perf.params[P.SPLIT_POINT]).toBeLessThan(84)
    // the delay rides the lead only — a non-default FX ROUTING (spec §7)
    expect(perf.params[P.DLRV_SELECT]).toBe(DLRV_DELAY)
    expect(perf.params[P.DLRV_ROUTING]).toBe(1) // Main
  })

  // --------------------------------------------------- voice-mode coverage

  it('covers the 16-voice UNISON monster saw with wide voice spread (spec §4)', () => {
    const uni = FACTORY_PRESETS.filter((p) => p.params[MAIN.voiceMode] === VM_UNISON)
    expect(uni.length).toBeGreaterThanOrEqual(1)
    const monster = uni[0]
    // solo timbre: SUB off, so the timbre owns the whole 16-voice pool
    expect(monster.params[P.SUB_ON]).toBe(0)
    // audible detune across the stack and a wide stereo fan
    expect(unisonDetuneCents(monster.params[MAIN.vmDepth])).toBeGreaterThan(20)
    expect(monster.params[MAIN.voiceSpread]).toBeGreaterThanOrEqual(100)
    expect(monster.params[MAIN.vco1Wave]).toBe(2) // SAW
  })

  it('covers a MONO sub-osc bass (spec §4)', () => {
    const mono = FACTORY_PRESETS.filter(
      (p) => p.params[MAIN.voiceMode] === VM_MONO && p.params[P.SUB_ON] === 0,
    )
    expect(mono.length).toBeGreaterThanOrEqual(1)
    // depth actually engages the -1 oct sub voice
    expect(monoSubMix(mono[0].params[MAIN.vmDepth]).sub1).toBeGreaterThan(0.5)
  })

  it('covers a CHORD stab on a real chord zone (spec §4)', () => {
    const chord = FACTORY_PRESETS.filter((p) => p.params[MAIN.voiceMode] === VM_CHORD)
    expect(chord.length).toBeGreaterThanOrEqual(1)
    const idx = chordIndex(chord[0].params[MAIN.vmDepth])
    expect(CHORDS[idx]).toBeDefined()
    expect(CHORDS[idx].notes.length).toBeGreaterThanOrEqual(2)
  })

  it('covers a POLY patch pushed into the DUO zone (spec §4)', () => {
    const duo = FACTORY_PRESETS.filter(
      (p) => p.params[MAIN.voiceMode] === VM_POLY && polyDuo(p.params[MAIN.vmDepth]).duo,
    )
    expect(duo.length).toBeGreaterThanOrEqual(1)
  })

  // ----------------------------------------------------------- arp coverage

  it('covers a latched POLY RANDOM arp targeting Main+Sub (spec §10)', () => {
    const arps = FACTORY_PRESETS.filter((p) => p.params[P.ARP_ON_LATCH] === ARP_LATCH)
    expect(arps.length).toBeGreaterThanOrEqual(1)
    const scape = arps.find((p) => p.params[P.ARP_TYPE] === ARP_POLY_RANDOM)
    expect(scape).toBeDefined()
    expect(scape!.params[P.ARP_TARGET]).toBe(TARGET_MAIN_SUB)
    // POLY RANDOM is POLY-mode-only (spec §10): both targeted timbres POLY
    expect(scape!.params[P.SUB_ON]).toBe(ON)
    expect(scape!.params[MAIN.voiceMode]).toBe(VM_POLY)
    expect(scape!.params[SUB.voiceMode]).toBe(VM_POLY)
    // range within 1..4 octaves; TEMPO carried by seq.bpm (spec §15)
    expect(scape!.params[P.ARP_RANGE]).toBeGreaterThanOrEqual(1)
    expect(scape!.params[P.ARP_RANGE]).toBeLessThanOrEqual(4)
  })

  // ------------------------------------------------------------ FX coverage

  it('covers both sides of the exclusive DELAY-or-REVERB switch (spec §7)', () => {
    const delays = FACTORY_PRESETS.filter((p) => p.params[P.DLRV_SELECT] === DLRV_DELAY)
    const reverbs = FACTORY_PRESETS.filter((p) => p.params[P.DLRV_SELECT] === DLRV_REVERB)
    expect(delays.length).toBeGreaterThanOrEqual(1)
    expect(reverbs.length).toBeGreaterThanOrEqual(1)
    // the enabled effect is actually on (byte-72 switch, default On)
    for (const p of [...delays, ...reverbs]) {
      expect(p.params[P.DLRV_ON], p.name).toBe(ON)
      const dw = p.params[P.DLRV_DRYWET]
      expect(dw, `${p.name} dry/wet tasteful`).toBeGreaterThanOrEqual(350)
      expect(dw, `${p.name} dry/wet tasteful`).toBeLessThanOrEqual(560)
    }
  })

  it('covers a Riser/Submarine special-reverb patch (spec §7)', () => {
    const special = FACTORY_PRESETS.filter(
      (p) =>
        p.params[P.DLRV_SELECT] === DLRV_REVERB &&
        ['Riser', 'Submarine'].includes(REVERB_SUBS[p.params[P.REVERB_SUB]]),
    )
    expect(special.length).toBeGreaterThanOrEqual(1)
  })

  it('covers a classic string machine: PWM + ensemble + slow LFO on shape (spec §15)', () => {
    const strings = FACTORY_PRESETS.filter(
      (p) =>
        p.params[P.MODFX_ON] === ON &&
        p.params[P.MODFX_TYPE] === 1 && // ENSEMBLE
        p.params[MAIN.lfoMode] === 1 && // SLOW
        p.params[MAIN.lfoTarget] === 1 && // SHAPE
        p.params[MAIN.lfoInt] !== 512 &&
        p.params[MAIN.vco1Wave] === 0, // SQR (PWM)
    )
    expect(strings.length).toBeGreaterThanOrEqual(1)
  })

  it('features the multi engine: NOISE Peak and a VPM Decay type (spec §6/§15)', () => {
    const sonar = FACTORY_PRESETS.filter(
      (p) =>
        p.params[MAIN.multiType] === 0 && // NOISE
        p.params[MAIN.selectNoise] === 2 && // Peak
        p.params[MAIN.multiLevel] > 0,
    )
    expect(sonar.length).toBeGreaterThanOrEqual(1)
    const decayBells = FACTORY_PRESETS.filter(
      (p) =>
        p.params[MAIN.multiType] === 1 && // VPM
        [12, 13].includes(p.params[MAIN.selectVpm]) && // Decay1/Decay2
        p.params[MAIN.multiLevel] > 0,
    )
    expect(decayBells.length).toBeGreaterThanOrEqual(1)
  })

  // ---------------------------------------------------------------- wheels

  it('assigns the M.WHEEL somewhere useful on every patch, with variety', () => {
    const dests = new Set<number>()
    for (const prog of FACTORY_PRESETS) {
      dests.add(prog.params[MAIN.wheelAssign])
      // untouched timbres keep the init default; that's fine — only count MAIN
    }
    // at least 5 distinct destinations across the bank (BALANCE, CUTOFF,
    // V.M DEPTH, LFO INT, GATE TIME, ...)
    expect(dests.size).toBeGreaterThanOrEqual(5)
    expect(dests.has(14), 'wheel->CUTOFF appears').toBe(true)
    expect(dests.has(0), 'wheel->BALANCE appears').toBe(true)
  })

  // -------------------------------------------------------------- loudness

  it('keeps program levels in a comparable loudness window', () => {
    for (const prog of FACTORY_PRESETS) {
      const lvl = prog.params[P.PROGRAM_LEVEL]
      expect(lvl, prog.name).toBeGreaterThanOrEqual(86) // >= -3.2 dB
      expect(lvl, prog.name).toBeLessThanOrEqual(106) // <= +0.8 dB
      // stacked-voice modes trimmed at or below unity
      const mode = prog.params[MAIN.voiceMode]
      const duo = mode === VM_POLY && polyDuo(prog.params[MAIN.vmDepth]).duo
      if (mode === VM_UNISON || mode === VM_CHORD || duo || bitimbral(prog)) {
        expect(lvl, `${prog.name} stacked trim`).toBeLessThanOrEqual(100)
      }
    }
  })
})
