/*
 * Waveform trigger canonicalization (Matt's catch, 2026-07-10): waves with
 * several rising zero crossings per cycle — the period-doubled SAW morph's
 * alternating teeth, the folded TRI — made the report thumbnails and the live
 * scope trigger on whichever crossing came first, so successive captures
 * rendered at different phases and looked mis-triggered. The canonical rule
 * (anchor at the cycle's global minimum, start at the first rising crossing
 * after it) must produce the SAME view no matter where the search starts.
 */
import { describe, it, expect } from 'vitest'
import { waveSnapshot } from '../tools/calib/lib/measure'
import { ScopeState } from '../tools/calib/lib/scope'
import { shapeCycleConsistency } from '../tools/calib/lib/measure-shape'

const SR = 48000

/**
 * Alternating tall/short sawtooth teeth (the hardware SAW-morph structure):
 * tooth rate 110 Hz, true fundamental 55 Hz. Each tooth ramps -a..+a then
 * resets, so every doubled cycle has TWO rising zero crossings — the
 * trigger ambiguity under test. Short-tooth amplitude 0.35 puts the 55 Hz
 * subharmonic power at ~0.38x the 110 Hz peak, safely past the pipeline's
 * 0.2 descent threshold (pure amplitude alternation is subharmonic-weak;
 * hardware teeth measure at ~0.58x).
 */
function altSaw(n: number, phase0 = 0): Float32Array {
  const tooth = SR / 110
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = (i + phase0) / tooth
    const k = Math.floor(t)
    const a = k % 2 === 0 ? 1.0 : 0.35
    out[i] = a * (2 * (t - k) - 1)
  }
  return out
}

/**
 * Max abs diff after dropping the `drop` worst samples: the doubled period is
 * a non-integer sample count, so two correctly phase-locked views still
 * differ sub-sample — at each saw RESET one sample lands on the other side
 * of the discontinuity (isolated ~2.0 diffs on a ~5-reset window). A
 * mis-triggered view (tall/short teeth swapped) differs EVERYWHERE, which
 * this still catches.
 */
function robustMaxDiff(a: ArrayLike<number>, b: ArrayLike<number>, drop = 8): number {
  const d: number[] = []
  for (let i = 0; i < a.length; i++) d.push(Math.abs(a[i] - b[i]))
  d.sort((p, q) => p - q)
  return d[Math.max(0, d.length - 1 - drop)]
}

describe('waveSnapshot canonical trigger', () => {
  it('is phase-stable on a period-doubled saw regardless of where the search starts', () => {
    const x = altSaw(SR)
    const tooth = SR / 110
    // start the search at many different phases, including ones that land
    // just before the SHORT tooth's rising crossing (the old failure: the
    // snapshot began there instead of on the tall tooth)
    const snaps = [0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5].map((k) =>
      waveSnapshot(x, SR, Math.round(4 * tooth + k * tooth), 55),
    )
    for (const s of snaps.slice(1)) {
      expect(robustMaxDiff(snaps[0], s, 4)).toBeLessThan(0.05)
    }
  })

  it('still starts a plain wave at its rising zero crossing', () => {
    const x = new Float32Array(SR)
    for (let i = 0; i < SR; i++) x[i] = Math.sin((2 * Math.PI * 220 * i) / SR)
    const snap = waveSnapshot(x, SR, 1000, 220)
    expect(Math.abs(snap[0])).toBeLessThan(0.05) // starts at zero...
    expect(snap[3]).toBeGreaterThan(snap[0]) // ...heading up
  })
})

describe('live scope trigger + pitch', () => {
  function frameOf(extraTeeth: number): { wave: number[]; f0: number } {
    const scope = new ScopeState(SR)
    const tooth = SR / 110
    scope.push(altSaw(SR + Math.round(extraTeeth * tooth)))
    return scope.frame() as { wave: number[]; f0: number }
  }

  it('reports the true period-doubled fundamental (55 Hz), not the tooth rate', () => {
    const f = frameOf(0)
    expect(Math.abs(1200 * Math.log2(f.f0 / 55))).toBeLessThan(30) // within 30 cents
  })

  it('renders the same phase-locked view as the signal scrolls by odd tooth counts', () => {
    // 3 teeth = 1.5 doubled cycles: an old-style "any rising crossing"
    // trigger flips between tall- and short-tooth alignment here
    const a = frameOf(0)
    const b = frameOf(3)
    const c = frameOf(7)
    expect(a.wave.length).toBeGreaterThan(0)
    expect(robustMaxDiff(a.wave, b.wave)).toBeLessThan(0.05)
    expect(robustMaxDiff(a.wave, c.wave)).toBeLessThan(0.05)
  })
})

describe('shapeCycleConsistency (shape-job integrity gate)', () => {

  it('passes a clean period-doubled morph and fails a spliced one', () => {
    const clean = altSaw(SR)
    const c1 = shapeCycleConsistency(clean, SR, 4800, 43000, 55.07, 110)
    expect(c1).not.toBeNull()
    expect(c1!).toBeLessThan(0.05)
    // splice: delete 60 samples INSIDE one half (a dropped USB chunk;
    // cycles before/after it misalign and smear that half's average — a
    // splice exactly at the split boundary would only rotate a whole half,
    // which the rotation-free comparison forgives by design)
    const spliced = new Float32Array(SR)
    spliced.set(clean.subarray(0, 14000), 0)
    spliced.set(clean.subarray(14060), 14000)
    const c2 = shapeCycleConsistency(spliced, SR, 4800, 43000, 55.07, 110)
    expect(c2).not.toBeNull()
    expect(c2!).toBeGreaterThan(0.1)
  })
})
