/**
 * Skeuomorphic front-panel UI for the Korg monologue replica.
 *
 * Mirrors src/synths/og/panel.ts (the closest family member: 7-bit CCs,
 * horizontal slider, simpler panel): one Panel instance builds the hardware
 * face from the primitives in components.ts plus Keyboard and Slider, and
 * two-way binds every control to the Store (see the og header for the
 * subscription contract).
 *
 * monologue-specific hardware behavior (docs/monologue-spec.md §2/§8):
 *   - MASTER block carries the continuous DRIVE knob (P.DRIVE, spec §7),
 *     TEMPO 56.0-240.0 and the 5-way keyboard OCTAVE switch.
 *   - Several 3-position switches print their labels in the REVERSE of the
 *     program-data enum order (params.ts stores enum order): VCO WAVE columns
 *     read SAW/TRI/SQR (VCO2: SAW/TRI/NOISE) top-to-bottom, SYNC/RING reads
 *     SYNC/OFF/RING, EG TYPE reads A/D | A/G/D | GATE, LFO MODE reads
 *     FAST/SLOW/1-SHOT — reversedSwitch() maps positions <-> stored values.
 *   - KEY TRG/HOLD is one button (spec §8): a tap cycles Off <-> KEY TRG; a
 *     hold >500ms latches HOLD (blinking LED) — the og ARP-latch gesture
 *     precedent. Another long hold releases HOLD.
 *   - The 16 step buttons are ALWAYS visible (the hardware has them — no
 *     STEPS chip like the og). The MOTION/SLIDE/NOTE 3-position switch
 *     (panel-local UI state, not a program param) selects what they do:
 *       NOTE   = family step edit (tap = mute toggle, hold + key = write the
 *                step's single note — monophonic, spec §8 — hold + knob =
 *                motion write, step-rec cursor jump);
 *       SLIDE  = tap toggles the step's slide flag (store.setStepSlide);
 *                LEDs show slide state dimly;
 *       MOTION = LEDs show which steps hold motion data in the assigned
 *                lanes; hold + knob writes motion (the og held-step write);
 *                a plain tap toggles nothing.
 *   - The SLIDER follows P.SLIDER_ASSIGN exactly like the og (spring PITCH
 *     BEND vs held mod positions, motion-recorded via recKnob).
 *   - 25 slim keys, E-to-E (MIDI 52..76, spec §1).
 *
 * Layout/styling lives in src/ui/panel.css under the .mono- prefix (logical
 * panel width 1160, scale var --mono-scale); shared chrome reuses the xd-
 * classes from theme.css/panel.css.
 */
import type { Store } from '../../state/store'
import { NUM_SLOTS } from '../../state/persist'
import {
  P,
  PARAMS,
  formatParam,
  sliderDestParam,
  SLIDER_DEST_PITCH_BEND,
  SLIDER_DEST_GATE_TIME,
} from './params'
import { fmtPercent01, fmtHz } from '../../shared/maps'
import * as curves from './curves'
import { NUM_STEPS } from '../../shared/program'
import { MOTION_PITCH_BEND, MOTION_GATE_TIME } from '../../shared/paramdef'
import {
  Knob,
  LedButton,
  StepButton,
  EncoderWheel,
  Led,
  SelectorSwitch,
  type StepState,
} from '../../ui/components'
import { div, row, section } from '../../ui/dom'
import { ParamBinder } from '../../ui/parambinder'
import { Keyboard } from '../../ui/keyboard'
import { Slider } from '../../ui/slider'
import { showMenu, closeMenu, type MenuItem } from '../../ui/menu'

export interface PanelOpts {
  store: Store
  onNoteOn(note: number, vel: number): void
  onNoteOff(note: number): void
  onBend(v: number): void
  onJoyY(v: number): void
  onMaster(v: number): void // master volume 0..1 (not a program param)
}

const MASTER_DEFAULT = 0.8
/** TEMPO knob range (spec §2; SEQ EDIT accepts 10..300 via the menu). */
const TEMPO_MIN = 56
const TEMPO_MAX = 240
/** Hold KEY TRG/HOLD this long to latch HOLD (hardware gesture — the og
 *  ARP-latch precedent; exact hardware threshold UNCONFIRMED). */
const KEY_TRG_HOLD_MS = 500
/** 25-key E-to-E keybed, MIDI 52..76 (spec §1). */
const KBD_LOW = 52
const KBD_HIGH = 76

/** MOTION/SLIDE/NOTE step-edit switch positions, silkscreen order
 *  top-to-bottom (spec §2). Panel-local UI state — the physical switch is
 *  not program data. */
const EDIT_MOTION = 0
const EDIT_SLIDE = 1
const EDIT_NOTE = 2
const EDIT_LABELS = ['MOTION', 'SLIDE', 'NOTE']

export class Panel {
  el: HTMLElement
  /** Empty well where the OLED module mounts later (~330x140). */
  displaySlot: HTMLElement
  keyboard: Keyboard

  private store: Store
  private opts: PanelOpts

  /** param-bound knobs/switches (shared binding plumbing, ui/parambinder) */
  private binder: ParamBinder

  /* SLIDER (rebuilt whenever P.SLIDER_ASSIGN changes — og machinery) */
  private slider!: Slider
  private sliderWrap!: HTMLElement
  private sliderBuiltAssign = -1

  /* transport / rec */
  private playBtn!: LedButton
  private recBtn!: LedButton
  private restHeld = false
  private playheadI = -1

  /* KEY TRG/HOLD button (tap cycles, hold latches) */
  private keyTrgBtn!: LedButton
  private keyTrgDownAt = 0

  /* MOTION/SLIDE/NOTE step-edit switch (panel-local, defaults to NOTE) */
  private editSwitch!: SelectorSwitch

  /* step-edit hold state (NOTE + MOTION modes) */
  private heldSteps = new Set<number>()
  private pendingToggle = new Set<number>()

  private stepBtns: StepButton[] = []
  private tempoKnob!: Knob
  private progNum!: HTMLElement
  private progName!: HTMLElement
  private progReadout!: HTMLElement
  private writeBtn!: LedButton
  private midiLed!: Led
  private midiTimer: ReturnType<typeof setTimeout> | null = null
  private writeErrTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: PanelOpts) {
    this.opts = opts
    this.store = opts.store

    this.binder = new ParamBinder({
      store: this.store,
      params: PARAMS,
      formatParam,
      isStepHeld: () => this.heldSteps.size > 0,
      writeHeldStepMotion: (id, v) => this.writeHeldStepMotion(id, v),
    })

    this.keyboard = new Keyboard({
      lowestNote: KBD_LOW,
      highestNote: KBD_HIGH,
      onNoteOn: (n, v) => this.handleNoteOn(n, v),
      onNoteOff: (n) => this.handleNoteOff(n),
    })

    /* ---- build DOM ------------------------------------------------ */
    const scale = div('mono-panel-scale')
    const panel = div('xd-panel mono-panel-root')
    scale.append(panel)
    this.el = scale

    this.displaySlot = div('xd-display-slot')

    const rowA = row(
      'xd-row mono-row mono-row-a',
      this.buildMaster(),
      this.buildVco1(),
      this.buildVco2(),
      this.buildMixer(),
      this.buildFilter(),
    )
    const rowB = row(
      'xd-row mono-row mono-row-b',
      this.buildProgram(),
      this.buildEg(),
      this.buildLfo(),
    )
    const rowSeq = this.buildSeqStrip()

    this.sliderWrap = div('mono-slider-block')
    this.buildSlider()
    const rowKbd = row('xd-row xd-row-kbd mono-row-kbd', this.sliderWrap, this.keyboard.el)

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

  /**
   * binder.knobInput diversion (family step edit): a knob move while step
   * buttons are held (NOTE or MOTION mode) writes motion data to those steps
   * instead of changing the live parameter.
   */
  private writeHeldStepMotion(id: number, v: number): void {
    this.pendingToggle.clear() // an edit happened: held steps no longer toggle
    for (const i of this.heldSteps) {
      const lane = this.store.findMotionLane(id, true)
      if (lane >= 0) {
        this.store.writeMotionStep(lane, i, [v, v, v, v, v])
        // A written lane must play back: enable it (mirrors recKnob).
        this.store.setMotionLane(lane, { on: true, smooth: PARAMS[id].motionSmooth === true })
      }
    }
  }

  /**
   * Bind a 3-position switch whose silkscreen prints the REVERSE of the
   * program-data enum order (spec §2/§9: WAVE columns read SAW at the top,
   * SYNC/RING reads SYNC/OFF/RING, EG TYPE reads A/D|A/G/D|GATE, LFO MODE
   * reads FAST/SLOW/1-SHOT). Position index i maps to stored value n-1-i;
   * the binder adapter reverses store->control resyncs the same way.
   */
  private reversedSwitch(id: number, label: string): SelectorSwitch {
    const m = PARAMS[id]
    const labels = m.labels ? [...m.labels].reverse() : []
    const n = labels.length
    const sw = new SelectorSwitch({
      label,
      positions: labels,
      value: n - 1 - Math.round(this.store.getParam(id)),
      onInput: (pos) => this.store.setParam(id, n - 1 - pos, 'ui'),
    })
    this.binder.bind(id, {
      setValue: (v, o) => sw.setValue(n - 1 - Math.round(v), o),
    })
    return sw
  }

  private onParamChange(id: number, v: number, source: string): void {
    if (source !== 'ui') {
      // resync statically bound controls (panel-originated edits already show)
      this.binder.resync(id, v)
    }
    // side effects that must run for every source (including 'ui')
    // (silent: programmatic shifts must not echo back through onOctaveShift)
    if (id === P.OCTAVE) this.keyboard.setOctaveShift(v - 2, { silent: true })
    if (id === P.KEY_TRIG) this.syncKeyTrg()
    if (id === P.SLIDER_ASSIGN) this.syncSlider()
  }

  private resyncAll(): void {
    this.binder.resyncAll()
    this.syncKeyTrg()
    this.syncSlider()
    this.syncTempo()
    this.updateStepLeds()
    this.updateProgramReadout()
    this.syncRec()
    this.keyboard.setOctaveShift(this.store.getParam(P.OCTAVE) - 2, { silent: true })
  }

  /* ================================================================ */
  /* KEY TRG/HOLD button                                               */
  /* ================================================================ */

  private keyTrgPress(): void {
    this.keyTrgDownAt = Date.now()
  }

  /** Tap: Off <-> KEY TRG (a tap from HOLD releases to Off). Hold >500ms:
   *  latch HOLD / release it (spec §8; og ARP-latch gesture precedent). */
  private keyTrgRelease(): void {
    const v = Math.round(this.store.getParam(P.KEY_TRIG))
    if (Date.now() - this.keyTrgDownAt > KEY_TRG_HOLD_MS) {
      this.store.setParam(P.KEY_TRIG, v === 2 ? 0 : 2, 'ui')
    } else {
      this.store.setParam(P.KEY_TRIG, v === 0 ? 1 : 0, 'ui')
    }
    // the momentary button zeroes its own LED after release — re-assert
    queueMicrotask(() => this.syncKeyTrg())
  }

  /** LED lit while active; blinking = latched HOLD (the family latch look). */
  private syncKeyTrg(): void {
    const v = Math.round(this.store.getParam(P.KEY_TRIG))
    this.keyTrgBtn.setValue(v > 0 ? 1 : 0, { silent: true })
    this.keyTrgBtn.el.classList.toggle('xd-blink', v === 2)
  }

  /* ================================================================ */
  /* SLIDER (assignable bender — og machinery over the mono table)     */
  /* ================================================================ */

  private sliderAssign(): number {
    return Math.round(this.store.getParam(P.SLIDER_ASSIGN))
  }

  /** (Re)build the slider for the current assignment: PITCH BEND springs
   *  back to center, every other destination holds position. */
  private buildSlider(): void {
    const assign = this.sliderAssign()
    this.sliderBuiltAssign = assign
    this.slider = new Slider({
      spring: sliderDestParam(assign) === SLIDER_DEST_PITCH_BEND,
      label: formatParam(P.SLIDER_ASSIGN, assign),
      onChange: (v) => this.sliderInput(v),
    })
    this.sliderWrap.replaceChildren(this.slider.el)
  }

  private syncSlider(): void {
    if (this.sliderAssign() !== this.sliderBuiltAssign) this.buildSlider()
  }

  private sliderInput(v: number): void {
    const dest = sliderDestParam(this.sliderAssign())
    if (dest === SLIDER_DEST_PITCH_BEND) {
      this.opts.onBend(v)
      this.store.recKnob(MOTION_PITCH_BEND, v) // gates on rec mode/playing internally
      return
    }
    this.opts.onJoyY(v) // engine resolves the assigned destination
    if (dest === SLIDER_DEST_GATE_TIME) {
      this.store.recKnob(MOTION_GATE_TIME, v)
    } else if (dest >= 0) {
      // Record the effective absolute value the engine plays back for this
      // param (knob raw + slider offset, the engine's slider-layer mapping).
      const m = PARAMS[dest]
      const rangePct = (this.store.getParam(P.SLIDER_RANGE) - 100) / 100
      this.store.recKnob(dest, this.store.getParam(dest) + v * rangePct * (m.max - m.min))
    }
  }

  /* ================================================================ */
  /* keyboard notes (incl. hold-step note entry + rec)                 */
  /* ================================================================ */

  private handleNoteOn(note: number, vel: number): void {
    if (this.heldSteps.size > 0 && this.editMode() === EDIT_NOTE) {
      // step edit: held step(s) + key writes the step's note. The monologue
      // sequencer is monophonic — one note per step (spec §8) — so each key
      // press REPLACES the note (last-note priority), no chord accumulation.
      // The played velocity is stored for the shared data model even though
      // the hardware records note-only steps (spec §8).
      this.pendingToggle.clear()
      const gate = this.store.program.seq.defaultGate
      for (const i of this.heldSteps) {
        this.store.setStep(i, [note], [vel], [gate])
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

  /** Current MOTION/SLIDE/NOTE switch position (EDIT_* constants). */
  private editMode(): number {
    return this.editSwitch.getValue()
  }

  /** Mode switch flip: nothing can stay held across a mode change. */
  private editModeChanged(): void {
    this.heldSteps.clear()
    this.pendingToggle.clear()
    this.updateStepLeds()
  }

  private stepPress(i: number): void {
    const mode = this.editMode()
    if (mode === EDIT_SLIDE) {
      // SLIDE: a press toggles the step's slide flag immediately (spec §8).
      this.store.setStepSlide(i, this.store.program.seq.steps[i].slide !== true)
      return
    }
    if (mode === EDIT_NOTE && this.store.recMode === 'step') {
      this.store.jumpStepRec(i)
      return
    }
    // NOTE + MOTION modes hold the step for knob-move motion writes; only
    // NOTE mode arms the tap-equals-mute-toggle behavior.
    this.heldSteps.add(i)
    if (mode === EDIT_NOTE) this.pendingToggle.add(i)
  }

  private stepRelease(i: number): void {
    const pending = this.pendingToggle.delete(i)
    const wasHeld = this.heldSteps.delete(i)
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

  /** True when any assigned motion lane holds data at step i. Lanes count as
   *  "active" once assigned (paramId set) even while toggled off — MOTION
   *  view surfaces recorded data, not playback state (replica judgment). */
  private stepHasMotion(i: number): boolean {
    for (const l of this.store.program.seq.motion) {
      if (l.paramId !== -1 && l.data[i] !== null) return true
    }
    return false
  }

  private updateStepLeds(): void {
    const seq = this.store.program.seq
    const mode = this.editMode()
    const stepRec = this.store.recMode === 'step'
    const cursor = this.store.stepRecCursor
    for (let i = 0; i < NUM_STEPS; i++) {
      let s: StepState
      if (this.playheadI === i) {
        s = 'playing'
      } else if (i >= seq.stepLength) {
        s = 'off'
      } else if (mode === EDIT_SLIDE) {
        // SLIDE view: dim LED = the step glides into the next one (spec §8)
        s = seq.steps[i].slide === true ? 'dim' : 'off'
      } else if (mode === EDIT_MOTION) {
        // MOTION view: lit LED = motion data recorded on this step
        s = this.stepHasMotion(i) ? 'on' : 'off'
      } else if (stepRec && cursor === i) {
        s = 'rec'
      } else {
        const st = seq.steps[i]
        if (st.notes.length === 0) s = 'off'
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

  private updateProgramReadout(): void {
    this.progNum.textContent = String(this.store.slot + 1).padStart(3, '0')
    this.progName.textContent = this.store.program.name
  }

  /** WRITE commits the program (green flash / ~1s error blink, like the og). */
  private writePress(): void {
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

  /** Program readout: browser over all slots, plus rename (og pattern). */
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
      format: (v) => fmtPercent01(v),
      onInput: (v) => this.opts.onMaster(v),
    })

    // DRIVE lives beside MASTER on the hardware (spec §2) — a continuous
    // program param (P.DRIVE), unlike the analog MASTER volume.
    const drive = this.binder.paramKnob(P.DRIVE, 'm', { label: 'DRIVE' })

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

    const octave = this.binder.paramSwitch(P.OCTAVE, { label: 'OCTAVE' })

    return section(
      'MASTER',
      'mono-sec-master',
      row('xd-ctl-row', master.el, drive.el, this.tempoKnob.el),
      row('xd-ctl-row', octave.el),
    )
  }

  private buildVco1(): HTMLElement {
    // No pitch/octave/level controls on VCO1 (spec §2): pitch follows the
    // master OCTAVE, level is the MIXER knob.
    const wave = this.reversedSwitch(P.VCO1_WAVE, 'WAVE') // SAW/TRI/SQR top-to-bottom
    const shape = this.binder.paramKnob(P.VCO1_SHAPE, 'm', { label: 'SHAPE' })
    return section(
      'VCO 1',
      'mono-sec-vco1',
      row('xd-ctl-row', wave.el),
      row('xd-ctl-row', shape.el),
    )
  }

  private buildVco2(): HTMLElement {
    const oct = this.binder.paramSwitch(P.VCO2_OCTAVE, { label: 'OCTAVE' })
    const wave = this.reversedSwitch(P.VCO2_WAVE, 'WAVE') // SAW/TRI/NOISE top-to-bottom
    const syncRing = this.reversedSwitch(P.SYNC_RING, 'SYNC/RING') // SYNC/OFF/RING
    const pitch = this.binder.paramKnob(P.VCO2_PITCH, 'm', { label: 'PITCH', bipolar: true })
    const shape = this.binder.paramKnob(P.VCO2_SHAPE, 'm', { label: 'SHAPE' })
    return section(
      'VCO 2',
      'mono-sec-vco2',
      row('xd-ctl-row', oct.el, wave.el, syncRing.el),
      row('xd-ctl-row', pitch.el, shape.el),
    )
  }

  private buildMixer(): HTMLElement {
    const v1 = this.binder.paramKnob(P.VCO1_LEVEL, 'm', { label: 'VCO 1' })
    const v2 = this.binder.paramKnob(P.VCO2_LEVEL, 'm', { label: 'VCO 2' })
    return section('MIXER', 'mono-sec-mixer', row('xd-ctl-row xd-ctl-col', v1.el, v2.el))
  }

  private buildFilter(): HTMLElement {
    // Just the two knobs (spec §4) — keytrack/velocity are menu params (§11).
    const cutoff = this.binder.paramKnob(P.CUTOFF, 'xl', { label: 'CUTOFF' })
    const reso = this.binder.paramKnob(P.RESONANCE, 'l', { label: 'RESONANCE' })
    return section(
      'FILTER',
      'mono-sec-filter',
      row('xd-ctl-row mono-filter-row', cutoff.el, reso.el),
    )
  }

  private buildEg(): HTMLElement {
    const type = this.reversedSwitch(P.EG_TYPE, 'TYPE') // A/D | A/G/D | GATE top-to-bottom
    const a = this.binder.paramKnob(P.EG_ATTACK, 'm', { label: 'ATTACK' })
    const d = this.binder.paramKnob(P.EG_DECAY, 'm', { label: 'DECAY' })
    const int = this.binder.paramKnob(P.EG_INT, 'm', { label: 'INT', bipolar: true })
    // TARGET printed in the stored enum order (CUTOFF/PITCH 2/PITCH);
    // hardware silkscreen order UNCONFIRMED.
    const target = this.binder.paramSwitch(P.EG_TARGET, { label: 'TARGET' })
    return section(
      'EG',
      'mono-sec-eg',
      row('xd-ctl-row', type.el, a.el, d.el, int.el, target.el),
    )
  }

  private buildLfo(): HTMLElement {
    // WAVE printed SAW/TRI/SQR like the VCO1 column (silkscreen order
    // UNCONFIRMED — assumed to match the VCO wave switches).
    const wave = this.reversedSwitch(P.LFO_WAVE, 'WAVE')
    const mode = this.reversedSwitch(P.LFO_MODE, 'MODE') // FAST/SLOW/1-SHOT
    const rate = this.binder.paramKnob(P.LFO_RATE, 'm', {
      label: 'RATE',
      format: (v) => this.formatLfoRate(v),
    })
    const int = this.binder.paramKnob(P.LFO_INT, 'm', { label: 'INT', bipolar: true })
    // TARGET printed in the stored enum order (CUTOFF/SHAPE/PITCH);
    // hardware silkscreen order UNCONFIRMED.
    const target = this.binder.paramSwitch(P.LFO_TARGET, { label: 'TARGET' })
    return section(
      'LFO',
      'mono-sec-lfo',
      row('xd-ctl-row', wave.el, mode.el, rate.el, int.el, target.el),
    )
  }

  /** Mode-aware RATE readout: BPM-sync division when synced, otherwise the
   *  Hz value of the current LFO MODE's range (curves.lfoRateToHz). */
  private formatLfoRate(v: number): string {
    if (this.store.getParam(P.LFO_BPM_SYNC) === 1) {
      return curves.LFO_BPM_DIVISIONS[curves.lfoBpmDivIndex(v)].label
    }
    return fmtHz(curves.lfoRateToHz(v, Math.round(this.store.getParam(P.LFO_MODE))))
  }

  private buildProgram(): HTMLElement {
    this.progNum = div('xd-prog-num')
    this.progName = div('xd-prog-name')
    this.progReadout = div('xd-prog-readout')
    this.progReadout.classList.add('xd-clickable-readout')
    this.progReadout.title = 'browse programs'
    // click = program browser (with Rename inside); dblclick rename stays.
    this.progReadout.addEventListener('click', () => this.openProgramMenu(this.progReadout))
    this.progName.addEventListener('dblclick', () => this.renamePrompt())
    this.progReadout.append(this.progNum, this.progName)

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
    // EXIT dismisses any open readout menu (display-menu paging comes with
    // the OLED module); EDIT opens the program browser (edit-mode stand-in).
    const exitBtn = new LedButton({ label: 'EXIT', onPress: () => closeMenu() })
    const editBtn = new LedButton({
      label: 'EDIT',
      onPress: () => this.openProgramMenu(this.progReadout),
    })

    const top = div('xd-prog-top')
    top.append(this.progReadout, midiWrap)

    const side = div('mono-prog-side')
    side.append(enc.el, row('mono-prog-btns', this.writeBtn.el, exitBtn.el, editBtn.el))

    const main = div('xd-prog-main')
    main.append(this.displaySlot, side)

    return section('PROGRAM', 'mono-sec-prog', top, main)
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

    this.keyTrgBtn = new LedButton({
      label: 'KEY TRG/HOLD',
      onPress: () => this.keyTrgPress(),
      onRelease: () => this.keyTrgRelease(),
    })

    // Silkscreened 'STEP EDIT' here to avoid clashing with the hardware's
    // separate EDIT MODE menu button (replica labeling choice).
    this.editSwitch = new SelectorSwitch({
      label: 'STEP EDIT',
      positions: [...EDIT_LABELS],
      value: EDIT_NOTE,
      onInput: () => this.editModeChanged(),
    })

    const ctl = div('mono-seq-ctl')
    ctl.append(this.keyTrgBtn.el, this.editSwitch.el)

    // The monologue hardware HAS the 16-button strip (spec §2) — always
    // visible, no STEPS chip like the og.
    const steps = div('xd-seq-steps mono-seq-steps')
    for (let i = 0; i < NUM_STEPS; i++) {
      const b = new StepButton({
        index: i,
        onPress: (idx) => this.stepPress(idx),
        onRelease: (idx) => this.stepRelease(idx),
      })
      this.stepBtns.push(b)
      steps.append(b.el)
    }

    return row('xd-row xd-row-seq mono-row-seq', transport, ctl, steps)
  }
}
