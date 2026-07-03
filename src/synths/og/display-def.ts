/*
 * Original Korg minilogue (OG) DisplayDef — same shape as the xd's
 * (synths/xd/display-def.ts) over the OG param table.
 *
 * PROG EDIT pages are the OG's per-program menu params (og-spec.md §11):
 * kbd octave, portamento (+ mode/bpm), program level, bend ranges, slider
 * assign/range, LFO key/bpm/voice sync, amp velocity. xd-only pages
 * (microtuning, joystick Y assigns, VPM/multi-engine params) don't exist in
 * the OG table, so they never appear.
 */
import type { DisplayDef } from '../../ui/display'
import { PARAMS, formatParam, motionParamLabel, MOTION_PARAM_IDS, P } from './params'

/** Status-line short names, VOICE MODE button order (og-spec.md §3). */
const VOICE_SHORT = ['POLY', 'DUO', 'UNI', 'MONO', 'CHD', 'DLY', 'ARP', 'S.CHN'] as const

export const OG_DISPLAY_DEF: DisplayDef = {
  params: PARAMS,
  formatParam,
  menuParams: PARAMS.filter((p) => p.kind === 'menu'),
  motionParamIds: MOTION_PARAM_IDS,
  motionParamLabel,
  voiceMode: { id: P.VOICE_MODE, labels: VOICE_SHORT },
}
