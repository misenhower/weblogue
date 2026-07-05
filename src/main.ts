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
import './ui/settings.css'
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

// --- Power-on (audio needs a user gesture — but only when the browser
// says so). The graph is built eagerly at load and resume() is attempted
// right away: after a synth-switch reload Chrome carries the click's
// autoplay permission across the same-origin navigation, so the context
// starts silently and the overlay (which fades in after a beat) is removed
// before it ever becomes visible. Only when autoplay is actually blocked
// (typically the first visit) does the POWER ON gate appear.
const overlay = document.createElement('div')
overlay.className = 'xd-power-overlay'
overlay.innerHTML = `<button class="xd-power-btn"><span></span>POWER ON</button>`
appRoot.appendChild(overlay)

let bootP: Promise<void> | null = null
function boot(): Promise<void> {
  // A failed boot (e.g. worklet fetch 404 after a stale deploy) must not be
  // memoized: clear bootP so the next POWER ON click retries from scratch.
  bootP ??= doBoot().catch((err) => {
    bootP = null
    ctx = null
    throw err
  })
  return bootP
}

async function doBoot(): Promise<void> {
  ctx = new AudioContext({ latencyHint: 'interactive' })
  ctx.onstatechange = () => {
    if (ctx!.state === 'running') onRunning()
  }
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

  // Flush everything queued before boot (includes the program load that
  // store.connect() emitted), then enable the scope stream.
  for (const m of pending) node.port.postMessage(m)
  pending.length = 0
  send({ t: 'scope', on: true })
}

let poweredOn = false
function onRunning(): void {
  if (poweredOn) return
  poweredOn = true
  overlay.remove()
  void app.initMidi()
}

async function powerOn(): Promise<void> {
  await boot()
  await ctx!.resume() // pends/rejects while autoplay-blocked; gesture retries
  onRunning()
}
// Any click on the gate powers on, not just the button — the overlay is
// transparent for its first 250ms and must not eat that first gesture.
overlay.addEventListener('click', () => {
  powerOn().catch((err) => console.error('power on failed:', err))
})
void powerOn().catch((err) => console.warn('auto power-on blocked:', err))

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