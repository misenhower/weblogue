/*
 * Synth registry — the app shell's list of available synth definitions.
 * Main-thread only (entries carry worklet URLs and DOM app factories);
 * never import from tests or the worklet.
 */
import type { SynthEntry } from './def'
import { XD_ENTRY } from './xd/app'
import { OG_ENTRY } from './og/app'
import { MONO_ENTRY } from './mono/app'
import { PROLOGUE8_ENTRY, PROLOGUE16_ENTRY } from './prologue/app'

export const SYNTHS: readonly SynthEntry[] = [XD_ENTRY, OG_ENTRY, MONO_ENTRY, PROLOGUE8_ENTRY, PROLOGUE16_ENTRY]

const LS_KEY = 'weblogue-synth'

function savedSynth(): string | null {
  try {
    return localStorage.getItem(LS_KEY)
  } catch {
    return null
  }
}

/** Boot-time pick: ?synth= URL param > last used > first registered. */
export function pickSynth(): SynthEntry {
  const url = new URLSearchParams(window.location.search).get('synth')
  const id = url ?? savedSynth() ?? SYNTHS[0].def.id
  return SYNTHS.find((s) => s.def.id === id) ?? SYNTHS[0]
}

/** Remember + navigate: switching synths is a clean page reload. */
export function switchSynth(id: string): void {
  try {
    localStorage.setItem(LS_KEY, id)
  } catch {
    /* private mode: URL param still carries the choice */
  }
  const u = new URL(window.location.href)
  u.searchParams.set('synth', id)
  window.location.href = u.toString()
}
