/*
 * prologue main-thread apps: the shared shell (synths/app-common.ts) plus
 * everything prologue-specific, parameterized by variant (8 / 16). Incoming
 * CC1 maps to the mod wheel as a documented usability deviation — the
 * hardware wheel transmits its assigned destination's CC instead
 * (docs/prologue-spec.md §9).
 */
import processorUrl from './processor.ts?worker&url'
import type { SynthApp, SynthAppOpts, SynthEntry } from '../def'
import { makeSynthApp } from '../app-common'
import { makePrologueDef } from './def'
import { Panel } from './panel'
import { makePrologueDisplayDef } from './display-def'
import { makePrologueDebugDef } from './debug-def'
import { decodeCc } from './cc'
import { resolveMidiParam } from './resolve'
import { P, TIMBRE_BLOCKS } from './params'
import { type PrologueVariant, VARIANT_VOICES } from './ids'

const PANEL_FIT: Record<PrologueVariant, number> = { 8: 1566, 16: 1766 } // logical width + 16 margin

function buildApp(variant: PrologueVariant, opts: SynthAppOpts): SynthApp {
  const def = makePrologueDef(variant)
  return makeSynthApp({
    def,
    opts,
    buildPanel: (store, cb) =>
      new Panel({
        variant,
        store,
        onNoteOn: cb.onNoteOn,
        onNoteOff: cb.onNoteOff,
        onBend: cb.onBend, // pitch wheel (spring)
        onJoyY: cb.onJoyY, // mod wheel (unipolar hold)
        onMaster: cb.onMaster,
      }),
    displayDef: makePrologueDisplayDef(variant),
    debugDef: makePrologueDebugDef(VARIANT_VOICES[variant]),
    midiHandlers: ({ send, store, midiActivity }) => ({
      sustain: (on) => send({ t: 'sustain', on }),
      param: (id, v) => {
        midiActivity()
        const editTimbre = store.getParam(P.EDIT_TIMBRE)
        const t = TIMBRE_BLOCKS[Math.round(editTimbre) === 2 ? 1 : 0]
        const r = resolveMidiParam(
          id, v, editTimbre, store.getParam(t.multiType),
          store.getParam(P.MODFX_TYPE), store.getParam(P.DLRV_SELECT),
        )
        if (r) store.setParam(r.id, r.v, 'midi')
      },
      channelPressure: (v) => send({ t: 'pressure', v }), // FW2 MIDI aftertouch rx
      joyY: (v) => send({ t: 'joyY', v }), // CC1 -> mod wheel (replica deviation, spec §9)
      joyYMinus: () => {},
      decodeCc,
    }),
    fitWidth: PANEL_FIT[variant],
    scaleVar: '--prologue-scale',
    keyboardOctaveParamId: P.OCTAVE,
  })
}

export const PROLOGUE8_ENTRY: SynthEntry = {
  def: makePrologueDef(8),
  processorUrl,
  buildApp: (opts) => buildApp(8, opts),
}

export const PROLOGUE16_ENTRY: SynthEntry = {
  def: makePrologueDef(16),
  processorUrl,
  buildApp: (opts) => buildApp(16, opts),
}
