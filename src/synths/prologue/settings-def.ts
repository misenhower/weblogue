/*
 * Korg prologue settings-drawer layout — every kind:'menu' param from the
 * table (synths/prologue/params.ts) exactly once, grouped the way the
 * manual's PROGRAM EDIT chapters do, built per variant like display-def.
 *
 * Three tabs: GLOBAL (program-global menu params + the replica-only VOICE
 * CAP), then TIMBRE 1 / TIMBRE 2 (the per-timbre menu blocks, addressed
 * through TIMBRE_BLOCKS so the two tabs can't drift from the table).
 *
 * Variant difference (mirrors display-def's TIMBRE_SWITCH_MENU): the
 * prologue-8 has no TIMBRE panel section (spec §14), so its GLOBAL tab
 * additionally carries the switch-kind TIMBRE items (SUB ON, EDIT TIMBRE,
 * TIMBRE TYPE) — its only access to them. BALANCE is menu-kind, so it stays
 * on BOTH variants (the 16 also has a panel knob for it, like other
 * menu+panel duplicates).
 *
 * transport is 'arp': the drawer appends no SEQUENCER/MOTION groups — the
 * prologue has no step/motion sequencing (spec §10).
 */
import type { SettingsDef, SettingsGroup, SettingsTab } from '../../ui/settings'
import { P, RP, TIMBRE_BLOCKS, type TimbreParamIds } from './params'
import type { PrologueVariant } from './ids'

function timbreTab(title: string, t: TimbreParamIds): SettingsTab {
  return {
    title,
    groups: [
      {
        title: 'VOICE',
        ids: [t.portamento, t.voiceSpread],
      },
      {
        title: 'ENVELOPES',
        ids: [t.egVelocity, t.egLegato],
      },
      {
        title: 'LFO',
        ids: [t.lfoTargetOsc, t.lfoKeySync, t.lfoVoiceSync],
      },
      {
        title: 'WHEEL & AFTERTOUCH',
        ids: [t.wheelAssign, t.wheelRange, t.atAssign],
      },
      {
        title: 'PITCH BEND',
        ids: [t.bendRangePlus, t.bendRangeMinus],
      },
      {
        title: 'MULTI ENGINE',
        ids: [
          t.multiRouting,
          t.vpmFeedback,
          t.vpmNoiseDepth,
          t.vpmShapeModInt,
          t.vpmModAttack,
          t.vpmModDecay,
          t.vpmKeyTrack,
        ],
      },
    ],
  }
}

export function prologueSettingsDef(variant: PrologueVariant): SettingsDef {
  const mainSub: SettingsGroup = {
    title: 'MAIN/SUB',
    ids: [
      // The 8's only access to the TIMBRE switches (no panel section, spec §14).
      ...(variant === 8 ? [P.SUB_ON, P.EDIT_TIMBRE, P.TIMBRE_TYPE] : []),
      P.BALANCE,
      P.POSITION,
      P.SPLIT_POINT,
    ],
  }
  return {
    tabs: [
      {
        title: 'GLOBAL',
        groups: [
          mainSub,
          {
            title: 'KEYBOARD & PITCH',
            ids: [P.OCTAVE, P.PROGRAM_TRANSPOSE, P.PORTAMENTO_MODE],
          },
          {
            title: 'PROGRAM',
            ids: [P.PROGRAM_LEVEL, P.PROGRAM_TUNING, P.MICRO_TUNING, P.SCALE_KEY, P.AMP_VELOCITY],
          },
          {
            title: 'FX ROUTING',
            ids: [P.MODFX_ROUTING, P.DLRV_ROUTING],
          },
          {
            title: 'ARPEGGIATOR',
            ids: [P.ARP_TYPE, P.ARP_RANGE, P.ARP_RATE, P.ARP_GATE, P.ARP_TARGET],
          },
          {
            title: 'REPLICA',
            ids: [RP.VOICE_CAP],
          },
        ],
      },
      timbreTab('TIMBRE 1', TIMBRE_BLOCKS[0]),
      timbreTab('TIMBRE 2', TIMBRE_BLOCKS[1]),
    ],
  }
}
