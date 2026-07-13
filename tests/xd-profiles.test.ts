/*
 * Versioned calibration profiles (src/synths/xd/profiles.ts): v0 must
 * reproduce the original guessed curves bit-for-bit (the whole point of the
 * snapshot), v1 must pass through its measured knots, the display pitch
 * table must NEVER follow the profile, and a live profile switch must reach
 * the engine's rendered audio.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { expMap } from '../src/shared/maps'
import {
  XD_PROFILES,
  XD_DEFAULT_PROFILE,
  profileChangedFields,
  setXdProfile,
  activeXdProfile,
  curveAt,
} from '../src/synths/xd/profiles'
import {
  pitchToCents,
  vcoPitchCents,
  attackToSec,
  decayToSec,
  releaseToSec,
  cutoffToHz,
  lfoRateToHz,
} from '../src/synths/xd/curves'
import { Engine } from '../src/synths/xd/engine'
import { initProgram } from '../src/synths/xd/program'
import { P } from '../src/synths/xd/params'
import { Vco, VCO_WAVE } from '../src/dsp/osc'
import { renderEngine, rms, SR } from './helpers/audio'

// Module state is per test file (own worker): always restore the default.
afterEach(() => {
  setXdProfile(XD_DEFAULT_PROFILE)
})

const RAWS = [0, 1, 64, 200, 356, 511.5, 512, 700, 938, 1023]

describe('the shipped default', () => {
  it('is v3 (v2 promoted 2026-07-10 after the listening A/B; v3 = v2 + cutoff table)', () => {
    expect(XD_DEFAULT_PROFILE).toBe('v3')
    expect(activeXdProfile().id).toBe('v3')
  })

  it('only the R1-produced v1 declares a procedure; dev-era profiles stay untagged', () => {
    // v0/v2/v3/v4 were measured while the rig/extractor were moving targets
    // and predate procedure numbering. v1 (R1 re-baseline, 2026-07-13) is the
    // first procedure-produced profile: the tag + lineage arm the provenance
    // gate (tools/calib/lib/lineage.ts).
    for (const profile of XD_PROFILES) {
      if (profile.id === 'v1') {
        expect(profile.procedure).toEqual({ id: 'xd-hardware-calibration', revision: 1 })
        expect(profile.lineage?.baseProfile).toBe('v0')
      } else {
        expect(profile.procedure).toBeUndefined()
      }
    }
  })

  it('reports every calibrated field changed from a profile base', () => {
    const base = XD_PROFILES.find((profile) => profile.id === 'v3')!
    const candidate = {
      ...base,
      id: 'v5',
      cutoffHz: { kind: 'expMap' as const, lo: 18, hi: 19_000 },
      lfoMaxPitchCents: base.lfoMaxPitchCents + 1,
    }
    expect(profileChangedFields(base, candidate)).toEqual(['cutoffHz', 'lfoMaxPitchCents'])
  })

  it('freezes registered profile data so a verified digest cannot mutate at runtime', () => {
    const profile = XD_PROFILES.find((candidate) => candidate.id === 'v3')!
    expect(Object.isFrozen(profile)).toBe(true)
    expect(Object.isFrozen(profile.cutoffHz)).toBe(true)
  })
})

describe('profile v0 reproduces the original guessed curves exactly', () => {
  it.each(RAWS)('raw %d', (raw) => {
    setXdProfile('v0')
    expect(cutoffToHz(raw)).toBe(expMap(raw, 16, 21000))
    expect(attackToSec(raw)).toBe(expMap(raw, 0.0006, 3.0))
    expect(decayToSec(raw)).toBe(expMap(raw, 0.002, 12.0))
    expect(releaseToSec(raw)).toBe(expMap(raw, 0.002, 15.0))
    expect(lfoRateToHz(raw)).toBe(expMap(raw, 0.05, 28))
    // engine pitch == documented display pitch under v0
    expect(vcoPitchCents(raw)).toBeCloseTo(pitchToCents(raw), 9)
  })
})

describe('profile v1 (R1 re-baseline 2026-07-13)', () => {
  it('switches and switches back', () => {
    expect(setXdProfile('v1')).toBe(true)
    expect(activeXdProfile().id).toBe('v1')
    expect(setXdProfile('nope')).toBe(false)
    expect(activeXdProfile().id).toBe('v1')
    setXdProfile('v0')
    expect(activeXdProfile().id).toBe('v0')
  })

  it('cutoff becomes the measured table (extrapolated wide-open top knot)', () => {
    setXdProfile('v1')
    expect(cutoffToHz(0)).toBeCloseTo(15.5376, 3)
    expect(cutoffToHz(896)).toBeCloseTo(9474.91, 1)
    expect(cutoffToHz(1023)).toBeCloseTo(23189.8, 0)
  })

  it('EG tables pass through every measured knot', () => {
    setXdProfile('v1')
    const prof = activeXdProfile()
    for (const [field, fn] of [
      ['egAttackSec', attackToSec],
      ['egDecaySec', decayToSec],
      ['egReleaseSec', releaseToSec],
    ] as const) {
      const spec = prof[field]
      if (spec.kind !== 'logPchip') throw new Error(`expected logPchip for ${field}`)
      for (const [raw, sec] of spec.knots) {
        expect(fn(raw)).toBeCloseTo(sec, 6)
      }
      // strictly increasing between knots (spot-check on a fine grid)
      let prev = fn(0)
      for (let r = 8; r <= 1023; r += 8) {
        const v = fn(r)
        expect(v).toBeGreaterThanOrEqual(prev)
        prev = v
      }
    }
  })

  it('attack at knob noon is the measured ~0.59 s, >10x the v0 guess', () => {
    setXdProfile('v0')
    const guess = attackToSec(512)
    setXdProfile('v1')
    expect(attackToSec(512)).toBeCloseTo(0.58563, 4)
    expect(attackToSec(512) / guess).toBeGreaterThan(10)
  })

  it('fall times are TIME-TO-ZERO of the cubic model (egFallPower 3), one generator', () => {
    setXdProfile('v1')
    const prof = activeXdProfile()
    expect(prof.egFallPower).toBe(3)
    // decay and release T agree within a few % at every shared knob —
    // the hardware runs ONE fall generator for both segments
    expect(decayToSec(1023)).toBeCloseTo(21.612, 2)
    expect(releaseToSec(1023)).toBeCloseTo(21.3714, 3)
    expect(Math.abs(Math.log(decayToSec(512) / releaseToSec(512)))).toBeLessThan(0.05)
    expect(Math.abs(Math.log(decayToSec(1023) / releaseToSec(1023)))).toBeLessThan(0.05)
  })

  it('engine pitch follows the measured law; DISPLAY pitch stays documented', () => {
    setXdProfile('v1')
    // measured mid-range is ~0.39x the documented table
    expect(vcoPitchCents(356)).toBeCloseTo(-98.425, 2)
    expect(vcoPitchCents(512)).toBe(0) // recentered dead zone
    expect(vcoPitchCents(0)).toBeCloseTo(-1199.257, 2)
    // the OLED numbers never change with the profile
    expect(pitchToCents(356)).toBe(-256)
    expect(pitchToCents(512)).toBe(0)
  })

  it('every profile id is unique and every curve evaluates finite', () => {
    const ids = new Set(XD_PROFILES.map((p) => p.id))
    expect(ids.size).toBe(XD_PROFILES.length)
    for (const p of XD_PROFILES) {
      for (const spec of [p.vcoPitchCents, p.egAttackSec, p.egDecaySec, p.egReleaseSec, p.cutoffHz, p.lfoRateHz]) {
        for (const raw of RAWS) expect(Number.isFinite(curveAt(spec, raw))).toBe(true)
      }
    }
  })
})

describe('profile v2 (batch 2)', () => {
  it('carries the batch-2 measurements and the v1-carried release raw-0 knot', () => {
    setXdProfile('v2')
    expect(cutoffToHz(0)).toBeCloseTo(25.1, 6)
    expect(cutoffToHz(1023)).toBeCloseTo(17800, 6)
    expect(attackToSec(512)).toBeCloseTo(0.59287, 4)
    expect(decayToSec(1023)).toBeCloseTo(16.412, 3)
    expect(releaseToSec(0)).toBeCloseTo(0.0041341, 6) // carried from the v1 round
    expect(vcoPitchCents(356)).toBeCloseTo(-99.74, 2)
    expect(vcoPitchCents(512)).toBe(0) // recentered dead zone
    expect(activeXdProfile().sqrPwMin).toBe(0)
    // documented-flat end pairs pooled: exactly flat, like the hardware ends
    expect(vcoPitchCents(0)).toBe(vcoPitchCents(4))
    expect(vcoPitchCents(1020)).toBe(vcoPitchCents(1023))
  })

  it('v1 and v2 ATTACK agrees within repeatability; fall times are a different convention', () => {
    // attack semantics are unchanged (10-90 rise based), so the R1 value must
    // reproduce the dev-era measurement. Decay/release CANNOT be compared
    // across v1/v2: v2 stores exponential 3*tau displayed times, v1 stores
    // time-to-zero T of the cubic fall (egFallPower).
    setXdProfile('v1')
    const a1 = attackToSec(512)
    setXdProfile('v2')
    const a2 = attackToSec(512)
    expect(Math.abs(Math.log(a2 / a1))).toBeLessThan(0.12)
  })
})

describe('profile v3 (cutoff table)', () => {
  it('cutoff passes through every measured knot and stays monotone', () => {
    setXdProfile('v3')
    const spec = activeXdProfile().cutoffHz
    if (spec.kind !== 'logPchip') throw new Error('expected logPchip cutoff in v3')
    for (const [raw, hz] of spec.knots) {
      expect(cutoffToHz(raw)).toBeCloseTo(hz, 6)
    }
    let prev = cutoffToHz(0)
    for (let r = 8; r <= 1023; r += 8) {
      const v = cutoffToHz(r)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('captures the taper the v2 expMap could not (S-shaped deviation around it)', () => {
    // The bias-corrected taper crosses the exponential: low-mid corners sit
    // BELOW the v2 expMap, upper-mid slightly above — a shape no (lo, hi)
    // pair can express.
    setXdProfile('v3')
    const at448 = cutoffToHz(448)
    const at640 = cutoffToHz(640)
    setXdProfile('v2')
    expect(at448).toBeCloseTo(417.69, 1)
    expect(at448).toBeLessThan(cutoffToHz(448)) // 417.7 vs expMap ~445
    expect(at640).toBeGreaterThan(cutoffToHz(640)) // 1571.5 vs expMap ~1524
  })

  it('everything except cutoff is identical to v2', () => {
    const v2 = XD_PROFILES.find((p) => p.id === 'v2')!
    const v3 = XD_PROFILES.find((p) => p.id === 'v3')!
    expect(v3.vcoPitchCents).toBe(v2.vcoPitchCents)
    expect(v3.egAttackSec).toBe(v2.egAttackSec)
    expect(v3.egDecaySec).toBe(v2.egDecaySec)
    expect(v3.egReleaseSec).toBe(v2.egReleaseSec)
    expect(v3.lfoRateHz).toBe(v2.lfoRateHz)
    expect(v3.sqrPwMin).toBe(v2.sqrPwMin)
    expect(v3.cutoffHz).not.toBe(v2.cutoffHz)
  })
})

describe('SQR pulse-width floor (profile sqrPwMin)', () => {
  function sqrRms(pwMin: number, freq = 220, reset = false): number {
    const vco = new Vco(SR)
    vco.pwMin = pwMin
    vco.setWave(VCO_WAVE.SQR)
    vco.setFreq(freq)
    vco.setShape(1)
    if (reset) vco.reset() // snaps the shape smoother to exactly 1.0
    const n = Math.round(0.1 * SR)
    const buf = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      buf[i] = vco.tick(0)
      expect(Number.isFinite(buf[i])).toBe(true)
    }
    // skip the shape/level smoothing transient
    return rms(buf, Math.round(0.05 * SR))
  }

  it('v0 floor (5%) keeps SHAPE max audible; 0 reaches silence like the hardware', () => {
    expect(sqrRms(0.05)).toBeGreaterThan(0.1)
    expect(sqrRms(0)).toBeLessThan(1e-3)
  })

  it('legacy floor stays audible where the BLEP width exceeds 5% (high notes, all synths)', () => {
    // adt = f/sr > 0.05 here: the stock law clamps pw at the BLEP width at
    // FULL amplitude — the profile fade must never engage at pwMin = 0.05
    // (caught by adversarial review: an unconditional fade silenced these)
    expect(sqrRms(0.05, 3000)).toBeGreaterThan(0.1)
    expect(sqrRms(0.05, 6000)).toBeGreaterThan(0.1)
    // a sub-5% profile floor DOES fade that region toward the hardware's silence
    expect(sqrRms(0, 3000)).toBeLessThan(1e-3)
  })

  it('shape snapped to exactly 1.0 via reset() stays finite and audible at the 5% floor', () => {
    // float64: 0.5 - (0.5 - 0.05)*1 lands a hair BELOW the stored 0.05, so
    // the clamp branch is entered with minPw === pwMin — the fade gate must
    // keep the zero-denominator division out (was -Infinity -> silence)
    expect(sqrRms(0.05, 220, true)).toBeGreaterThan(0.1)
  })
})

describe('Engine.setCalibProfile re-applies params live', () => {
  it('keeps explicitly configured engine profiles independent of realm-global UI state', () => {
    const render = (engine: Engine): number => {
      engine.loadProgram(initProgram())
      engine.setParam(P.AMP_ATTACK, 512)
      engine.noteOn(57, 100)
      return rms(renderEngine(engine, 0.12), Math.round(0.06 * SR), Math.round(0.1 * SR))
    }
    const v0 = new Engine(SR, 'v0')
    const v1 = new Engine(SR, 'v1')
    setXdProfile('v4')
    expect(render(v1)).toBeLessThan(render(v0) * 0.5)
  })

  it('v1 attack (0.59 s) leaves the first 100 ms much quieter than v0 (32 ms)', () => {
    const render = (profile: string): number => {
      const e = new Engine(SR)
      e.loadProgram(initProgram())
      e.setCalibProfile(profile)
      e.setParam(P.AMP_ATTACK, 512)
      e.noteOn(57, 100)
      const out = renderEngine(e, 0.12)
      return rms(out, Math.round(0.06 * SR), Math.round(0.1 * SR))
    }
    const v0 = render('v0')
    const v1 = render('v1')
    expect(v0).toBeGreaterThan(0.01) // v0: fully risen well inside 100 ms
    expect(v1).toBeLessThan(v0 * 0.5) // v1: still climbing a 0.59 s attack
  })
})
