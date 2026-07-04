/*
 * Korg prologue DisplayDef — same shape as the family's (synths/xd/
 * display-def.ts) over the prologue param table, built per variant.
 *
 * transport: 'arp' — the prologue has NO step sequencer and NO motion
 * sequencing (prologue-spec.md §10): the display keeps only a TEMPO
 * (Program.seq.bpm) page in place of the SEQ EDIT block, drops the motion
 * pages, and hides the REC readouts (see ui/display.ts).
 *
 * PROG EDIT pages are every menu-kind param in table order: the program
 * globals (kbd octave, timbre balance/position/split, amp velocity,
 * portamento mode, program level/tuning/transpose, microtuning + scale key,
 * FX routings, the whole ARP block) followed by BOTH timbre blocks' menu
 * params ('T1 ...' then 'T2 ...' labels: portamento, voice spread, EG
 * velocity, LFO target-osc/key-sync/voice-sync, wheel/aftertouch assigns +
 * ranges, bend ranges, EG legato, multi routing, VPM engine params).
 *
 * Variant difference: the prologue-8 has no TIMBRE panel section (spec §14),
 * so its menu additionally carries the switch-kind TIMBRE items (SUB ON,
 * EDIT TIMBRE, TIMBRE TYPE) — its ONLY access to them. The 16 exposes those
 * on the panel (SUB ON button, PANEL 3-pos, TYPE 3-pos) and keeps the strict
 * menu-param list like the other synths.
 *
 * voiceMode status readout: DisplayDef takes one static param id, so the
 * status line shows the MAIN timbre's voice mode; the per-timbre readout
 * lives in SERVICE MODE (debug-def.ts).
 */
import type { DisplayDef } from '../../ui/display'
import { PARAMS, formatParam, motionParamLabel, MOTION_PARAM_IDS, P, TIMBRE_BLOCKS } from './params'
import type { PrologueVariant } from './ids'

/** Status-line short names, VOICE MODE enum order (spec §4). */
const VOICE_SHORT = ['POLY', 'MONO', 'UNI', 'CHD'] as const

/** Switch-kind TIMBRE params folded into the prologue-8's menu (menu-only
 *  access — no TIMBRE panel section on the 8, spec §14). */
const TIMBRE_SWITCH_MENU: ReadonlySet<number> = new Set<number>([
  P.SUB_ON,
  P.EDIT_TIMBRE,
  P.TIMBRE_TYPE,
])

export function makePrologueDisplayDef(variant: PrologueVariant): DisplayDef {
  return {
    params: PARAMS,
    formatParam,
    menuParams: PARAMS.filter(
      (p) => p.kind === 'menu' || (variant === 8 && TIMBRE_SWITCH_MENU.has(p.id)),
    ),
    motionParamIds: MOTION_PARAM_IDS, // virtual targets only (spec §10)
    motionParamLabel,
    transport: 'arp',
    voiceMode: { id: TIMBRE_BLOCKS[0].voiceMode, labels: VOICE_SHORT },
  }
}
