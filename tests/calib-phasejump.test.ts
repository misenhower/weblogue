/*
 * Capture-corruption detector: synthetic saws with injected chunk deletions
 * and duplications (the ProFX 48 kHz USB failure mode) must be flagged at the
 * right time; clean signals, the replica's seeded drift, and legato glides
 * must stay at zero events.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { captureVerdict, phaseJumps } from '../tools/calib/lib/phasejump'
import { loadJob } from '../tools/calib/lib/job'
import { renderJobPoint } from '../tools/calib/lib/render'

const SR = 48000

/** Band-limited saw: harmonics 1..kTop at 1/k, phase-continuous by closed form. */
function saw(f0: number, seconds: number, kTop = 20): Float32Array {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  for (let k = 1; k <= kTop; k++) {
    const w = (2 * Math.PI * k * f0) / SR
    const a = 0.6 / k
    for (let i = 0; i < n; i++) out[i] += a * Math.sin(w * i)
  }
  return out
}

/** Drop n samples at `at` — a lost USB chunk. */
function deleteChunk(x: Float32Array, at: number, n: number): Float32Array {
  const out = new Float32Array(x.length - n)
  out.set(x.subarray(0, at), 0)
  out.set(x.subarray(at + n), at)
  return out
}

/** Repeat the n samples before `at` — a duplicated USB chunk. */
function dupChunk(x: Float32Array, at: number, n: number): Float32Array {
  const out = new Float32Array(x.length + n)
  out.set(x.subarray(0, at), 0)
  out.set(x.subarray(at - n, at), at)
  out.set(x.subarray(at), at + n)
  return out
}

/** 50% square: odd harmonics only — even-harmonic probes must self-disqualify. */
function square(f0: number, seconds: number, kTop = 15): Float32Array {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  for (let k = 1; k <= kTop; k += 2) {
    const w = (2 * Math.PI * k * f0) / SR
    const a = 0.8 / k
    for (let i = 0; i < n; i++) out[i] += a * Math.sin(w * i)
  }
  return out
}

const nearest = (atSec: number[], t: number) =>
  Math.min(...atSec.map((a) => Math.abs(a - t)))

const FROM = Math.round(0.2 * SR)
const TO = Math.round(2.8 * SR)

describe('phaseJumps', () => {
  for (const f0 of [110, 220, 440]) {
    it(`counts 0 on a clean ${f0} Hz saw`, () => {
      const { count } = phaseJumps(saw(f0, 3), SR, f0, FROM, TO)
      expect(count).toBe(0)
    })

    it(`flags a 40-sample deletion in a ${f0} Hz saw within 50 ms`, () => {
      const cut = Math.round(1.5 * SR)
      const { count, atSec } = phaseJumps(deleteChunk(saw(f0, 3), cut, 40), SR, f0, FROM, TO)
      expect(count).toBeGreaterThanOrEqual(1)
      expect(count).toBeLessThanOrEqual(2)
      expect(nearest(atSec, 1.5)).toBeLessThan(0.05)
    })

    it(`flags a 15-sample duplication in a ${f0} Hz saw within 50 ms`, () => {
      const cut = Math.round(1.5 * SR)
      const { count, atSec } = phaseJumps(dupChunk(saw(f0, 3), cut, 15), SR, f0, FROM, TO)
      expect(count).toBeGreaterThanOrEqual(1)
      expect(count).toBeLessThanOrEqual(2)
      expect(nearest(atSec, 1.5)).toBeLessThan(0.05)
    })
  }

  for (const f0 of [110, 440]) {
    it(`handles a ${f0} Hz square wave: absent even harmonics never fire, splices still flag`, () => {
      // shape-sqr's point 0 is a 50% square — a probe on an even harmonic
      // tracks pure noise and must self-disqualify via the coherence check
      expect(phaseJumps(square(f0, 3), SR, f0, FROM, TO).count).toBe(0)
      const cut = Math.round(1.5 * SR)
      const del = phaseJumps(deleteChunk(square(f0, 3), cut, 40), SR, f0, FROM, TO)
      expect(del.count).toBeGreaterThanOrEqual(1)
      expect(del.count).toBeLessThanOrEqual(2)
      expect(nearest(del.atSec, 1.5)).toBeLessThan(0.05)
    })
  }

  it('flags a splice of exactly one 880 Hz cycle at f0 440 (coprime-probe blind spot)', () => {
    // 55 samples ~ 1.0 cycle of 880 Hz and 2.0 of 1760 Hz — invisible if both
    // probes share a base harmonic; the coprime 3rd-harmonic probe sees 1.5
    const cut = Math.round(1.5 * SR)
    const { count, atSec } = phaseJumps(deleteChunk(saw(440, 3), cut, 55), SR, 440, FROM, TO)
    expect(count).toBeGreaterThanOrEqual(1)
    expect(nearest(atSec, 1.5)).toBeLessThan(0.05)
  })

  it('counts 0 on a clean replica render despite seeded drift', () => {
    const job = loadJob(join(__dirname, '../tools/calib/jobs/vco1-a440.json'))
    const r = renderJobPoint(job, null)
    const from = r.onsetSample + Math.round(0.15 * r.sr)
    const to = r.onsetSample + Math.round(1.0 * r.sr)
    expect(phaseJumps(r.samples, r.sr, 440, from, to).count).toBe(0)
  })

  it('flags a 30-sample deletion mid-sustain of the replica render', () => {
    const job = loadJob(join(__dirname, '../tools/calib/jobs/vco1-a440.json'))
    const r = renderJobPoint(job, null)
    const cut = r.onsetSample + Math.round(0.5 * r.sr)
    const spliced = deleteChunk(r.samples, cut, 30)
    const from = r.onsetSample + Math.round(0.15 * r.sr)
    const to = r.onsetSample + Math.round(1.0 * r.sr)
    const { count, atSec } = phaseJumps(spliced, r.sr, 440, from, to)
    expect(count).toBeGreaterThanOrEqual(1)
    expect(nearest(atSec, cut / r.sr)).toBeLessThan(0.05)
  })

  it('counts 0 on a legato glide (440 -> 466 Hz over 1 s) — ramps are not steps', () => {
    // 0.2 s hold, 1 s linear glide, 0.2 s hold; harmonics 1..6, phase-accumulated
    const n = Math.round(1.4 * SR)
    const x = new Float32Array(n)
    let phase = 0
    for (let i = 0; i < n; i++) {
      const t = i / SR
      const f = t < 0.2 ? 440 : t < 1.2 ? 440 + 26 * (t - 0.2) : 466
      phase += (2 * Math.PI * f) / SR
      for (let k = 1; k <= 6; k++) x[i] += (0.6 / k) * Math.sin(k * phase)
    }
    const { count } = phaseJumps(x, SR, 440, Math.round(0.05 * SR), Math.round(1.35 * SR))
    expect(count).toBe(0)
  })

  it('returns no events on empty or absurd windows', () => {
    const x = saw(220, 1)
    expect(phaseJumps(x, SR, 220, 5000, 5000).count).toBe(0)
    expect(phaseJumps(x, SR, 220, -100, 4).count).toBe(0)
    expect(phaseJumps(new Float32Array(SR), SR, 220, 0, SR).count).toBe(0) // silence
  })
})

describe('captureVerdict', () => {
  it('is null for a clean capture and for isolated (<= 2) jumps', () => {
    expect(captureVerdict(saw(220, 3), SR, 220, FROM, TO)).toBeNull()
    const one = deleteChunk(saw(220, 3), Math.round(1.5 * SR), 40)
    expect(captureVerdict(one, SR, 220, FROM, TO)).toBeNull()
  })

  it('names the jump count when more than 2 splices land in one capture', () => {
    let x = saw(220, 3)
    // back to front so earlier injection points stay valid
    for (const tCut of [2.0, 1.4, 0.8]) x = deleteChunk(x, Math.round(tCut * SR), 40)
    const { count } = phaseJumps(x, SR, 220, FROM, TO)
    expect(count).toBeGreaterThanOrEqual(3)
    expect(captureVerdict(x, SR, 220, FROM, TO)).toBe(
      `${count} phase jumps (USB splice/drop suspected)`,
    )
  })
})
