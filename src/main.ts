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
  const pickerStyle = document.createElement('style')
  pickerStyle.textContent = `
.synth-picker{position:fixed;bottom:10px;left:12px;display:flex;gap:6px;z-index:60}
.synth-chip{font:600 11px/1 Futura,'Century Gothic',system-ui;letter-spacing:.12em;color:#9a9aa2;background:#1c1c20;border:1px solid #3a3a42;border-radius:6px;padding:7px 12px;cursor:pointer;text-transform:uppercase}
.synth-chip:hover{color:#d8d8dc;border-color:#55555c}
.synth-chip-on{color:#f5eedb;border-color:#6a6a72;cursor:default}
`
  document.head.appendChild(pickerStyle)
  appRoot.appendChild(row)
}

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
appRoot.appendChild(overlay)

async function powerOn(): Promise<void> {
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
  synthId: entry.def.id,
  store: app.store,
}