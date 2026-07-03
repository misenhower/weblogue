/*
 * minilogue xd main-thread app: store + panel + display + SERVICE MODE +
 * computer keyboard + MIDI wiring. Built by the generic bootstrap (main.ts)
 * through the registry; everything xd-specific that used to live in main.ts
 * lives here.
 */
import processorUrl from './processor.ts?worker&url'
import type { SynthApp, SynthAppOpts, SynthEntry } from '../def'
import type { FromEngine } from '../../shared/messages'
import { Store } from '../../state/store'
import { XD_DEF } from './def'
import { Panel } from './panel'
import { Display } from '../../ui/display'
import { XD_DISPLAY_DEF } from './display-def'
import { DebugPanel } from '../../ui/debugpanel'
import { attachComputerKeyboard } from '../../ui/keyboard'
import { MidiInput } from '../../midi/midi'
import { decodeCc } from './cc'
import { resolveMidiParam } from './resolve'
import { P } from './params'
import { MOTION_PITCH_BEND } from '../../shared/paramdef'

export function buildXdApp(opts: SynthAppOpts): SynthApp {
  const { send } = opts
  const root = document.createElement('div')
  const store = new Store(XD_DEF)

  const panel = new Panel({
    store,
    onNoteOn: (note, vel) => send({ t: 'noteOn', note, vel }),
    onNoteOff: (note) => send({ t: 'noteOff', note }),
    onBend: (v) => {
      send({ t: 'bend', v })
      store.recKnob(MOTION_PITCH_BEND, v) // gates on rec mode/playing internally
    },
    onJoyY: (v) => send({ t: 'joyY', v }),
    onMaster: (v) => opts.onMaster(v),
  })
  const display = new Display({ store, def: XD_DISPLAY_DEF })
  panel.displaySlot.appendChild(display.el)
  root.appendChild(panel.el)

  store.connect(send)

  // Computer keyboard -> keybed; z/x octave keys write back to the param.
  attachComputerKeyboard(panel.keyboard)
  panel.keyboard.onOctaveShift = (o) => store.setParam(P.OCTAVE, o + 2)

  // --- SERVICE MODE (debug drawer): ` key or the corner chip -------------
  let debugPanel: DebugPanel | null = null
  let debugOpen = false

  const svcChip = document.createElement('button')
  svcChip.className = 'xd-svc-chip'
  svcChip.textContent = 'SERVICE'
  svcChip.addEventListener('click', () => toggleDebug())
  root.appendChild(svcChip)

  function toggleDebug(on = !debugOpen): void {
    if (on === debugOpen) return
    debugOpen = on
    if (on) {
      if (!debugPanel) {
        debugPanel = new DebugPanel({ store })
        debugPanel.onClose = () => toggleDebug(false)
        debugPanel.onVoicesMode = (all) => {
          if (debugOpen) send({ t: 'debug', on: true, all })
        }
      }
      if (sampleRate > 0) debugPanel.sampleRate = sampleRate
      root.appendChild(debugPanel.el)
      svcChip.style.display = 'none'
    } else if (debugPanel) {
      debugPanel.el.remove()
      svcChip.style.display = ''
    }
    send({ t: 'debug', on, all: debugPanel?.voicesAll ?? false })
  }
  let sampleRate = 0

  window.addEventListener('keydown', (e) => {
    if (e.key !== '`' || e.repeat) return
    const t = document.activeElement
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return
    toggleDebug()
  })

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
      programChange: (bankLsb, prog) => {
        const slot = bankLsb * 100 + prog
        if (slot >= 0 && slot < XD_DEF.numSlots) store.loadSlot(slot)
      },
      connectionChange: () => {},
      joyY: (v) => send({ t: 'joyY', v }),
      joyYMinus: (v) => send({ t: 'joyY', v: -v }),
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
          debugPanel?.update(m)
          break
      }
    },
    initMidi,
    setSampleRate(sr: number): void {
      sampleRate = sr
      if (debugPanel) debugPanel.sampleRate = sr
    },
    fit(): void {
      // Responsive scale (panel logical width 1440).
      const s = Math.min(1, (window.innerWidth - 16) / 1456)
      panel.el.style.setProperty('--xd-scale', String(s))
    },
  }
}

export const XD_ENTRY: SynthEntry = {
  def: XD_DEF,
  processorUrl,
  buildApp: buildXdApp,
}
