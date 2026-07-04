/*
 * Korg monologue DisplayDef — same shape as the og's
 * (synths/og/display-def.ts) over the monologue param table.
 *
 * PROG EDIT pages are the monologue's per-program menu params
 * (monologue-spec.md §11): portamento time + mode, slide time, LFO BPM sync,
 * cutoff velocity / key track, amp velocity, program level, program tuning,
 * microtuning + scale key, bend ranges, slider assign/range. Two menu-KIND
 * table entries are deliberately excluded because they are not §11 menu
 * params: VCO1 OCTAVE (program data + rx-only CC48 — the hardware exposes no
 * edit page for it, spec §3) and KBD OCTAVE (a dedicated 5-way panel switch,
 * spec §2).
 *
 * No voiceMode readout: the monologue is monophonic with no voice-mode
 * concept (spec §1).
 */
import type { DisplayDef } from '../../ui/display'
import { PARAMS, formatParam, motionParamLabel, MOTION_PARAM_IDS, P } from './params'

/** menu-kind params that are NOT spec §11 menu pages (see header). */
const MENU_EXCLUDED: ReadonlySet<number> = new Set<number>([P.VCO1_OCTAVE, P.OCTAVE])

export const MONO_DISPLAY_DEF: DisplayDef = {
  params: PARAMS,
  formatParam,
  menuParams: PARAMS.filter((p) => p.kind === 'menu' && !MENU_EXCLUDED.has(p.id)),
  motionParamIds: MOTION_PARAM_IDS,
  motionParamLabel,
}
