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
import { MidiInput } from './midi/midi'
import { resolveMidiParam } from './midi/resolve'
import { P, MOTION_PITCH_BEND } from './shared/params'
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

// MASTER knob level (panel default 0.8), tracked even before power-on so
// pre-boot knob moves are applied when the audio graph comes up.
let masterLevel = 0.8

const panel = new Panel({
  store,
  onNoteOn: (note, vel) => send({ t: 'noteOn', note, vel }),
  onNoteOff: (note) => send({ t: 'noteOff', note }),
  onBend: (v) => {
    send({ t: 'bend', v })
    store.recKnob(MOTION_PITCH_BEND, v) // gates on rec mode/playing internally
  },
  onJoyY: (v) => send({ t: 'joyY', v }),
  onMaster: (v) => {
    masterLevel = v
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
  masterGain.gain.value = masterLevel * masterLevel // squared audio taper
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
