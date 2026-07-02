/*
 * App bootstrap: builds the UI, boots the AudioWorklet engine on the power-on
 * gesture, and wires store <-> engine <-> panel <-> display <-> MIDI.
 */
import './ui/theme.css'
import './ui/kbd.css'
import './ui/panel.css'
import './ui/display.css'
import processorUrl from './dsp/processor.ts?worker&url'
import { Store } from './state/store'
import { FACTORY_PRESETS } from './state/presets'
import { Panel } from './ui/panel'
import { Display } from './ui/display'
import { attachComputerKeyboard } from './ui/keyboard'
import {
  MidiInput,
  CC_ID_MULTI_SHAPE,
  CC_ID_MULTI_SHIFT_SHAPE,
  CC_ID_MULTI_SUB,
  CC_ID_MODFX_SUB,
} from './midi/midi'
import { P, clampParam } from './shared/params'
import { PROCESSOR_NAME } from './shared/messages'
import type { FromEngine, ToEngine } from './shared/messages'

const app = document.getElementById('app')!

// --- Engine connection (buffered until the worklet is up) ---------------
let node: AudioWorkletNode | null = null
let ctx: AudioContext | null = null
let masterGain: GainNode | null = null
let analyser: AnalyserNode | null = null
const pending: ToEngine[] = []

function send(msg: ToEngine): void {
  if (node) node.port.postMessage(msg)
  else pending.push(msg)
}

// --- State + UI ----------------------------------------------------------
const store = new Store(FACTORY_PRESETS)

const panel = new Panel({
  store,
  onNoteOn: (note, vel) => send({ t: 'noteOn', note, vel }),
  onNoteOff: (note) => send({ t: 'noteOff', note }),
  onBend: (v) => send({ t: 'bend', v }),
  onJoyY: (v) => send({ t: 'joyY', v }),
  onMaster: (v) => {
    if (masterGain) masterGain.gain.value = v * v // audio taper
  },
})
const display = new Display({ store })
panel.displaySlot.appendChild(display.el)
app.appendChild(panel.el)

store.connect(send)

// Computer keyboard -> keybed; z/x octave keys write back to the param.
attachComputerKeyboard(panel.keyboard)
panel.keyboard.onOctaveShift = (o) => store.setParam(P.OCTAVE, o + 2)

// Responsive scale (panel logical width 1440).
function fitPanel(): void {
  const s = Math.min(1, (window.innerWidth - 16) / 1456)
  panel.el.style.setProperty('--xd-scale', String(s))
}
window.addEventListener('resize', fitPanel)
fitPanel()

// --- Power-on overlay (audio needs a user gesture) -----------------------
const overlay = document.createElement('div')
overlay.className = 'xd-power-overlay'
overlay.innerHTML = `<button class="xd-power-btn"><span></span>POWER ON</button>`
const style = document.createElement('style')
style.textContent = `
.xd-power-overlay{position:fixed;inset:0;background:rgba(10,10,12,.82);display:flex;align-items:center;justify-content:center;z-index:99;backdrop-filter:blur(3px)}
.xd-power-btn{font:600 15px/1 Futura,'Century Gothic',system-ui;letter-spacing:.18em;color:var(--xd-legend,#d8d8dc);background:#1c1c20;border:1px solid #55555c;border-radius:8px;padding:18px 34px;cursor:pointer;display:flex;align-items:center;gap:12px}
.xd-power-btn span{width:10px;height:10px;border-radius:50%;background:#3a3a40;box-shadow:0 0 2px #000 inset}
.xd-power-btn:hover span{background:var(--xd-led-white,#f5eedb);box-shadow:0 0 8px var(--xd-led-white,#f5eedb)}
`
document.head.appendChild(style)
app.appendChild(overlay)

async function powerOn(): Promise<void> {
  overlay.remove()
  ctx = new AudioContext({ latencyHint: 'interactive' })
  await ctx.audioWorklet.addModule(processorUrl)
  node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  })
  masterGain = ctx.createGain()
  masterGain.gain.value = 0.64 // master knob default 0.8, squared taper
  analyser = ctx.createAnalyser()
  analyser.fftSize = 2048
  node.connect(masterGain)
  masterGain.connect(analyser)
  analyser.connect(ctx.destination)

  node.port.onmessage = (e: MessageEvent) => {
    const m = e.data as FromEngine
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
      case 'level':
        break
    }
  }

  // Flush everything queued before power-on (includes the program load that
  // store.connect() emitted), then enable the scope stream.
  for (const m of pending) node.port.postMessage(m)
  pending.length = 0
  send({ t: 'scope', on: true })
  await ctx.resume()
  void initMidi()
}
overlay.querySelector('button')!.addEventListener('click', () => void powerOn())

// --- MIDI ----------------------------------------------------------------
function midiActivity(): void {
  panel.flashMidi()
  display.setMidiActive(true)
}

/** Resolve engine-dependent sentinel CC ids to concrete params. */
function resolveMidiParam(id: number, v: number): { id: number; v: number } | null {
  if (id >= 0) return { id, v }
  const multiType = store.getParam(P.MULTI_TYPE)
  switch (id) {
    case CC_ID_MULTI_SHAPE:
      return { id: [P.SHAPE_NOISE, P.SHAPE_VPM, P.SHAPE_USER][multiType], v }
    case CC_ID_MULTI_SHIFT_SHAPE:
      return { id: [P.SHIFTSHAPE_NOISE, P.SHIFTSHAPE_VPM, P.SHIFTSHAPE_USER][multiType], v }
    case CC_ID_MULTI_SUB: {
      const pid = [P.SELECT_NOISE, P.SELECT_VPM, P.SELECT_USER][multiType]
      return { id: pid, v: clampParam(pid, v) }
    }
    case CC_ID_MODFX_SUB: {
      const type = store.getParam(P.MODFX_TYPE)
      const pid = [
        P.MODFX_SUB_CHORUS,
        P.MODFX_SUB_ENSEMBLE,
        P.MODFX_SUB_PHASER,
        P.MODFX_SUB_FLANGER,
        P.MODFX_SUB_USER,
      ][type]
      const zones = [8, 3, 8, 8, 2][type]
      return { id: pid, v: Math.min(zones - 1, Math.floor((v * zones) / 128)) }
    }
    default:
      return null
  }
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
    bend: (v) => send({ t: 'bend', v }),
    sustain: (on) => send({ t: 'sustain', on }),
    param: (id, v) => {
      midiActivity()
      const r = resolveMidiParam(id, v)
      if (r) store.setParam(r.id, r.v, 'midi')
    },
    channelPressure: () => {},
    programChange: (bankLsb, prog) => {
      const slot = bankLsb * 100 + prog
      if (slot >= 0 && slot < 500) store.loadSlot(slot)
    },
    connectionChange: () => {},
    joyY: (v) => send({ t: 'joyY', v }),
    joyYMinus: (v) => send({ t: 'joyY', v: -v }),
    panic: () => send({ t: 'allNotesOff' }),
  })
  await midi.init()
}

// --- Debug hook for automated verification -------------------------------
;(window as any).__xdDebug = {
  rms(): number {
    if (!analyser) return -1
    const buf = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
    return Math.sqrt(sum / buf.length)
  },
  contextState: () => (ctx ? ctx.state : 'none'),
  powerOn: () => powerOn(),
  noteOn: (note: number, vel = 100) => send({ t: 'noteOn', note, vel }),
  noteOff: (note: number) => send({ t: 'noteOff', note }),
  store,
}
