/*
 * Shared audio test scaffolding: block render harness over an Engine-like
 * process(), cheap signal measurements, and a StoreDef stub builder.
 */
import type { StoreDef } from '../../src/synths/def'

export const SR = 48000
export const BLOCK = 128

interface BlockProcessor {
  process(l: Float32Array, r: Float32Array, n: number): void
}

/**
 * Render `seconds` through the engine in 128-frame blocks, returning the L
 * channel. `onBlock` runs before each block (for param pokes mid-render).
 */
export function renderEngine(
  e: BlockProcessor,
  seconds: number,
  onBlock?: (blockIndex: number, done: number) => void,
): Float32Array {
  const total = Math.round(seconds * SR)
  const out = new Float32Array(total)
  const l = new Float32Array(BLOCK)
  const r = new Float32Array(BLOCK)
  let done = 0
  let b = 0
  while (done < total) {
    const n = Math.min(BLOCK, total - done)
    if (onBlock) onBlock(b++, done)
    e.process(l, r, n)
    out.set(l.subarray(0, n), done)
    done += n
  }
  return out
}

export function rms(buf: Float32Array, from = 0, to = buf.length): number {
  let acc = 0
  for (let i = from; i < to; i++) acc += buf[i] * buf[i]
  return Math.sqrt(acc / Math.max(1, to - from))
}

/** Goertzel mean-square power of the component at freqHz (exact-bin use). */
export function goertzel(buf: Float32Array, freqHz: number, from = 0, to = buf.length, sr = SR): number {
  const n = to - from
  const w = (2 * Math.PI * freqHz) / sr
  const coeff = 2 * Math.cos(w)
  let s1 = 0
  let s2 = 0
  for (let i = from; i < to; i++) {
    const s0 = buf[i] + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return (2 * (s1 * s1 + s2 * s2 - coeff * s1 * s2)) / (n * n)
}

/** StoreDef stub from a real def's pieces: no factory presets, isolated bank. */
export function makeStoreDef(def: StoreDef, overrides: Partial<StoreDef> = {}): StoreDef {
  return { ...def, factoryPresets: [], ...overrides }
}
