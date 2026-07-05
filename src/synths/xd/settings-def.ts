/*
 * minilogue xd settings-drawer layout — every kind:'menu' param from the
 * table (synths/xd/params.ts), grouped the way the manual's PROGRAM EDIT
 * chapters do. The SEQUENCER and MOTION groups are appended by the drawer
 * itself (transport 'seq'). Coverage is guarded by tests/settings.test.ts.
 */
import type { SettingsDef } from '../../ui/settings'
import { P } from './params'

export const XD_SETTINGS_DEF: SettingsDef = {
  tabs: [
    {
      title: 'PROGRAM',
      groups: [
        {
          title: 'KEYBOARD & PITCH',
          ids: [P.OCTAVE, P.PROGRAM_TRANSPOSE, P.PORTAMENTO, P.PORTAMENTO_MODE, P.PORTAMENTO_BPM],
        },
        {
          title: 'PROGRAM',
          ids: [P.PROGRAM_LEVEL, P.PROGRAM_TUNING, P.MICRO_TUNING, P.SCALE_KEY],
        },
        {
          title: 'ARPEGGIATOR',
          ids: [P.ARP_RATE, P.ARP_GATE],
        },
        {
          title: 'JOYSTICK & MOD',
          ids: [
            P.BEND_RANGE_PLUS,
            P.BEND_RANGE_MINUS,
            P.JOY_ASSIGN_PLUS,
            P.JOY_RANGE_PLUS,
            P.JOY_ASSIGN_MINUS,
            P.JOY_RANGE_MINUS,
            P.MIDI_AT_ASSIGN,
          ],
        },
        {
          title: 'LFO',
          ids: [P.LFO_KEY_SYNC, P.LFO_VOICE_SYNC, P.LFO_TARGET_OSC],
        },
        {
          title: 'ENVELOPES',
          ids: [P.EG_VELOCITY, P.AMP_VELOCITY, P.EG_LEGATO],
        },
        {
          title: 'MULTI ENGINE',
          ids: [
            P.MULTI_ROUTING,
            P.VPM_FEEDBACK,
            P.VPM_NOISE_DEPTH,
            P.VPM_SHAPE_MOD_INT,
            P.VPM_MOD_ATTACK,
            P.VPM_MOD_DECAY,
            P.VPM_KEY_TRACK,
          ],
        },
      ],
    },
  ],
}
