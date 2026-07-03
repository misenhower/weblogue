/*
 * Shared main-thread app shell — everything a synth app needs that is not
 * synth-specific: Store construction, Display wiring, the SERVICE MODE
 * drawer (` key + corner chip, lazy DebugPanel), computer-keyboard hookup,
 * engine message fan-out, MIDI plumbing and the responsive fit scaffold.
 *
 * A synth's app.ts (synths/<id>/app.ts) supplies the per-synth pieces via
 * SynthAppConfig: its defs, a panel factory, the MIDI handlers that differ
 * between synths, and the fit geometry. The handlers that are identical on
 * every synth (notes, pitch bend + motion recording, program change, panic)
 * live here.
 */
import type { SynthApp, SynthAppOpts, SynthDef } from './def'
import type { FromEngine, ToEngine } from '../shared/messages'
import { Store } from '../state/store'
import { Display, type DisplayDef } from '../ui/display'
import { DebugPanel, type DebugDef } from '../ui/debugpanel'
import { attachComputerKeyboard, type Keyboard } from '../ui/keyboard'
import { MidiInput, type MidiHandlers } from '../midi/midi'
import { MOTION_PITCH_BEND } from '../shared/paramdef'

/** What the shell needs from a synth's Panel (both Panels satisfy this). */
export interface SynthPanel {
  el: HTMLElement
  displaySlot: HTMLElement
  keyboard: Keyboard
  setPlayhead(i: number): void
  setVoices(notes: number[]): void
  flashMidi(): void
}

/**
 * Engine callbacks the shell hands to buildPanel. onBend only sends — a
 * synth wraps it if its panel bend should also record motion (the xd does;
 * the og's panel records slider motion itself).
 */
export interface SynthPanelCallbacks {
  onNoteOn(note: number, vel: number): void
  onNoteOff(note: number): void
  onBend(v: number): void
  onJoyY(v: number): void
  onMaster(v: number): void
}

/** Context handed to the per-synth MIDI handler factory. */
export interface SynthMidiCtx {
  send(msg: ToEngine): void
  store: Store
  /** Flash the panel MIDI LED + display badge. */
  midiActivity(): void
}

/**
 * The MidiInput handlers that differ per synth. The rest (noteOn/noteOff,
 * bend, programChange, connectionChange, panic) is shared wiring below.
 */
export type SynthMidiHooks = Pick<
  MidiHandlers,
  'sustain' | 'param' | 'channelPressure' | 'joyY' | 'joyYMinus' | 'decodeCc'
>

export interface SynthAppConfig {
  def: SynthDef
  opts: SynthAppOpts
  buildPanel(store: Store, callbacks: SynthPanelCallbacks): SynthPanel
  displayDef: DisplayDef
  debugDef: DebugDef
  midiHandlers(ctx: SynthMidiCtx): SynthMidiHooks
  /** Window width at which the panel reaches scale 1 (logical width + margin). */
  fitWidth: number
  /** CSS custom property carrying the responsive scale (e.g. '--xd-scale'). */
  scaleVar: string
  /** Param id the keyboard's z/x octave shift writes back to. */
  keyboardOctaveParamId: number
}

export function makeSynthApp(cfg: SynthAppConfig): SynthApp {
  const { send } = cfg.opts
  const root = document.createElement('div')
  const store = new Store(cfg.def)

  const panel = cfg.buildPanel(store, {
    onNoteOn: (note, vel) => send({ t: 'noteOn', note, vel }),
    onNoteOff: (note) => send({ t: 'noteOff', note }),
    onBend: (v) => send({ t: 'bend', v }),
    onJoyY: (v) => send({ t: 'joyY', v }),
    onMaster: (v) => cfg.opts.onMaster(v),
  })
  const display = new Display({ store, def: cfg.displayDef })
  panel.displaySlot.appendChild(display.el)
  root.appendChild(panel.el)

  store.connect(send)

  // Computer keyboard -> keybed; z/x octave keys write back to the param.
  attachComputerKeyboard(panel.keyboard)
  panel.keyboard.onOctaveShift = (o) => store.setParam(cfg.keyboardOctaveParamId, o + 2)

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
        debugPanel = new DebugPanel({ store, def: cfg.debugDef })
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
      programChange: (bankLsb, prog) => {
        const slot = bankLsb * 100 + prog
        if (slot >= 0 && slot < cfg.def.numSlots) store.loadSlot(slot)
      },
      connectionChange: () => {},
      panic: () => send({ t: 'allNotesOff' }),
      ...cfg.midiHandlers({ send, store, midiActivity }),
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
      // Responsive scale against the synth's logical panel width.
      const s = Math.min(1, (window.innerWidth - 16) / cfg.fitWidth)
      panel.el.style.setProperty(cfg.scaleVar, String(s))
    },
  }
}
