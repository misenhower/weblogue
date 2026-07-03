/*
 * Original minilogue main-thread app: store + panel + display + computer
 * keyboard + MIDI wiring, built by the generic bootstrap through the
 * registry (mirrors synths/xd/app.ts).
 *
 * Known gap vs the xd app: no SERVICE MODE drawer yet — the OG engine
 * records the same debug taps, but ui/debugpanel.ts is still xd-flavored
 * (xd param ids in its modulator readouts); wiring it here would misread
 * the OG program. Documented residue, revisit with the debug-panel
 * genericization.
 */
import processorUrl from './processor.ts?worker&url'
import type { SynthApp, SynthAppOpts, SynthEntry } from '../def'
import type { FromEngine } from '../../shared/messages'
import { Store } from '../../state/store'
import { OG_DEF } from './def'
import { Panel } from './panel'
import { Display } from '../../ui/display'
import { OG_DISPLAY_DEF } from './display-def'
import { attachComputerKeyboard } from '../../ui/keyboard'
import { MidiInput } from '../../midi/midi'
import { decodeCc } from './cc'
import { P } from './params'
import { MOTION_PITCH_BEND } from '../../shared/paramdef'

export function buildOgApp(opts: SynthAppOpts): SynthApp {
  const { send } = opts
  const root = document.createElement('div')
  const store = new Store(OG_DEF)

  const panel = new Panel({
    store,
    onNoteOn: (note, vel) => send({ t: 'noteOn', note, vel }),
    onNoteOff: (note) => send({ t: 'noteOff', note }),
    // The panel routes the slider itself: PITCH BEND assignment -> onBend
    // (spring), any other destination -> onJoyY (hold). Motion recording of
    // the slider happens inside the panel.
    onBend: (v) => send({ t: 'bend', v }),
    onJoyY: (v) => send({ t: 'joyY', v }),
    onMaster: (v) => opts.onMaster(v),
  })
  const display = new Display({ store, def: OG_DISPLAY_DEF })
  panel.displaySlot.appendChild(display.el)
  root.appendChild(panel.el)

  store.connect(send)

  // Computer keyboard -> keybed; z/x octave keys write back to the param.
  attachComputerKeyboard(panel.keyboard)
  panel.keyboard.onOctaveShift = (o) => store.setParam(P.OCTAVE, o + 2)

  // --- MIDI ---------------------------------------------------------------
  function midiActivity(): void {
    panel.flashMidi()
    display.setMidiActive(true)
  }

  async function initMidi(): Promise<void> {
    const midi = new MidiInput({
      noteOn: (note, vel) => {
        midiActivity()
        send({ t: 'noteOn', note, vel })
        store.recNoteOn(note, vel)
      },
      noteOff: (note) => {
        send({ t: 'noteOff', note })
        store.recNoteOff(note)
      },
      bend: (v) => {
        send({ t: 'bend', v })
        store.recKnob(MOTION_PITCH_BEND, v) // gates on rec mode/playing internally
      },
      sustain: (on) => send({ t: 'sustain', on }), // rx UNCONFIRMED on hardware (spec §16)
      param: (id, v) => {
        midiActivity()
        store.setParam(id, v, 'midi') // no engine-dependent sentinels on the OG
      },
      channelPressure: () => {}, // the OG has no aftertouch
      programChange: (bankLsb, prog) => {
        const slot = bankLsb * 100 + prog
        if (slot >= 0 && slot < OG_DEF.numSlots) store.loadSlot(slot)
      },
      connectionChange: () => {},
      joyY: () => {}, // CC1/CC2 are unmapped on the OG (rev 1.10 map)
      joyYMinus: () => {},
      panic: () => send({ t: 'allNotesOff' }),
      decodeCc,
    })
    await midi.init()
  }

  return {
    el: root,
    store,
    onEngineMessage(m: FromEngine): void {
      switch (m.t) {
        case 'scope':
          display.scopeFrame(m.data)
          break
        case 'step':
          store.setPlayhead(m.i)
          panel.setPlayhead(m.i)
          break
        case 'voices':
          panel.setVoices(m.notes)
          break
        case 'dbg':
          break // no SERVICE MODE drawer yet (see header)
      }
    },
    initMidi,
    setSampleRate(): void {
      // Nothing to feed yet (SERVICE MODE drawer absent).
    },
    fit(): void {
      // Responsive scale (panel logical width 1500; see synths/og/panel.ts).
      const s = Math.min(1, (window.innerWidth - 16) / 1516)
      panel.el.style.setProperty('--og-scale', String(s))
    },
  }
}

export const OG_ENTRY: SynthEntry = {
  def: OG_DEF,
  processorUrl,
  buildApp: buildOgApp,
}
