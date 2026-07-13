/*
 * Measured SHAPE morph models (profile v4, D2 2026-07-11): SQR constant-swing
 * duty-table PWM with real DC, TRI single soft fold ending at an exact x3,
 * SAW reversal mirror (octave-down morph). v0 must carry no model fields
 * (legacy morphs bit-identical); the model signatures must match the
 * hardware findings they came from (tables here = the dev-era v4 fixture).
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

/**
 * The D2-measured SHAPE model tables, verbatim from the dev-era profile v4
 * (dropped 2026-07-13 when the R1 re-baseline v1 became the default): kept
 * here as the fixture the model-MECHANICS tests pin against, independent of
 * whatever tables the shipped profiles carry.
 */
const V4 = {
  sqrDuty: {
    kind: 'pchip',
    knots: [
      [0, 0.5075],
      [128, 0.44],
      [256, 0.38],
      [384, 0.3225],
      [512, 0.2625],
      [640, 0.2025],
      [768, 0.14],
      [896, 0.08],
      [1023, 0], // measured silence
    ],
  },
  triFoldDrive: {
    // coherent with triFoldKnee = 0.30 (drive and knee trade off; the knee
    // basin is flat 0.3-0.4, so the pair was fitted together)
    kind: 'pchip',
    knots: [
      [0, 1.03],
      [64, 1.04],
      [128, 1.07],
      [192, 1.11],
      [256, 1.17],
      [320, 1.25],
      [384, 1.33],
      [448, 1.42],
      [512, 1.55],
      [576, 1.66],
      [640, 1.79],
      [704, 1.93],
      [768, 2.09],
      [832, 2.27],
      [896, 2.47],
      [960, 2.69],
      [1023, 2.94], // the fitted exact-x3 endpoint under the soft knee
    ],
  },
  triFoldLevel: {
    kind: 'pchip',
    knots: [
      [0, 1.0],
      [64, 0.9887],
      [128, 0.9625],
      [192, 0.9277],
      [256, 0.8844],
      [320, 0.8379],
      [384, 0.7968],
      [448, 0.7585],
      [512, 0.7251],
      [576, 0.6927],
      [640, 0.6615],
      [704, 0.632],
      [768, 0.6054],
      [832, 0.5813],
      [896, 0.5596],
      [960, 0.5378],
      [1023, 0.5125],
    ],
  },
  triFoldKnee: 0.3,
  sawMirrorW: {
    // dense-sweep fit (33 points; raw 544's capture was weak — re-measure
    // someday); endpoints pinned by structure: 0 = plain saw, 0.5 = the
    // measured exact half-wave antisymmetry at SHAPE max
    kind: 'pchip',
    knots: [
      [0, 0],
      [32, 0.025],
      [64, 0.0375],
      [96, 0.055],
      [128, 0.0675],
      [160, 0.0875],
      [192, 0.1025],
      [224, 0.1125],
      [256, 0.13],
      [288, 0.145],
      [320, 0.16],
      [352, 0.1725],
      [384, 0.1875],
      [416, 0.2075],
      [448, 0.2225],
      [480, 0.2375],
      [512, 0.2525],
      [544, 0.265],
      [576, 0.28],
      [608, 0.295],
      [640, 0.31],
      [672, 0.325],
      [704, 0.3375],
      [736, 0.3575],
      [768, 0.3725],
      [800, 0.385],
      [832, 0.4],
      [864, 0.4175],
      [896, 0.43],
      [928, 0.445],
      [960, 0.47],
      [992, 0.5],
      [1023, 0.5],
    ],
  },
  sqrPwMin: 0,
} as const

/** Vco with v4's model fns bound, as voice.ts bindShapeModels would. */
function v4Vco(wave: number, freq: number, shape: number): Vco {
  const vco = new Vco(SR)
  vco.setWave(wave)
  vco.setFreq(freq)
  vco.setShape(shape)
  vco.sqrDutyFn = (s) => curveAt(V4.sqrDuty, s * 1023)
  vco.triDriveFn = (s) => curveAt(V4.triFoldDrive, s * 1023)
  vco.triLevelFn = (s) => curveAt(V4.triFoldLevel, s * 1023)
  vco.triKnee = V4.triFoldKnee
  vco.sawMirrorWFn = (s) => curveAt(V4.sawMirrorW, s * 1023)
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
  it('v0 carries no SHAPE model fields (legacy morphs stay bit-identical); v1 carries all', () => {
    const v0 = XD_PROFILES.find((p) => p.id === 'v0')!
    expect(v0.sqrDuty).toBeUndefined()
    expect(v0.triFoldDrive).toBeUndefined()
    expect(v0.sawMirrorW).toBeUndefined()
    const v1 = XD_PROFILES.find((p) => p.id === 'v1')!
    expect(v1.sqrDuty).toBeDefined()
    expect(v1.triFoldDrive).toBeDefined()
    expect(v1.sawMirrorW).toBeDefined()
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
    const d = curveAt(V4.sqrDuty, 0.75 * 1023) // ~0.156
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

describe('SAW reversal mirror (v4)', () => {
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
    const e = new Engine(SR, profile)
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

  it('v1 through the engine period-doubles the saw at SHAPE max; legacy v0 does not', () => {
    const v4 = engineRender('v1', 2, 1023)
    const v3 = engineRender('v0', 2, 1023)
    const tail = (x: Float32Array): Float32Array => x.subarray(Math.round(0.2 * SR))
    const sub = (x: Float32Array): number => goertzel(tail(x), 55) + goertzel(tail(x), 165)
    const base = (x: Float32Array): number => goertzel(tail(x), 110) + goertzel(tail(x), 220)
    expect(sub(v4)).toBeGreaterThan(base(v4) * 5) // 55-odd series dominates
    expect(base(v3)).toBeGreaterThan(sub(v3) * 5) // legacy square-ish blend stays at 110
  })
})
