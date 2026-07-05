/*
 * Original minilogue main-thread app: the shared shell (synths/app-common.ts)
 * plus everything OG-specific — defs, the Panel, and the OG's simpler MIDI
 * handlers (mirrors synths/xd/app.ts).
 *
 * SERVICE MODE: the drawer is the generic ui/debugpanel.ts over OG_DEBUG_DEF
 * (synths/og/debug-def.ts) — the OG engine records the same 12-ring dbg
 * layout as the xd, with NOISE in the third voice tap and the delay as the
 * only FX stage.
 */
import processorUrl from './processor.ts?worker&url'
import type { SynthApp, SynthAppOpts, SynthEntry } from '../def'
import { makeSynthApp } from '../app-common'
import { OG_DEF } from './def'
import { Panel } from './panel'
import { OG_DISPLAY_DEF } from './display-def'
import { OG_DEBUG_DEF } from './debug-def'
import { OG_SETTINGS_DEF } from './settings-def'
import { decodeCc } from './cc'
import { P } from './params'

export function buildOgApp(opts: SynthAppOpts): SynthApp {
  return makeSynthApp({
    def: OG_DEF,
    opts,
    buildPanel: (store, cb) =>
      new Panel({
        store,
        onNoteOn: cb.onNoteOn,
        onNoteOff: cb.onNoteOff,
        // The panel routes the slider itself: PITCH BEND assignment -> onBend
        // (spring), any other destination -> onJoyY (hold). Motion recording of
        // the slider happens inside the panel.
        onBend: cb.onBend,
        onJoyY: cb.onJoyY,
        onMaster: cb.onMaster,
      }),
    displayDef: OG_DISPLAY_DEF,
    debugDef: OG_DEBUG_DEF,
    settingsDef: OG_SETTINGS_DEF,
    midiHandlers: ({ send, store, midiActivity }) => ({
      sustain: (on) => send({ t: 'sustain', on }), // rx UNCONFIRMED on hardware (spec §16)
      param: (id, v) => {
        midiActivity()
        store.setParam(id, v, 'midi') // no engine-dependent sentinels on the OG
      },
      channelPressure: () => {}, // the OG has no aftertouch
      joyY: () => {}, // CC1/CC2 are unmapped on the OG (rev 1.10 map)
      joyYMinus: () => {},
      decodeCc,
    }),
    fitWidth: 1516, // panel logical width 1500; see synths/og/panel.ts
    scaleVar: '--og-scale',
    keyboardOctaveParamId: P.OCTAVE,
  })
}

export const OG_ENTRY: SynthEntry = {
  def: OG_DEF,
  processorUrl,
  buildApp: buildOgApp,
}
