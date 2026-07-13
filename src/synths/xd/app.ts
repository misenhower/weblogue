/*
 * minilogue xd main-thread app: the shared shell (synths/app-common.ts)
 * plus everything xd-specific — defs, the Panel, and the MIDI handlers
 * that resolve engine-dependent CCs (multi engine / mod FX sub-params).
 */
import processorUrl from './processor.ts?worker&url'
import type { SynthApp, SynthAppOpts, SynthEntry } from '../def'
import type { ToEngine } from '../../shared/messages'
import type { ExtraGroup } from '../../ui/settings'
import { makeSynthApp } from '../app-common'
import { XD_PROFILES, XD_DEFAULT_PROFILE, setXdProfile } from './profiles'
import { XD_DEF } from './def'
import { Panel } from './panel'
import { XD_DISPLAY_DEF } from './display-def'
import { XD_SETTINGS_DEF } from './settings-def'
import { XD_DEBUG_DEF } from './debug-def'
import { decodeCc } from './cc'
import { resolveMidiParam } from './resolve'
import { P } from './params'
import { MOTION_PITCH_BEND } from '../../shared/paramdef'

const PROFILE_KEY = 'weblogue-xd-calib-profile'

/**
 * CALIBRATION > PROFILE drawer row: switches the versioned calibration
 * profile (profiles.ts) in BOTH realms — this thread for display curves, the
 * worklet via {t:'calibProfile'} (Engine.setCalibProfile re-applies all
 * params). The choice persists like the other UI settings; `send` is the
 * pre-boot-buffered sender, so restoring it before the worklet exists is fine.
 */
function calibProfileGroup(send: (m: ToEngine) => void): ExtraGroup {
  const apply = (i: number): void => {
    setXdProfile(XD_PROFILES[i].id)
    send({ t: 'calibProfile', id: XD_PROFILES[i].id })
  }
  let saved: string | null = null
  try {
    saved = localStorage.getItem(PROFILE_KEY)
  } catch {
    // storage blocked (private mode): run on the default, picks don't persist
  }
  // a persisted id that no longer exists (e.g. the dropped dev-era v2-v4)
  // falls back to the DEFAULT profile, never to index 0
  let cur = XD_PROFILES.findIndex((p) => p.id === saved)
  if (cur < 0) cur = Math.max(0, XD_PROFILES.findIndex((p) => p.id === XD_DEFAULT_PROFILE))
  if (XD_PROFILES[cur].id !== XD_DEFAULT_PROFILE) apply(cur)
  return {
    title: 'CALIBRATION',
    rows: [
      {
        label: 'PROFILE',
        get: () => cur,
        set: (v) => {
          if (!XD_PROFILES[v] || v === cur) return
          cur = v
          apply(v)
          try {
            localStorage.setItem(PROFILE_KEY, XD_PROFILES[v].id)
          } catch {
            // storage blocked: the switch still applies for this session
          }
        },
        options: () => XD_PROFILES.map((p, i) => ({ label: p.name, value: i, selected: i === cur })),
        fmt: (v) => XD_PROFILES[v]?.name ?? '?',
      },
    ],
  }
}

export function buildXdApp(opts: SynthAppOpts): SynthApp {
  return makeSynthApp({
    def: XD_DEF,
    opts,
    buildPanel: (store, cb) =>
      new Panel({
        store,
        onNoteOn: cb.onNoteOn,
        onNoteOff: cb.onNoteOff,
        onBend: (v) => {
          cb.onBend(v)
          store.recKnob(MOTION_PITCH_BEND, v) // gates on rec mode/playing internally
        },
        onJoyY: cb.onJoyY,
        onMaster: cb.onMaster,
      }),
    displayDef: XD_DISPLAY_DEF,
    settingsDef: { ...XD_SETTINGS_DEF, extras: [calibProfileGroup(opts.send)] },
    debugDef: XD_DEBUG_DEF,
    midiHandlers: ({ send, store, midiActivity }) => ({
      sustain: (on) => send({ t: 'sustain', on }),
      param: (id, v) => {
        midiActivity()
        const r = resolveMidiParam(id, v, store.getParam(P.MULTI_TYPE), store.getParam(P.MODFX_TYPE))
        if (r) store.setParam(r.id, r.v, 'midi')
      },
      channelPressure: (v) => {
        midiActivity()
        send({ t: 'pressure', v })
      },
      joyY: (v) => send({ t: 'joyY', v }),
      joyYMinus: (v) => send({ t: 'joyY', v: -v }),
      decodeCc,
    }),
    fitWidth: 1456, // panel logical width 1440
    scaleVar: '--xd-scale',
    keyboardOctaveParamId: P.OCTAVE,
  })
}

export const XD_ENTRY: SynthEntry = {
  def: XD_DEF,
  processorUrl,
  buildApp: buildXdApp,
}
