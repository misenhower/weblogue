/**
 * Skeuomorphic front-panel UI for the minilogue xd replica.
 *
 * One Panel instance builds the whole hardware face out of the primitives in
 * components.ts (Knob / SelectorSwitch / LedButton / StepButton /
 * EncoderWheel / Led) plus Keyboard and Joystick, and two-way binds every
 * control to the Store:
 *
 *   control.onInput  -> store.setParam / seq methods
 *   store.onParam    -> control.setValue(v, { silent: true })
 *   store.onProgram  -> full resync (knobs, switches, readouts, step LEDs)
 *   store.onSeq      -> step LEDs + tempo
 *   store.onRecChange-> REC LED + step-rec cursor
 *
 * Program management gestures:
 *   - WRITE commits the working program (green-flash on success; if the
 *     localStorage write fails the red LED blinks for ~1s and the program
 *     stays dirty).
 *   - SHIFT + WRITE initializes the edit buffer (store.initCurrent), like
 *     the hardware's init-program menu action.
 *   - Double-clicking the program NAME readout prompts for a new name
 *     (trimmed, max 16 chars; cancel is ignored).
 *
 * Layout/styling lives in src/ui/panel.css (the app imports it alongside
 * theme.css and kbd.css — this module imports no CSS).
 */
import type { Store } from '../state/store'
import { NUM_SLOTS } from '../state/persist'
import { P, PARAMS, formatParam } from '../shared/params'
import * as maps from '../shared/maps'
import { NUM_STEPS, NOTES_PER_STEP } from '../shared/program'
import {
  Knob,
  SelectorSwitch,
  LedButton,
  StepButton,
  EncoderWheel,
  Led,
  type StepState,
  type SetValueOpts,
} from './components'
import { Keyboard } from './keyboard'
import { Joystick } from './joystick'
import { showMenu, type MenuItem } from './menu'

export interface PanelOpts {
  store: Store
  onNoteOn(note: number, vel: number): void
  onNoteOff(note: number): void
  onBend(v: number): void
  onJoyY(v: number): void
  onMaster(v: number): void // master volume 0..1 (not a program param)
}

/* ------------------------------------------------------------------ */
/* small DOM helpers                                                   */
/* ------------------------------------------------------------------ */

function div(className: string, text?: string): HTMLDivElement {
  const d = document.createElement('div')
  d.className = className
  if (text !== undefined) d.textContent = text
  return d
}

function row(cls: string, ...children: HTMLElement[]): HTMLDivElement {
  const r = div(cls)
  r.append(...children)
  return r
}

/** Silkscreen section box with a title set into the top border. */
function section(title: string, cls: string, ...children: HTMLElement[]): HTMLElement {
  const s = div(`xd-section ${cls}`)
  s.append(div('xd-section-title', title))
  s.append(...children)
  return s
}

interface Bindable {
  setValue(v: number, opts?: SetValueOpts): void
}

/* per-multi-type param tables */
const MULTI_SELECTS = [P.SELECT_NOISE, P.SELECT_VPM, P.SELECT_USER] as const
const MULTI_SHAPES = [P.SHAPE_NOISE, P.SHAPE_VPM, P.SHAPE_USER] as const
const MULTI_SHIFTSHAPES = [P.SHIFTSHAPE_NOISE, P.SHIFTSHAPE_VPM, P.SHIFTSHAPE_USER] as const
const MODFX_SUBS = [
  P.MODFX_SUB_CHORUS,
  P.MODFX_SUB_ENSEMBLE,
  P.MODFX_SUB_PHASER,
  P.MODFX_SUB_FLANGER,
  P.MODFX_SUB_USER,
] as const

/** FX sections addressed by the shared controls: 0 = DEL, 1 = REV, 2 = MOD. */
const FX_ON_IDS = [P.DELAY_ON, P.REVERB_ON, P.MODFX_ON] as const
const FX_TIME_IDS = [P.DELAY_TIME, P.REVERB_TIME, P.MODFX_TIME] as const
const FX_DEPTH_IDS = [P.DELAY_DEPTH, P.REVERB_DEPTH, P.MODFX_DEPTH] as const
const FX_DRYWET_IDS = [P.DELAY_DRYWET, P.REVERB_DRYWET] as const
const FX_SUB_IDS = [P.DELAY_SUB, P.REVERB_SUB] as const
const FX_NAMES = ['DELAY', 'REVERB'] as const

/** Any param change in this set refreshes the FX readout/LED. */
const FX_PANEL_IDS = new Set<number>([
  P.MODFX_ON,
  P.MODFX_TYPE,
  ...MODFX_SUBS,
  P.DELAY_ON,
  P.DELAY_SUB,
  P.REVERB_ON,
  P.REVERB_SUB,
])

const SHIFT_HOLD_MS = 350
const MASTER_DEFAULT = 0.8
const TEMPO_MIN = 56
const TEMPO_MAX = 240

export class Panel {
  el: HTMLElement
  /** Empty well where the OLED module mounts later (~330x140). */
  displaySlot: HTMLElement
  keyboard: Keyboard

  private store: Store
  private opts: PanelOpts

  /** static param id -> bound controls */
  private bindings = new Map<number, Bindable[]>()

  /* dynamic controls (rebound at runtime) */
  private multiShapeKnob!: Knob
  private fxTimeKnob!: Knob
  private fxDepthKnob!: Knob
  private fxOnBtn!: LedButton
  private fxSection = 0 // 0 DEL, 1 REV, 2 MOD (panel-local, like hardware)

  /* SHIFT */
  private shiftOn = false
  private shiftBtn!: LedButton
  private shiftDownAt = 0
  private shiftPressTurnedOn = false

  /* transport / rec */
  private playBtn!: LedButton
  private recBtn!: LedButton
  private restHeld = false
  private playheadI = -1

  /* step-edit hold state */
  private heldSteps = new Set<number>()
  private pendingToggle = new Set<number>()
  private holdWrote = new Set<number>()

  private stepBtns: StepButton[] = []
  private tempoKnob!: Knob
  private multiDisplay!: HTMLElement
  private fxLine1!: HTMLElement
  private fxLine2!: HTMLElement
  private progNum!: HTMLElement
  private progName!: HTMLElement
  private writeBtn!: LedButton
  private latchBtn!: LedButton
  private midiLed!: Led
  private midiTimer: ReturnType<typeof setTimeout> | null = null
  private writeErrTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: PanelOpts) {
    this.opts = opts
    this.store = opts.store

    this.keyboard = new Keyboard({
      onNoteOn: (n, v) => this.handleNoteOn(n, v),
      onNoteOff: (n) => this.handleNoteOff(n),
    })

    /* ---- build DOM ------------------------------------------------ */
    const scale = div('xd-panel-scale')
    const panel = div('xd-panel xd-panel-root')
    scale.append(panel)
    this.el = scale

    this.displaySlot = div('xd-display-slot')

    const rowA = row(
      'xd-row xd-row-a',
      this.buildMaster(),
      this.buildVoiceMode(),
      this.buildVco1(),
      this.buildVco2(),
      this.buildMulti(),
      this.buildMixer(),
      this.buildFilter(),
    )
    const rowB = row(
      'xd-row xd-row-b',
      this.buildProgram(),
      this.buildAmpEg(),
      this.buildEg(),
      this.buildLfo(),
      this.buildFx(),
    )
    const rowSeq = this.buildSeqStrip()

    const joy = new Joystick({ onX: (v) => this.opts.onBend(v), onY: (v) => this.opts.onJoyY(v) })
    const joyWrap = div('xd-joy-block')
    joyWrap.append(joy.el, div('xd-legend xd-legend--dim xd-joy-caption', 'PITCH / MOD'))
    const rowKbd = row('xd-row xd-row-kbd', joyWrap, this.keyboard.el)

    panel.append(rowA, rowB, rowSeq, rowKbd)

    /* ---- store subscriptions -------------------------------------- */
    this.store.onParam((id, v, source) => this.onParamChange(id, v, source))
    this.store.onProgram(() => this.resyncAll())
    this.store.onSeq(() => {
      this.syncTempo()
      this.updateStepLeds()
    })
    this.store.onPlayhead((i) => {
      if (this.restHeld && this.store.recMode === 'realtime' && i >= 0) this.store.recRest()
      this.applyPlayhead(i)
    })
    this.store.onRecChange(() => this.syncRec())

    this.resyncAll()
  }

  /* ================================================================ */
  /* public API                                                        */
  /* ================================================================ */

  /** -1 = stopped; drives step-button 'playing' states. */
  setPlayhead(i: number): void {
    this.applyPlayhead(i)
  }

  setVoices(notes: number[]): void {
    this.keyboard.setLit(notes)
  }

  flashMidi(): void {
    this.midiLed.setOn(1)
    if (this.midiTimer !== null) clearTimeout(this.midiTimer)
    this.midiTimer = setTimeout(() => {
      this.midiTimer = null
      this.midiLed.setOn(0)
    }, 120)
  }

  /* ================================================================ */
  /* binding plumbing                                                  */
  /* ================================================================ */

  private bind(id: number, c: Bindable): void {
    let arr = this.bindings.get(id)
    if (!arr) {
      arr = []
      this.bindings.set(id, arr)
    }
    arr.push(c)
  }

  /**
   * Every param-bound knob funnels here: while step buttons are held the
   * move writes motion data to those steps (spec §11 step edit) instead of
   * changing the live parameter.
   */
  private knobInput(id: number, v: number): void {
    if (this.heldSteps.size > 0 && PARAMS[id]?.motion === true) {
      this.pendingToggle.clear() // an edit happened: held steps no longer toggle
      for (const i of this.heldSteps) {
        const lane = this.store.findMotionLane(id, true)
        if (lane >= 0) {
          this.store.writeMotionStep(lane, i, [v, v, v, v, v])
          // A written lane must play back: enable it (mirrors recKnob).
          this.store.setMotionLane(lane, { on: true, smooth: PARAMS[id].motionSmooth === true })
        }
      }
      return
    }
    this.store.setParam(id, v, 'ui')
  }

  private paramKnob(
    id: number,
    size: 'xl' | 'l' | 'm',
    extra?: { label?: string; bipolar?: boolean; format?: (v: number) => string },
  ): Knob {
    const m = PARAMS[id]
    const k = new Knob({
      label: extra?.label ?? m.label,
      size,
      min: m.min,
      max: m.max,
      value: this.store.getParam(id),
      defaultValue: m.def,
      bipolar: extra?.bipolar,
      format: extra?.format ?? ((v) => formatParam(id, v)),
      onInput: (v) => this.knobInput(id, v),
    })
    this.bind(id, k)
    return k
  }

  private paramSwitch(id: number, extra?: { label?: string; positions?: string[] }): SelectorSwitch {
    const m = PARAMS[id]
    const s = new SelectorSwitch({
      label: extra?.label ?? m.label,
      positions: extra?.positions ?? (m.labels ? [...m.labels] : []),
      value: this.store.getParam(id),
      onInput: (v) => this.store.setParam(id, v, 'ui'),
    })
    this.bind(id, s)
    return s
  }

  private onParamChange(id: number, v: number, source: string): void {
    if (source !== 'ui') {
      // resync statically bound controls (panel-originated edits already show)
      const arr = this.bindings.get(id)
      if (arr) for (const c of arr) c.setValue(v, { silent: true })
      // dynamic controls
      if (id === this.multiShapeId()) this.multiShapeKnob.setValue(v, { silent: true })
      if (id === this.fxTimeId()) this.fxTimeKnob.setValue(v, { silent: true })
      if (id === this.fxDepthId()) this.fxDepthKnob.setValue(v, { silent: true })
    }
    // side effects that must run for every source (including 'ui')
    // (silent: programmatic shifts must not echo back through onOctaveShift)
    if (id === P.OCTAVE) this.keyboard.setOctaveShift(v - 2, { silent: true })
    if (id === P.MULTI_TYPE) {
      this.rebindMultiShape()
      this.updateMultiDisplay()
    }
    if (id === P.SELECT_NOISE || id === P.SELECT_VPM || id === P.SELECT_USER) {
      this.updateMultiDisplay()
    }
    if (id === P.ARP_LATCH) this.syncLatchLed()
    if (FX_PANEL_IDS.has(id)) this.syncFxPanel()
  }

  private resyncAll(): void {
    for (const [id, arr] of this.bindings) {
      const v = this.store.getParam(id)
      for (const c of arr) c.setValue(v, { silent: true })
    }
    this.rebindMultiShape()
    this.rebindFxKnobs()
    this.updateMultiDisplay()
    this.syncFxPanel()
    this.syncTempo()
    this.updateStepLeds()
    this.updateProgramReadout()
    this.syncRec()
    this.syncLatchLed()
    this.keyboard.setOctaveShift(this.store.getParam(P.OCTAVE) - 2, { silent: true })
  }

  /* ================================================================ */
  /* SHIFT                                                             */
  /* ================================================================ */

  private setShift(on: boolean): void {
    if (this.shiftOn === on) return
    this.shiftOn = on
    this.el.classList.toggle('xd-shift-on', on)
    this.shiftBtn.setLed(on ? 1 : 0)
    // SHIFT re-addresses the multi SHAPE knob and the FX DEPTH knob
    this.rebindMultiShape()
    this.rebindFxKnobs()
  }

  private shiftPress = (): void => {
    this.shiftDownAt = Date.now()
    if (this.shiftOn) {
      this.shiftPressTurnedOn = false
      this.setShift(false)
    } else {
      this.shiftPressTurnedOn = true
      this.setShift(true)
    }
  }

  private shiftRelease = (): void => {
    // long press = momentary hold; quick tap = latch (toggle stays on)
    if (this.shiftPressTurnedOn && Date.now() - this.shiftDownAt > SHIFT_HOLD_MS) {
      this.setShift(false)
    }
    // the momentary button zeroes its own LED after release — re-assert
    queueMicrotask(() => this.shiftBtn.setLed(this.shiftOn ? 1 : 0))
  }

  /* ================================================================ */
  /* MULTI ENGINE dynamic binding                                      */
  /* ================================================================ */

  private multiType(): number {
    const t = this.store.getParam(P.MULTI_TYPE)
    return t >= 0 && t <= 2 ? t : 1
  }

  private multiShapeId(): number {
    return this.shiftOn ? MULTI_SHIFTSHAPES[this.multiType()] : MULTI_SHAPES[this.multiType()]
  }

  private rebindMultiShape(): void {
    this.multiShapeKnob.setValue(this.store.getParam(this.multiShapeId()), { silent: true })
  }

  private updateMultiDisplay(): void {
    const selId = MULTI_SELECTS[this.multiType()]
    this.multiDisplay.textContent = formatParam(selId, this.store.getParam(selId))
  }

  private stepMultiSelect(dir: 1 | -1): void {
    const selId = MULTI_SELECTS[this.multiType()]
    const m = PARAMS[selId]
    const n = m.max - m.min + 1
    const cur = this.store.getParam(selId)
    const next = m.min + ((cur - m.min + dir + n) % n) // wraps
    this.store.setParam(selId, next, 'ui')
    this.updateMultiDisplay()
  }

  /* ================================================================ */
  /* EFFECTS dynamic binding                                           */
  /* ================================================================ */

  private fxOnId(): number {
    return FX_ON_IDS[this.fxSection]
  }

  private fxTimeId(): number {
    return FX_TIME_IDS[this.fxSection]
  }

  private fxDepthId(): number {
    // hardware: SHIFT+DEPTH edits DRY/WET for delay & reverb (MOD FX has none)
    if (this.shiftOn && this.fxSection < 2) return FX_DRYWET_IDS[this.fxSection]
    return FX_DEPTH_IDS[this.fxSection]
  }

  private rebindFxKnobs(): void {
    const timeId = this.fxTimeId()
    const depthId = this.fxDepthId()
    // Ranges follow the addressed param (DRY WET is 0..1024, spec §10).
    this.fxTimeKnob.setRange(PARAMS[timeId].min, PARAMS[timeId].max)
    this.fxDepthKnob.setRange(PARAMS[depthId].min, PARAMS[depthId].max)
    this.fxTimeKnob.setValue(this.store.getParam(timeId), { silent: true })
    this.fxDepthKnob.setValue(this.store.getParam(depthId), { silent: true })
  }

  private setFxSection(i: number): void {
    this.fxSection = i >= 0 && i <= 2 ? i : 0
    this.rebindFxKnobs()
    this.syncFxPanel()
  }

  private syncFxPanel(): void {
    this.fxOnBtn.setValue(this.store.getParam(this.fxOnId()), { silent: true })
    if (this.fxSection === 2) {
      const type = this.store.getParam(P.MODFX_TYPE)
      const subId = MODFX_SUBS[Math.max(0, Math.min(4, type))]
      this.fxLine1.textContent = formatParam(P.MODFX_TYPE, type)
      this.fxLine2.textContent = formatParam(subId, this.store.getParam(subId))
    } else {
      const subId = FX_SUB_IDS[this.fxSection]
      this.fxLine1.textContent = FX_NAMES[this.fxSection]
      this.fxLine2.textContent = formatParam(subId, this.store.getParam(subId))
    }
  }

  private fxSelectPress(): void {
    if (this.fxSection === 2) {
      if (this.shiftOn) {
        // cycle the current MOD FX type's sub
        const type = Math.max(0, Math.min(4, this.store.getParam(P.MODFX_TYPE)))
        this.cycleParam(MODFX_SUBS[type])
      } else {
        this.cycleParam(P.MODFX_TYPE)
      }
    } else {
      this.cycleParam(FX_SUB_IDS[this.fxSection])
    }
    this.syncFxPanel()
  }

  private cycleParam(id: number): void {
    const m = PARAMS[id]
    const n = m.max - m.min + 1
    const next = m.min + ((this.store.getParam(id) - m.min + 1) % n)
    this.store.setParam(id, next, 'ui')
  }

  /* ================================================================ */
  /* keyboard notes (incl. hold-step chord entry + rec)                */
  /* ================================================================ */

  private handleNoteOn(note: number, vel: number): void {
    if (this.heldSteps.size > 0) {
      // spec §11 step edit: held step(s) + key writes notes into those steps
      this.pendingToggle.clear()
      const gate = this.store.program.seq.defaultGate
      for (const i of this.heldSteps) {
        const st = this.store.program.seq.steps[i]
        let notes: number[]
        let vels: number[]
        let gates: number[]
        if (this.holdWrote.has(i)) {
          // accumulate a chord across key presses during the same hold
          notes = st.notes.slice()
          vels = st.vels.slice()
          gates = st.gates.slice()
          if (!notes.includes(note) && notes.length < NOTES_PER_STEP) {
            notes.push(note)
            vels.push(vel)
            gates.push(gate)
          }
        } else {
          notes = [note]
          vels = [vel]
          gates = [gate]
          this.holdWrote.add(i)
        }
        this.store.setStep(i, notes, vels, gates)
      }
      this.updateStepLeds()
    }
    this.store.recNoteOn(note, vel) // step/realtime recording (no-op otherwise)
    this.opts.onNoteOn(note, vel)
  }

  private handleNoteOff(note: number): void {
    this.store.recNoteOff(note)
    this.opts.onNoteOff(note)
  }

  /* ================================================================ */
  /* sequencer strip behavior                                          */
  /* ================================================================ */

  private stepPress(i: number): void {
    if (this.store.recMode === 'step') {
      this.store.jumpStepRec(i)
      return
    }
    if (this.shiftOn) {
      this.store.toggleActiveStep(i)
      return
    }
    this.heldSteps.add(i)
    this.pendingToggle.add(i)
  }

  private stepRelease(i: number): void {
    const pending = this.pendingToggle.delete(i)
    const wasHeld = this.heldSteps.delete(i)
    this.holdWrote.delete(i)
    // plain press-and-release (nothing written while held) = mute toggle
    if (wasHeld && pending) this.store.toggleStep(i)
  }

  private cycleRec(): void {
    if (this.store.recMode !== 'off') {
      this.store.setRecMode('off')
    } else {
      this.store.setRecMode(this.store.playing ? 'realtime' : 'step')
    }
  }

  private syncRec(): void {
    const m = this.store.recMode
    this.recBtn.setValue(m === 'off' ? 0 : 1, { silent: true })
    this.recBtn.el.classList.toggle('xd-blink', m === 'step') // blink = step rec
    this.playBtn.setValue(this.store.playing ? 1 : 0, { silent: true })
    this.updateStepLeds()
  }

  private applyPlayhead(i: number): void {
    this.playheadI = Number.isFinite(i) && i >= 0 && i < NUM_STEPS ? Math.trunc(i) : -1
    this.updateStepLeds()
  }

  private updateStepLeds(): void {
    const seq = this.store.program.seq
    const stepRec = this.store.recMode === 'step'
    const cursor = this.store.stepRecCursor
    for (let i = 0; i < NUM_STEPS; i++) {
      let s: StepState
      if (this.playheadI === i) {
        s = 'playing'
      } else if (stepRec && cursor === i) {
        s = 'rec'
      } else {
        const st = seq.steps[i]
        if (i >= seq.stepLength || st.notes.length === 0) s = 'off'
        else if (!seq.activeSteps[i] || !st.on) s = 'dim'
        else s = 'on'
      }
      this.stepBtns[i].setState(s)
    }
  }

  /* ================================================================ */
  /* misc sync                                                         */
  /* ================================================================ */

  private syncTempo(): void {
    this.tempoKnob.setValue(this.store.program.seq.bpm, { silent: true })
  }

  /** ARP LATCH LED blinks while latched (spec §3). */
  private syncLatchLed(): void {
    this.latchBtn.el.classList.toggle('xd-blink', this.store.getParam(P.ARP_LATCH) === 1)
  }

  private updateProgramReadout(): void {
    this.progNum.textContent = String(this.store.slot + 1).padStart(3, '0')
    this.progName.textContent = this.store.program.name
  }

  /** WRITE commits the program; SHIFT+WRITE inits the edit buffer instead. */
  private writePress(): void {
    if (this.shiftOn) {
      this.store.initCurrent() // OLED/readout follow via the onProgram flow
      return
    }
    const ok = this.store.writeSlot()
    // restart whichever LED animation applies (class swap restarts it)
    this.writeBtn.el.classList.remove('xd-flash', 'xd-blink')
    void (this.writeBtn.el as HTMLElement).offsetWidth
    if (this.writeErrTimer !== null) {
      clearTimeout(this.writeErrTimer)
      this.writeErrTimer = null
    }
    if (ok) {
      this.writeBtn.el.classList.add('xd-flash')
    } else {
      // persistence failed (localStorage quota): blink the red LED for ~1s
      this.writeBtn.el.classList.add('xd-blink')
      this.writeErrTimer = setTimeout(() => {
        this.writeErrTimer = null
        this.writeBtn.el.classList.remove('xd-blink')
      }, 1000)
    }
  }

  /** Double-click on the NAME readout: prompt-based program rename. */
  private renamePrompt(): void {
    const next = window.prompt('Program name', this.store.program.name)
    if (next === null) return
    this.store.setName(next.trim().slice(0, 16))
  }

  /* ------------------------------------------------- readout menus -- */

  /** Multi readout: every oscillator across all three engines, grouped. */
  private openMultiMenu(): void {
    const type = Math.round(this.store.getParam(P.MULTI_TYPE))
    const groups = PARAMS[P.MULTI_TYPE].labels ?? []
    const items: MenuItem[] = []
    for (let t = 0; t < MULTI_SELECTS.length; t++) {
      items.push({ label: String(groups[t] ?? t) })
      const labels = PARAMS[MULTI_SELECTS[t]].labels ?? []
      const cur = Math.round(this.store.getParam(MULTI_SELECTS[t]))
      for (let i = 0; i < labels.length; i++) {
        items.push({ label: labels[i], value: t * 100 + i, selected: t === type && i === cur })
      }
    }
    showMenu(this.multiDisplay, items, (v) => {
      const t = Math.floor((v as number) / 100)
      this.store.setParam(P.MULTI_TYPE, t, 'ui')
      this.store.setParam(MULTI_SELECTS[t], (v as number) % 100, 'ui')
    })
  }

  /** FX readout: the addressed section's types (MOD grouped by type). */
  private openFxMenu(anchor: HTMLElement): void {
    if (this.fxSection === 2) {
      const type = Math.round(this.store.getParam(P.MODFX_TYPE))
      const typeLabels = PARAMS[P.MODFX_TYPE].labels ?? []
      const items: MenuItem[] = []
      for (let t = 0; t < MODFX_SUBS.length; t++) {
        items.push({ label: String(typeLabels[t] ?? t) })
        const labels = PARAMS[MODFX_SUBS[t]].labels ?? []
        const cur = Math.round(this.store.getParam(MODFX_SUBS[t]))
        for (let i = 0; i < labels.length; i++) {
          items.push({ label: labels[i], value: t * 100 + i, selected: t === type && i === cur })
        }
      }
      showMenu(anchor, items, (v) => {
        const t = Math.floor((v as number) / 100)
        this.store.setParam(P.MODFX_TYPE, t, 'ui')
        this.store.setParam(MODFX_SUBS[t], (v as number) % 100, 'ui')
      })
      return
    }
    const subId = this.fxSection === 0 ? P.DELAY_SUB : P.REVERB_SUB
    const labels = PARAMS[subId].labels ?? []
    const cur = Math.round(this.store.getParam(subId))
    const items: MenuItem[] = labels.map((l, i) => ({ label: l, value: i, selected: i === cur }))
    showMenu(anchor, items, (v) => this.store.setParam(subId, v as number, 'ui'))
  }

  /** Program readout: browser over all 500 slots, plus rename. */
  private openProgramMenu(anchor: HTMLElement): void {
    const names = this.store.slotNames()
    const items: MenuItem[] = [{ label: 'Rename…', value: -1, action: true }]
    for (let i = 0; i < names.length; i++) {
      items.push({
        label: String(i + 1).padStart(3, '0') + '  ' + names[i],
        value: i,
        selected: i === this.store.slot,
      })
    }
    showMenu(anchor, items, (v) => {
      if ((v as number) < 0) this.renamePrompt()
      else this.store.loadSlot(v as number)
    })
  }

  /* ================================================================ */
  /* section builders                                                  */
  /* ================================================================ */

  private buildMaster(): HTMLElement {
    const master = new Knob({
      label: 'MASTER',
      size: 'l',
      min: 0,
      max: 1,
      step: 0.01,
      value: MASTER_DEFAULT,
      defaultValue: MASTER_DEFAULT,
      format: (v) => maps.fmtPercent01(v),
      onInput: (v) => this.opts.onMaster(v),
    })

    this.tempoKnob = new Knob({
      label: 'TEMPO',
      size: 'm',
      min: TEMPO_MIN,
      max: TEMPO_MAX,
      step: 0.1, // hardware tempo resolution is 0.1 BPM
      value: this.store.program.seq.bpm,
      defaultValue: 120,
      format: (v) => v.toFixed(1),
      onInput: (v) => this.store.setSeqField('bpm', v),
    })

    const octave = this.paramSwitch(P.OCTAVE, { label: 'OCTAVE' })
    const porta = this.paramKnob(P.PORTAMENTO, 'm', { label: 'PORTAMENTO' })

    return section(
      'MASTER',
      'xd-sec-master',
      row('xd-ctl-row', master.el, this.tempoKnob.el),
      row('xd-ctl-row', octave.el, porta.el),
    )
  }

  private buildVoiceMode(): HTMLElement {
    const mode = this.paramSwitch(P.VOICE_MODE, { label: 'VOICE MODE' })
    const latch = new LedButton({
      label: 'LATCH',
      latching: true,
      onInput: (v) => this.store.setParam(P.ARP_LATCH, v, 'ui'),
    })
    this.latchBtn = latch
    this.bind(P.ARP_LATCH, latch)

    const depth = this.paramKnob(P.VM_DEPTH, 'l', {
      label: 'DEPTH',
      format: (v) => this.formatVmDepth(v),
    })

    return section(
      'VOICE MODE',
      'xd-sec-vm',
      row('xd-ctl-row', mode.el, latch.el),
      row('xd-ctl-row', depth.el),
    )
  }

  private formatVmDepth(v: number): string {
    switch (this.store.getParam(P.VOICE_MODE)) {
      case 0: // ARP
        return maps.ARP_TYPES[maps.arpTypeIndex(v)]
      case 1: // CHORD
        return maps.CHORDS[maps.chordIndex(v)].name
      case 2: // UNISON
        return maps.unisonDetuneCents(v).toFixed(1) + ' Cent'
      default: {
        const pd = maps.polyDuo(v)
        return pd.duo ? 'Duo ' + Math.round(pd.amount * 100) : 'Poly'
      }
    }
  }

  private buildVco1(): HTMLElement {
    const wave = this.paramSwitch(P.VCO1_WAVE, { label: 'WAVE' })
    const oct = this.paramSwitch(P.VCO1_OCTAVE, { label: 'OCTAVE' })
    const pitch = this.paramKnob(P.VCO1_PITCH, 'm', { label: 'PITCH', bipolar: true })
    const shape = this.paramKnob(P.VCO1_SHAPE, 'm', { label: 'SHAPE' })
    return section(
      'VCO 1',
      'xd-sec-vco1',
      row('xd-ctl-row', wave.el, oct.el),
      row('xd-ctl-row', pitch.el, shape.el),
    )
  }

  private buildVco2(): HTMLElement {
    const wave = this.paramSwitch(P.VCO2_WAVE, { label: 'WAVE' })
    const oct = this.paramSwitch(P.VCO2_OCTAVE, { label: 'OCTAVE' })
    const sync = this.paramSwitch(P.SYNC, { label: 'SYNC' })
    const ring = this.paramSwitch(P.RING, { label: 'RING' })
    const pitch = this.paramKnob(P.VCO2_PITCH, 'm', { label: 'PITCH', bipolar: true })
    const shape = this.paramKnob(P.VCO2_SHAPE, 'm', { label: 'SHAPE' })
    const cross = this.paramKnob(P.CROSS_MOD, 'm', { label: 'CROSS MOD DEPTH' })
    return section(
      'VCO 2',
      'xd-sec-vco2',
      row('xd-ctl-row', wave.el, oct.el, sync.el, ring.el),
      row('xd-ctl-row', pitch.el, shape.el, cross.el),
    )
  }

  private buildMulti(): HTMLElement {
    const type = this.paramSwitch(P.MULTI_TYPE, { label: 'ENGINE' })
    const oct = this.paramSwitch(P.MULTI_OCTAVE, { label: 'OCTAVE' })

    this.multiDisplay = div('xd-multi-display')
    this.multiDisplay.classList.add('xd-clickable-readout')
    this.multiDisplay.title = 'choose oscillator'
    this.multiDisplay.addEventListener('click', () => this.openMultiMenu())
    const enc = new EncoderWheel({ label: 'TYPE', onStep: (dir) => this.stepMultiSelect(dir) })
    const typeBlock = div('xd-multi-typeblock')
    typeBlock.append(this.multiDisplay, enc.el)

    this.multiShapeKnob = new Knob({
      label: 'SHAPE',
      size: 'm',
      min: 0,
      max: 1023,
      value: this.store.getParam(this.multiShapeId()),
      defaultValue: 0,
      format: (v) => formatParam(this.multiShapeId(), v),
      onInput: (v) => this.knobInput(this.multiShapeId(), v),
    })

    return section(
      'MULTI ENGINE',
      'xd-sec-multi',
      row('xd-ctl-row', type.el, typeBlock),
      row('xd-ctl-row', oct.el, this.multiShapeKnob.el),
    )
  }

  private buildMixer(): HTMLElement {
    const v1 = this.paramKnob(P.VCO1_LEVEL, 'm', { label: 'VCO 1' })
    const v2 = this.paramKnob(P.VCO2_LEVEL, 'm', { label: 'VCO 2' })
    const mu = this.paramKnob(P.MULTI_LEVEL, 'm', { label: 'MULTI' })
    return section(
      'MIXER',
      'xd-sec-mixer',
      row('xd-ctl-row xd-ctl-col', v1.el, v2.el, mu.el),
    )
  }

  private buildFilter(): HTMLElement {
    const cutoff = this.paramKnob(P.CUTOFF, 'xl', { label: 'CUTOFF' })
    const reso = this.paramKnob(P.RESONANCE, 'l', { label: 'RESONANCE' })
    const drive = this.paramSwitch(P.DRIVE, { label: 'DRIVE' })
    const keytrack = this.paramSwitch(P.KEYTRACK, { label: 'KEYTRACK' })
    const right = div('xd-filter-right')
    right.append(row('xd-ctl-row', reso.el), row('xd-ctl-row', drive.el, keytrack.el))
    return section('FILTER', 'xd-sec-filter', row('xd-ctl-row xd-filter-row', cutoff.el, right))
  }

  private buildProgram(): HTMLElement {
    this.progNum = div('xd-prog-num')
    this.progName = div('xd-prog-name')
    const readout = div('xd-prog-readout')
    readout.classList.add('xd-clickable-readout')
    readout.title = 'browse programs'
    // click = program browser (with Rename inside); dblclick rename stays.
    readout.addEventListener('click', () => this.openProgramMenu(readout))
    this.progName.addEventListener('dblclick', () => this.renamePrompt())
    readout.append(this.progNum, this.progName)

    this.midiLed = new Led({ color: 'red' })
    const midiWrap = div('xd-midi-ind')
    midiWrap.append(this.midiLed.el, div('xd-legend xd-legend--dim', 'MIDI'))

    const enc = new EncoderWheel({
      label: 'PROGRAM/VALUE',
      onStep: (dir) => {
        const next = (this.store.slot + dir + NUM_SLOTS) % NUM_SLOTS
        this.store.loadSlot(next) // hardware switches even when dirty
      },
    })

    this.writeBtn = new LedButton({
      label: 'WRITE',
      led: 'red',
      onPress: () => this.writePress(),
    })

    this.shiftBtn = new LedButton({
      label: 'SHIFT',
      onPress: this.shiftPress,
      onRelease: this.shiftRelease,
    })

    const top = div('xd-prog-top')
    top.append(readout, midiWrap)

    const side = div('xd-prog-side')
    side.append(enc.el, this.writeBtn.el, this.shiftBtn.el)

    const main = div('xd-prog-main')
    main.append(this.displaySlot, side)

    return section('PROGRAM', 'xd-sec-prog', top, main)
  }

  private buildAmpEg(): HTMLElement {
    const a = this.paramKnob(P.AMP_ATTACK, 'm', { label: 'ATTACK' })
    const d = this.paramKnob(P.AMP_DECAY, 'm', { label: 'DECAY' })
    const s = this.paramKnob(P.AMP_SUSTAIN, 'm', { label: 'SUSTAIN' })
    const r = this.paramKnob(P.AMP_RELEASE, 'm', { label: 'RELEASE' })
    return section('AMP EG', 'xd-sec-amp', row('xd-ctl-row', a.el, d.el, s.el, r.el))
  }

  private buildEg(): HTMLElement {
    const a = this.paramKnob(P.EG_ATTACK, 'm', { label: 'ATTACK' })
    const d = this.paramKnob(P.EG_DECAY, 'm', { label: 'DECAY' })
    const int = this.paramKnob(P.EG_INT, 'm', { label: 'EG INT', bipolar: true })
    const target = this.paramSwitch(P.EG_TARGET, { label: 'TARGET' })
    return section('EG', 'xd-sec-eg', row('xd-ctl-row', a.el, d.el, int.el, target.el))
  }

  private buildLfo(): HTMLElement {
    const wave = this.paramSwitch(P.LFO_WAVE, { label: 'WAVE' })
    const mode = this.paramSwitch(P.LFO_MODE, { label: 'MODE' })
    const rate = this.paramKnob(P.LFO_RATE, 'm', {
      label: 'RATE',
      format: (v) =>
        this.store.getParam(P.LFO_MODE) === 2
          ? maps.LFO_BPM_DIVISIONS[maps.lfoBpmDivIndex(v)].label
          : maps.fmtHz(maps.lfoRateToHz(v)),
    })
    const int = this.paramKnob(P.LFO_INT, 'm', { label: 'INT', bipolar: true })
    const target = this.paramSwitch(P.LFO_TARGET, { label: 'TARGET' })
    return section(
      'LFO',
      'xd-sec-lfo',
      row('xd-ctl-row', wave.el, mode.el, target.el),
      row('xd-ctl-row', rate.el, int.el),
    )
  }

  private buildFx(): HTMLElement {
    const sel = new SelectorSwitch({
      label: 'SECTION',
      positions: ['DEL', 'REV', 'MOD'],
      value: this.fxSection,
      onInput: (v) => this.setFxSection(v),
    })

    this.fxOnBtn = new LedButton({
      label: 'ON/OFF',
      latching: true,
      onInput: (v) => this.store.setParam(this.fxOnId(), v, 'ui'),
    })

    const selectBtn = new LedButton({
      label: 'SELECT',
      onPress: () => this.fxSelectPress(),
    })

    this.fxLine1 = div('xd-fx-line1')
    this.fxLine2 = div('xd-fx-line2')
    const readout = div('xd-fx-display')
    readout.classList.add('xd-clickable-readout')
    readout.title = 'choose effect type'
    readout.addEventListener('click', () => this.openFxMenu(readout))
    readout.append(this.fxLine1, this.fxLine2)

    this.fxTimeKnob = new Knob({
      label: 'TIME',
      size: 'm',
      min: 0,
      max: 1023,
      value: this.store.getParam(this.fxTimeId()),
      defaultValue: 512,
      format: (v) => formatParam(this.fxTimeId(), v),
      onInput: (v) => this.knobInput(this.fxTimeId(), v),
    })
    this.fxDepthKnob = new Knob({
      label: 'DEPTH',
      size: 'm',
      min: 0,
      max: 1023,
      value: this.store.getParam(this.fxDepthId()),
      defaultValue: 512,
      format: (v) => formatParam(this.fxDepthId(), v),
      onInput: (v) => this.knobInput(this.fxDepthId(), v),
    })

    return section(
      'EFFECTS',
      'xd-sec-fx',
      row('xd-ctl-row', sel.el, row('xd-fx-btns', this.fxOnBtn.el, selectBtn.el)),
      row('xd-ctl-row', readout, this.fxTimeKnob.el, this.fxDepthKnob.el),
    )
  }

  private buildSeqStrip(): HTMLElement {
    this.playBtn = new LedButton({
      label: 'PLAY',
      latching: true,
      onInput: (v) => {
        this.store.setPlaying(v === 1)
        this.syncRec()
      },
    })
    this.recBtn = new LedButton({
      label: 'REC',
      led: 'red',
      latching: true,
      onInput: () => this.cycleRec(),
    })
    const rest = new LedButton({
      label: 'REST',
      onPress: () => {
        this.restHeld = true
        this.store.recRest()
      },
      onRelease: () => {
        this.restHeld = false
      },
    })

    const transport = div('xd-seq-transport')
    transport.append(this.playBtn.el, this.recBtn.el, rest.el)

    const steps = div('xd-seq-steps')
    for (let i = 0; i < NUM_STEPS; i++) {
      const b = new StepButton({
        index: i,
        onPress: (idx) => this.stepPress(idx),
        onRelease: (idx) => this.stepRelease(idx),
      })
      this.stepBtns.push(b)
      steps.append(b.el)
    }

    return row('xd-row xd-row-seq', transport, steps)
  }
}
