/*
 * minilogue xd DisplayDef — the OLED's synth-specific surface: param table +
 * formatter, PROG EDIT menu pages, motion-assign cycle, and the status-line
 * voice-mode readout. Hoisted out of src/ui/display.ts so the display can be
 * reused by other synth definitions.
 */
import type { DisplayDef } from '../../ui/display'
import { PARAMS, formatParam, motionParamLabel, MOTION_PARAM_IDS, P } from './params'

/** Status-line short names, VOICE MODE enum order (ARP, CHORD, UNISON, POLY). */
const VOICE_SHORT = ['ARP', 'CHD', 'UNI', 'POLY'] as const

export const XD_DISPLAY_DEF: DisplayDef = {
  params: PARAMS,
  formatParam,
  /* PROG EDIT pages: every menu-kind param, table order (joystick assigns,
   * microtuning, VPM params, ... — see synths/xd/params.ts). */
  menuParams: PARAMS.filter((p) => p.kind === 'menu'),
  motionParamIds: MOTION_PARAM_IDS,
  motionParamLabel,
  voiceMode: { id: P.VOICE_MODE, labels: VOICE_SHORT },
}
