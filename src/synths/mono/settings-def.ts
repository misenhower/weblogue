/*
 * monologue settings-drawer layout — every kind:'menu' param from the table
 * (synths/mono/params.ts), grouped along the manual's menu-param chapter
 * (docs/monologue-spec.md §11). The SEQUENCER and MOTION groups are appended
 * by the drawer itself (transport 'seq').
 *
 * Two params the OLED menu deliberately hides (display-def.ts MENU_EXCLUDED)
 * ARE included here: VCO1 OCTAVE (program data + rx-only CC48, otherwise
 * unreachable in the replica — the drawer closes that gap) and KBD OCTAVE
 * (a dedicated panel switch on hardware).
 */
import type { SettingsDef } from '../../ui/settings'
import { P } from './params'

export const MONO_SETTINGS_DEF: SettingsDef = {
  tabs: [
    {
      title: 'PROGRAM',
      groups: [
        {
          title: 'OSCILLATOR',
          ids: [P.VCO1_OCTAVE],
        },
        {
          title: 'KEYBOARD',
          ids: [P.OCTAVE, P.PORTAMENTO, P.PORTAMENTO_MODE, P.SLIDE_TIME],
        },
        {
          title: 'LFO',
          ids: [P.LFO_BPM_SYNC],
        },
        {
          title: 'VELOCITY & TRACKING',
          ids: [P.CUTOFF_VELOCITY, P.CUTOFF_KEYTRACK, P.AMP_VELOCITY],
        },
        {
          title: 'PROGRAM',
          ids: [P.PROGRAM_LEVEL, P.PROGRAM_TUNING, P.MICRO_TUNING, P.SCALE_KEY],
        },
        {
          title: 'BEND & SLIDER',
          ids: [P.BEND_RANGE_PLUS, P.BEND_RANGE_MINUS, P.SLIDER_ASSIGN, P.SLIDER_RANGE],
        },
      ],
    },
  ],
}
