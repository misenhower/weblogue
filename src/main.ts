/*
 * App bootstrap, synth-agnostic: picks a synth from the registry, builds its
 * app (store + panel + MIDI wiring live in synths/<id>/app.ts), boots the
 * AudioWorklet engine on the power-on gesture, and owns the page chrome
 * (synth selector, power overlay, output gain/analyser).
 */
import './ui/theme.css'
import './ui/kbd.css'
import './ui/panel.css'
import './ui/display.css'
import './ui/debug.css'
import './ui/shell.css'
import { SYNTHS, pickSynth, switchSynth } from './synths/registry'
import type { FromEngine, ToEngine } from './shared/messages'

const appRoot = document.getElementById('app')!
const entry = pickSynth()

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

// MASTER knob level (panel default 0.8), tracked even before power-on so
// pre-boot knob moves are applied when the audio graph comes up.
let masterLevel = 0.8

// --- Synth app (store + panel + display + MIDI) --------------------------
const app = entry.buildApp({
  send,
  onMaster: (v) => {
    masterLevel = v
    if (masterGain) masterGain.gain.value = v * v // audio taper
  },
})
appRoot.appendChild(app.el)

window.addEventListener('resize', () => app.fit())
app.fit()

// --- Synth selector (top-right chip row; switching reloads the page) -----
if (SYNTHS.length > 1) {
  const row = document.createElement('div')
  row.className = 'synth-picker'
  for (const s of SYNTHS) {
    const chip = document.createElement('button')
    chip.className = 'synth-chip' + (s.def.id === entry.def.id ? ' synth-chip-on' : '')
    chip.textContent = s.def.title
    if (s.def.id !== entry.def.id) chip.addEventListener('click', () => switchSynth(s.def.id))
    row.appendChild(chip)
  }
  appRoot.appendChild(row)
}

// --- Power-on overlay (audio needs a user gesture) -----------------------
const overlay = document.createElement('div')
overlay.className = 'xd-power-overlay'
overlay.innerHTML = `<button class="xd-power-btn"><span></span>POWER ON</button>`
appRoot.appendChild(overlay)

async function powerOn(): Promise<void> {
  if (ctx) return // already powered on (button + debug hook can race)
  overlay.remove()
  ctx = new AudioContext({ latencyHint: 'interactive' })
  await ctx.audioWorklet.addModule(entry.processorUrl)
  node = new AudioWorkletNode(ctx, entry.def.processorName, {
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
  app.setSampleRate(ctx.sampleRate)

  node.port.onmessage = (e: MessageEvent) => {
    app.onEngineMessage(e.data as FromEngine)
  }

  // Flush everything queued before power-on (includes the program load that
  // store.connect() emitted), then enable the scope stream.
  for (const m of pending) node.port.postMessage(m)
  pending.length = 0
  send({ t: 'scope', on: true })
  await ctx.resume()
  void app.initMidi()
}
overlay.querySelector('button')!.addEventListener('click', () => void powerOn())

// --- Debug hook for automated verification -------------------------------
const debugHook = {
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
  synthId: entry.def.id,
  store: app.store,
}
;(window as any).__synthDebug = debugHook
;(window as any).__xdDebug = debugHook // legacy alias (in-browser automation + docs)