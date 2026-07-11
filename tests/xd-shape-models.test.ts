/*
 * Measured SHAPE morph models (profile v4, D2 2026-07-11): SQR constant-swing
 * duty-table PWM with real DC, TRI single soft fold ending at an exact x3,
 * SAW half-rate chopper (octave-down morph). v0-v3 must carry no model
 * fields (legacy morphs bit-identical); v4's signatures must match the
 * hardware findings the models came from.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { Vco, VCO_WAVE } from '../src/dsp/osc'
import { XD_PROFILES, XD_DEFAULT_PROFILE, setXdProfile, curveAt } from '../src/synths/xd/profiles'
import { Engine } from '../src/synths/xd/engine'
import { P } from '../src/synths/xd/params'
import { renderEngine, goertzel, rms, SR } from './helpers/audio'

afterEach(() => {
  setXdProfile(XD_DEFAULT_PROFILE)
})

const V4 = XD_PROFILES.find((p) => p.id === 'v4')!

/** Vco with v4's model fns bound, as voice.ts bindShapeModels would. */
function v4Vco(wave: number, freq: number, shape: number): Vco {
  const vco = new Vco(SR)
  vco.setWave(wave)
  vco.setFreq(freq)
  vco.setShape(shape)
  vco.sqrDutyFn = (s) => curveAt(V4.sqrDuty!, s * 1023)
  vco.triDriveFn = (s) => curveAt(V4.triFoldDrive!, s * 1023)
  vco.triLevelFn = (s) => curveAt(V4.triFoldLevel!, s * 1023)
  vco.triKnee = V4.triFoldKnee!
  vco.sawChopDepthFn = (s) => curveAt(V4.sawChopDepth!, s * 1023)
  vco.sawChopPhaseFn = (s) => curveAt(V4.sawChopPhase!, s * 1023)
  vco.pwMin = V4.sqrPwMin
  return vco
}

function renderVco(vco: Vco, seconds: number, skipSeconds = 0.1): Float32Array {
  const skip = Math.round(skipSeconds * SR)
  for (let i = 0; i < skip; i++) vco.tick()
  const out = new Float32Array(Math.round(seconds * SR))
  for (let i = 0; i < out.length; i++) out[i] = vco.tick()
  return out
}

describe('profile schema', () => {
  it('v0-v3 carry no SHAPE model fields (legacy morphs stay bit-identical)', () => {
    for (const p of XD_PROFILES) {
      if (p.id === 'v4') continue
      expect(p.sqrDuty).toBeUndefined()
      expect(p.triFoldDrive).toBeUndefined()
      expect(p.sawChopDepth).toBeUndefined()
    }
    expect(V4.sqrDuty).toBeDefined()
    expect(V4.triFoldDrive).toBeDefined()
    expect(V4.sawChopDepth).toBeDefined()
  })
})

describe('SQR constant-swing PWM (v4)', () => {
  it('keeps a constant swing across the sweep (no peak normalization)', () => {
    const peak = (shape: number): number => {
      const x = renderVco(v4Vco(VCO_WAVE.SQR, 110, shape), 0.2)
      let pk = 0
      for (const v of x) pk = Math.max(pk, Math.abs(v))
      return pk
    }
    const p0 = peak(0)
    const p875 = peak(0.875) // duty ~0.08
    expect(p875 / p0).toBeGreaterThan(0.85)
    expect(p875 / p0).toBeLessThan(1.15)
  })

  it('carries the pulse DC (mean = 2d-1)', () => {
    const x = renderVco(v4Vco(VCO_WAVE.SQR, 110, 0.75), 0.3)
    let mean = 0
    for (const v of x) mean += v
    mean /= x.length
    const d = curveAt(V4.sqrDuty!, 0.75 * 1023) // ~0.156
    expect(mean).toBeLessThan(-0.4) // strongly negative
    expect(Math.abs(mean - (2 * d - 1))).toBeLessThan(0.12)
  })

  it('reaches silence at SHAPE max (measured hardware)', () => {
    const x = renderVco(v4Vco(VCO_WAVE.SQR, 220, 1), 0.2)
    expect(rms(x)).toBeLessThan(1e-3)
  })

  it('matches the legacy square at 50% duty within the duty-table offset', () => {
    // v4 duty(0) = 0.508 vs legacy 0.5 — same constant swing, tiny width diff
    const a = renderVco(v4Vco(VCO_WAVE.SQR, 110, 0), 0.1)
    const legacy = new Vco(SR)
    legacy.setWave(VCO_WAVE.SQR)
    legacy.setFreq(110)
    legacy.setShape(0)
    const b = renderVco(legacy, 0.1)
    expect(Math.abs(rms(a) - rms(b))).toBeLessThan(0.03)
  })
})

describe('TRI single soft fold (v4)', () => {
  it('is a plain triangle at SHAPE 0 (drive 1.06 barely kisses the knee)', () => {
    const x = renderVco(v4Vco(VCO_WAVE.TRI, 110, 0), 0.3)
    // triangle signature: H2 absent, H3 ~ -19 dB below H1
    const h1 = goertzel(x, 110)
    const h2 = goertzel(x, 220)
    const h3 = goertzel(x, 330)
    expect(h2 / h1).toBeLessThan(0.01)
    expect(h3 / h1).toBeGreaterThan(0.005)
    expect(h3 / h1).toBeLessThan(0.05)
  })

  it('becomes an exact triple-frequency triangle at SHAPE max (measured 330 Hz on hardware)', () => {
    const x = renderVco(v4Vco(VCO_WAVE.TRI, 110, 1), 0.4)
    const at = (f: number): number => goertzel(x, f)
    // fundamental and H2 collapse; 3x carries the tone
    expect(at(330) / Math.max(at(110), 1e-12)).toBeGreaterThan(50)
    expect(at(330) / Math.max(at(220), 1e-12)).toBeGreaterThan(50)
  })

  it('output level tapers per the measured table (~0.5x at max)', () => {
    const pk = (shape: number): number => {
      const x = renderVco(v4Vco(VCO_WAVE.TRI, 110, shape), 0.2)
      let m = 0
      for (const v of x) m = Math.max(m, Math.abs(v))
      return m
    }
    const ratio = pk(1) / pk(0)
    expect(ratio).toBeGreaterThan(0.4)
    expect(ratio).toBeLessThan(0.65)
  })
})

describe('SAW half-rate chopper (v4)', () => {
  it('is exactly the plain saw at SHAPE 0 (m = 0)', () => {
    const a = renderVco(v4Vco(VCO_WAVE.SAW, 110, 0), 0.1)
    const legacy = new Vco(SR)
    legacy.setWave(VCO_WAVE.SAW)
    legacy.setFreq(110)
    legacy.setShape(0)
    const b = renderVco(legacy, 0.1)
    for (let i = 0; i < a.length; i += 7) {
      expect(Math.abs(a[i] - b[i])).toBeLessThan(1e-9)
    }
  })

  it('SHAPE max: half-wave antisymmetry — 110/220 vanish, the 55-odd series carries (measured)', () => {
    const x = renderVco(v4Vco(VCO_WAVE.SAW, 110, 1), 0.4)
    const at = (f: number): number => goertzel(x, f)
    const p165 = at(165)
    expect(at(110) / p165).toBeLessThan(0.01)
    expect(at(220) / p165).toBeLessThan(0.01)
    expect(at(55) / p165).toBeGreaterThan(0.2) // measured 0.745
  })

  it('mid-morph: both the 110 series and the 55-odd series are present', () => {
    const x = renderVco(v4Vco(VCO_WAVE.SAW, 110, 0.5), 0.4)
    const at = (f: number): number => goertzel(x, f)
    expect(at(110)).toBeGreaterThan(0)
    expect(at(165) / at(110)).toBeGreaterThan(0.1)
  })

  it('stays bounded and finite across the whole sweep', () => {
    for (const shape of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const x = renderVco(v4Vco(VCO_WAVE.SAW, 440, shape), 0.05)
      for (const v of x) {
        expect(Number.isFinite(v)).toBe(true)
        expect(Math.abs(v)).toBeLessThan(1.6)
      }
    }
  })
})

describe('engine wiring (voice.ts bindShapeModels)', () => {
  function engineRender(profile: string, wave: number, shape: number): Float32Array {
    setXdProfile(profile)
    const e = new Engine(SR)
    e.setParam(P.VCO1_WAVE, wave)
    e.setParam(P.VCO1_SHAPE, shape)
    e.setParam(P.VCO1_LEVEL, 1023)
    e.setParam(P.VCO2_LEVEL, 0)
    e.setParam(P.MULTI_LEVEL, 0)
    e.setParam(P.CUTOFF, 1023)
    e.setParam(P.RESONANCE, 0)
    e.setParam(P.AMP_ATTACK, 0)
    e.setParam(P.AMP_SUSTAIN, 1023)
    e.noteOn(45, 100)
    return renderEngine(e, 0.5)
  }

  it('v4 through the engine period-doubles the saw at SHAPE max; v3 does not', () => {
    const v4 = engineRender('v4', 2, 1023)
    const v3 = engineRender('v3', 2, 1023)
    const tail = (x: Float32Array): Float32Array => x.subarray(Math.round(0.2 * SR))
    const sub = (x: Float32Array): number => goertzel(tail(x), 55) + goertzel(tail(x), 165)
    const base = (x: Float32Array): number => goertzel(tail(x), 110) + goertzel(tail(x), 220)
    expect(sub(v4)).toBeGreaterThan(base(v4) * 5) // 55-odd series dominates
    expect(base(v3)).toBeGreaterThan(sub(v3) * 5) // legacy square-ish blend stays at 110
  })
})
