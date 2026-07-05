/*
 * minilogue xd main-thread app: the shared shell (synths/app-common.ts)
 * plus everything xd-specific — defs, the Panel, and the MIDI handlers
 * that resolve engine-dependent CCs (multi engine / mod FX sub-params).
 */
import processorUrl from './processor.ts?worker&url'
import type { SynthApp, SynthAppOpts, SynthEntry } from '../def'
import { makeSynthApp } from '../app-common'
import { XD_DEF } from './def'
import { Panel } from './panel'
import { XD_DISPLAY_DEF } from './display-def'
import { XD_SETTINGS_DEF } from './settings-def'
import { XD_DEBUG_DEF } from './debug-def'
import { decodeCc } from './cc'
import { resolveMidiParam } from './resolve'
import { P } from './params'
import { MOTION_PITCH_BEND } from '../../shared/paramdef'

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
    settingsDef: XD_SETTINGS_DEF,
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
