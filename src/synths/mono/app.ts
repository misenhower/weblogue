/*
 * Korg monologue main-thread app: the shared shell (synths/app-common.ts)
 * plus everything monologue-specific — defs, the Panel, and the simple
 * 7-bit MIDI handlers (mirrors synths/og/app.ts).
 */
import processorUrl from './processor.ts?worker&url'
import type { SynthApp, SynthAppOpts, SynthEntry } from '../def'
import { makeSynthApp } from '../app-common'
import { MONO_DEF } from './def'
import { Panel } from './panel'
import { MONO_DISPLAY_DEF } from './display-def'
import { MONO_SETTINGS_DEF } from './settings-def'
import { MONO_DEBUG_DEF } from './debug-def'
import { decodeCc } from './cc'
import { P } from './params'

export function buildMonoApp(opts: SynthAppOpts): SynthApp {
  return makeSynthApp({
    def: MONO_DEF,
    opts,
    buildPanel: (store, cb) =>
      new Panel({
        store,
        onNoteOn: cb.onNoteOn,
        onNoteOff: cb.onNoteOff,
        // The panel routes the slider itself: PITCH BEND assignment -> onBend
        // (spring), any other destination -> onJoyY (hold); slider motion
        // recording happens inside the panel (og pattern).
        onBend: cb.onBend,
        onJoyY: cb.onJoyY,
        onMaster: cb.onMaster,
      }),
    displayDef: MONO_DISPLAY_DEF,
    settingsDef: MONO_SETTINGS_DEF,
    debugDef: MONO_DEBUG_DEF,
    midiHandlers: ({ send, store, midiActivity }) => ({
      sustain: (on) => send({ t: 'sustain', on }), // rx UNCONFIRMED (no damper input; spec §16)
      param: (id, v) => {
        midiActivity()
        store.setParam(id, v, 'midi') // plain 7-bit map, no sentinels
      },
      channelPressure: () => {}, // no aftertouch
      joyY: () => {}, // CC1/CC2 unmapped on the monologue (rev 1.00 map)
      joyYMinus: () => {},
      decodeCc,
    }),
    fitWidth: 1176, // panel logical width 1160; see synths/mono/panel.ts
    scaleVar: '--mono-scale',
    keyboardOctaveParamId: P.OCTAVE,
  })
}

export const MONO_ENTRY: SynthEntry = {
  def: MONO_DEF,
  processorUrl,
  buildApp: buildMonoApp,
}
