/*
 * Micro tuning — family-shared tuning tables (cents offset per pitch class
 * relative to equal temperament, rotated by scale key). Subset of the
 * hardware list; hoisted from the xd definition for reuse across 'logue
 * synths (the monologue ships the same microtuning menu).
 */
import { clamp } from '../shared/maps'

export const MICRO_TUNINGS: ReadonlyArray<{ name: string; cents: readonly number[] | null }> = [
  { name: 'Equal Temp', cents: null },
  { name: 'Pure Major', cents: [0, -29.3, 3.9, 15.6, -13.7, -2.0, -31.3, 2.0, 13.7, -15.6, 17.6, -11.7] },
  { name: 'Pure Minor', cents: [0, 33.2, 3.9, 15.6, -13.7, -2.0, 31.3, 2.0, 13.7, -15.6, 17.6, -11.7] },
  { name: 'Pythagorean', cents: [0, 13.7, 3.9, -5.9, 7.8, -2.0, 11.7, 2.0, 15.6, 5.9, -3.9, 9.8] },
  { name: 'Werckmeister', cents: [0, -9.8, -7.8, -5.9, -9.8, -2.0, -11.7, -3.9, -7.8, -11.7, -3.9, -7.8] },
  { name: 'Kirnburger', cents: [0, -9.8, -6.8, -5.9, -13.7, -2.0, -10.3, -3.4, -7.8, -10.3, -3.9, -11.7] },
  { name: 'Slendro', cents: [0, 0, 40, 0, -30, 20, 0, 10, 0, -20, 30, 0] },
  { name: 'Pelog', cents: [0, 20, -30, 0, -10, 30, 0, -20, 10, 0, -40, 0] },
  { name: 'Major Penta', cents: null },
  { name: 'Minor Penta', cents: null },
  { name: 'Reverse', cents: null },
]

/** Returns cents offset for a MIDI note under a tuning + scale key. */
export function microTuneCents(tuningIndex: number, note: number, scaleKey: number): number {
  const t = MICRO_TUNINGS[clamp(tuningIndex, 0, MICRO_TUNINGS.length - 1)]
  if (!t || !t.cents) return 0
  const pc = ((note - scaleKey) % 12 + 12) % 12
  return t.cents[pc]
}
