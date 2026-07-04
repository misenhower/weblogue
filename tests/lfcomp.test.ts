/*
 * LfComp (prologue-16 L.F. COMP) tests: frequency-selective low boost
 * (goertzel 60 Hz vs 1 kHz), gain-reduction engagement on hot signals at
 * high GAIN, the neutral state (GAIN 0 = exact identity through the
 * complementary crossover), NaN robustness, and click-free-ish ON/OFF.
 * The model itself is UNCONFIRMED voicing (see src/dsp/fx/lfcomp.ts) —
 * these tests pin OUR model's contract, not hardware measurements.
 */
import { describe, expect, it } from 'vitest'
import { LfComp } from '../src/dsp/fx/lfcomp'
import { SR, BLOCK, goertzel } from './helpers/audio'

interface Tone {
  hz: number
  amp: number
}

/** Render `seconds` of a sine mix through the comp (stereo, same both
 *  channels), returning { in, out } L buffers. */
function processTones(
  comp: LfComp,
  seconds: number,
  tones: readonly Tone[],
  onBlock?: (blockIndex: number) => void,
): { input: Float32Array; output: Float32Array } {
  const total = Math.round(seconds * SR)
  const input = new Float32Array(total)
  const output = new Float32Array(total)
  const l = new Float32Array(BLOCK)
  const r = new Float32Array(BLOCK)
  let done = 0
  let b = 0
  while (done < total) {
    const n = Math.min(BLOCK, total - done)
    if (onBlock) onBlock(b++)
    for (let i = 0; i < n; i++) {
      let s = 0
      for (const t of tones) s += t.amp * Math.sin((2 * Math.PI * t.hz * (done + i)) / SR)
      l[i] = s
      r[i] = s
    }
    input.set(l.subarray(0, n), done)
    comp.process(l, r, n)
    output.set(l.subarray(0, n), done)
    done += n
  }
  return { input, output }
}

/** Fresh comp, ON, primed past the on-ramp (reset snaps the crossfade). */
function makeOn(gain: number): LfComp {
  const c = new LfComp(SR)
  c.setOn(true)
  c.setGain(gain)
  c.reset()
  return c
}

const TAIL = Math.round(0.3 * SR) // measure past the envelope settle

describe('LfComp low-band boost', () => {
  it('boosts 60 Hz strongly while leaving 1 kHz nearly untouched', () => {
    // Quiet tones: the boosted low band stays under the compressor threshold.
    const tones = [
      { hz: 60, amp: 0.05 },
      { hz: 1000, amp: 0.05 },
    ] as const
    const flat = processTones(makeOn(0), 1, tones).output
    const boosted = processTones(makeOn(1), 1, tones).output
    const p60 = goertzel(boosted, 60, TAIL) / goertzel(flat, 60, TAIL)
    const p1k = goertzel(boosted, 1000, TAIL) / goertzel(flat, 1000, TAIL)
    expect(p60).toBeGreaterThan(8) // ~+11 dB through the crossover
    expect(p1k).toBeLessThan(2.5) // high band passes nearly flat
    expect(p60 / p1k).toBeGreaterThan(5) // the boost is frequency-selective
  })

  it('GAIN 0 while ON is an exact identity (complementary crossover)', () => {
    const { input, output } = processTones(makeOn(0), 0.5, [{ hz: 220, amp: 0.3 }])
    let maxDiff = 0
    for (let i = 0; i < input.length; i++) {
      const d = Math.abs(output[i] - input[i])
      if (d > maxDiff) maxDiff = d
    }
    expect(maxDiff).toBeLessThan(1e-6)
  })
})

describe('LfComp gain reduction', () => {
  it('engages on a hot low signal at high GAIN, idles on a quiet one', () => {
    const hot = makeOn(1)
    processTones(hot, 0.5, [{ hz: 60, amp: 0.5 }])
    expect(hot.grLevel).toBeGreaterThan(0.3)
    expect(hot.grLevel).toBeLessThanOrEqual(1)

    const quiet = makeOn(1)
    processTones(quiet, 0.5, [{ hz: 60, amp: 0.01 }])
    expect(quiet.grLevel).toBeLessThan(0.05)

    const noGain = makeOn(0)
    processTones(noGain, 0.5, [{ hz: 60, amp: 0.5 }])
    expect(noGain.grLevel).toBeLessThan(0.05) // unboosted lows stay under threshold
  })

  it('compression keeps a cranked GAIN from running away', () => {
    const tones = [{ hz: 60, amp: 0.5 }] as const
    const flat = processTones(makeOn(0), 1, tones).output
    const boosted = processTones(makeOn(1), 1, tones).output
    const gainDb = 5 * Math.log10(goertzel(boosted, 60, TAIL) / goertzel(flat, 60, TAIL))
    // +12 dB of knob gain lands well under +12 dB out (upward gain into GR)
    expect(gainDb).toBeGreaterThan(1)
    expect(gainDb).toBeLessThan(8)
  })
})

describe('LfComp robustness', () => {
  it('never emits NaN, and recovers from NaN input', () => {
    const comp = makeOn(1)
    const l = new Float32Array(BLOCK)
    const r = new Float32Array(BLOCK)
    for (let b = 0; b < 40; b++) {
      for (let i = 0; i < BLOCK; i++) {
        const s = 0.4 * Math.sin((2 * Math.PI * 60 * (b * BLOCK + i)) / SR)
        l[i] = s
        r[i] = s
      }
      if (b === 10) l[5] = Number.NaN
      if (b === 11) r[7] = Number.POSITIVE_INFINITY
      comp.process(l, r, BLOCK)
      for (let i = 0; i < BLOCK; i++) {
        expect(Number.isFinite(l[i])).toBe(true)
        expect(Number.isFinite(r[i])).toBe(true)
      }
    }
    expect(Number.isFinite(comp.grLevel)).toBe(true)
    // still audibly processing after the bad samples
    const tail = processTones(comp, 0.3, [{ hz: 60, amp: 0.3 }]).output
    expect(goertzel(tail, 60, Math.round(0.1 * SR))).toBeGreaterThan(1e-4)
  })

  it('OFF is an exact bypass; toggling is click-free-ish (crossfaded)', () => {
    const off = new LfComp(SR)
    off.setOn(false)
    off.setGain(1)
    const { input, output } = processTones(off, 0.2, [{ hz: 60, amp: 0.4 }])
    expect(output).toEqual(input)
    expect(off.grLevel).toBe(0)

    // Toggle OFF (then ON) mid-signal: the largest sample step should stay
    // in the same league as the 60 Hz signal's own slope — no hard switch.
    const comp = makeOn(1)
    const toggleOffAt = Math.round((0.5 * SR) / BLOCK)
    const toggleOnAt = Math.round((0.75 * SR) / BLOCK)
    const { output: out } = processTones(comp, 1, [{ hz: 60, amp: 0.3 }], (b) => {
      if (b === toggleOffAt) comp.setOn(false)
      if (b === toggleOnAt) comp.setOn(true)
    })
    let maxStep = 0
    for (let i = Math.round(0.4 * SR) + 1; i < out.length; i++) {
      const d = Math.abs(out[i] - out[i - 1])
      if (d > maxStep) maxStep = d
    }
    expect(maxStep).toBeLessThan(0.05)
  })
})
