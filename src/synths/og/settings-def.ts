/*
 * Original minilogue settings-drawer layout — every kind:'menu' param from
 * the table (synths/og/params.ts), grouped along the manual's PROGRAM EDIT
 * chapters. The SEQUENCER and MOTION groups are appended by the drawer
 * itself (transport 'seq'), so they are deliberately absent here.
 */
import type { SettingsDef } from '../../ui/settings'
import { P } from './params'

export const OG_SETTINGS_DEF: SettingsDef = {
  tabs: [
    {
      title: 'PROGRAM',
      groups: [
        {
          title: 'KEYBOARD & PITCH',
          ids: [P.OCTAVE, P.PORTAMENTO, P.PORTAMENTO_MODE, P.PORTAMENTO_BPM],
        },
        {
          title: 'PROGRAM',
          ids: [P.PROGRAM_LEVEL, P.AMP_VELOCITY],
        },
        {
          title: 'SLIDER & BEND',
          ids: [P.BEND_RANGE_PLUS, P.BEND_RANGE_MINUS, P.SLIDER_ASSIGN, P.SLIDER_RANGE],
        },
        {
          title: 'LFO',
          ids: [P.LFO_KEY_SYNC, P.LFO_BPM_SYNC, P.LFO_VOICE_SYNC],
        },
      ],
    },
  ],
}
