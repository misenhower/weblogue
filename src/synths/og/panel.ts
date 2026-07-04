/**
 * Skeuomorphic front-panel UI for the ORIGINAL minilogue (OG) replica.
 *
 * Mirrors src/synths/xd/panel.ts: one Panel instance builds the hardware face
 * from the primitives in components.ts plus Keyboard and the horizontal
 * Slider (the OG's pitch/mod bender — the xd has a joystick instead), and
 * two-way binds every control to the Store:
 *
 *   control.onInput  -> store.setParam / seq methods
 *   store.onParam    -> control.setValue(v, { silent: true })
 *   store.onProgram  -> full resync (knobs, switches, readouts, step LEDs)
 *   store.onSeq      -> step LEDs + tempo
 *   store.onRecChange-> REC LED + step-rec cursor
 *
 * OG-specific hardware behavior:
 *   - VOICE MODE is 8 dedicated LED buttons (POLY..SIDE CHAIN), lit =
 *     selected; holding ARP >500ms toggles ARP LATCH (blinking LED while
 *     latched, like the xd's latch treatment).
 *   - The SLIDER follows P.SLIDER_ASSIGN: assignment 0 (PITCH BEND) is a
 *     spring-return bender feeding opts.onBend; every other assignment holds
 *     position and feeds opts.onJoyY (the engine resolves the destination).
 *     The slider is rebuilt whenever the assignment changes. Moves are also
 *     motion-recorded (recKnob): PITCH BEND / GATE TIME as their virtual
 *     motion targets, param destinations as the effective absolute value the
 *     engine will play back.
 *   - The hardware has no 16-step button strip; an optional strip (xd
 *     behavior: step edit, motion write on held steps, playhead LEDs) hides
 *     behind a small STEPS chip, persisted in localStorage 'og-step-strip'.
 *
 * Layout/styling lives in src/ui/panel.css under the .og- prefix (logical
 * panel width 1500, scale var --og-scale); shared chrome (sections, legends,
 * OLED wells, LED animations) reuses the xd- classes from theme.css/panel.css.
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
import { fmtPercent01 } from '../../shared/maps'
import * as curves from './curves'
import { NUM_STEPS, NOTES_PER_STEP } from '../../shared/program'
import { MOTION_PITCH_BEND, MOTION_GATE_TIME } from '../../shared/paramdef'
import {
  Knob,
  LedButton,
  StepButton,
  EncoderWheel,
  Led,
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
/** OG TEMPO knob range (og-spec §2; SEQ EDIT accepts 10..300 via the menu). */
const TEMPO_MIN = 56
const TEMPO_MAX = 240
/** Hold the ARP voice-mode button this long to toggle latch (hardware gesture). */
const ARP_HOLD_MS = 500
/** localStorage key for the optional 16-step strip visibility. */
const STEP_STRIP_LS = 'og-step-strip'

export class Panel {
  el: HTMLElement
  /** Empty well where the OLED module mounts later (~330x140). */
  displaySlot: HTMLElement
  keyboard: Keyboard

  private store: Store
  private opts: PanelOpts

  /** param-bound knobs/switches (shared binding plumbing, ui/parambinder) */
  private binder: ParamBinder

  /* voice mode buttons (one per mode; lit = selected) */
  private vmBtns: LedButton[] = []
  private arpDownAt = 0

  /* SLIDER (rebuilt whenever P.SLIDER_ASSIGN changes) */
  private slider!: Slider
  private sliderWrap!: HTMLElement
  private sliderBuiltAssign = -1

  /* transport / rec */
  private playBtn!: LedButton
  private recBtn!: LedButton
  private restHeld = false
  private playheadI = -1

  /* optional step strip */
  private stepsVisible = false
  private stepsWrap!: HTMLElement
  private stepsChip!: HTMLButtonElement

  /* step-edit hold state */
  private heldSteps = new Set<number>()
  private pendingToggle = new Set<number>()
  private holdWrote = new Set<number>()

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
      onNoteOn: (n, v) => this.handleNoteOn(n, v),
      onNoteOff: (n) => this.handleNoteOff(n),
    })

    /* ---- build DOM ------------------------------------------------ */
    const scale = div('og-panel-scale')
    const panel = div('xd-panel og-panel-root')
    scale.append(panel)
    this.el = scale

    this.displaySlot = div('xd-display-slot')

    const rowA = row(
      'xd-row og-row og-row-a',
      this.buildMaster(),
      this.buildVco1(),
      this.buildVco2(),
      this.buildMixer(),
      this.buildFilter(),
      this.buildAmpEg(),
      this.buildEg(),
    )
    const rowB = row(
      'xd-row og-row og-row-b',
      this.buildProgram(),
      this.buildVoiceMode(),
      this.buildLfo(),
      this.buildDelay(),
    )
    const rowSeq = this.buildSeqStrip()

    this.sliderWrap = div('og-slider-block')
    this.buildSlider()
    const rowKbd = row('xd-row xd-row-kbd og-row-kbd', this.sliderWrap, this.keyboard.el)

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

    this.setStepsVisible(this.loadStepsVisible(), false)
    this.resyncAll()
  }

  /* ================================================================ */
  /* public API                                                        */
  /* ================================================================ */

  /** -1 = stopped; drives step-button 'playing' states (safe when hidden). */
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
   * binder.knobInput diversion (xd behavior, spec step edit): a knob move
   * while step buttons are held (step strip visible) writes motion data to
   * those steps instead of changing the live parameter.
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

  private onParamChange(id: number, v: number, source: string): void {
    if (source !== 'ui') {
      // resync statically bound controls (panel-originated edits already show)
      this.binder.resync(id, v)
    }
    // side effects that must run for every source (including 'ui')
    // (silent: programmatic shifts must not echo back through onOctaveShift)
    if (id === P.OCTAVE) this.keyboard.setOctaveShift(v - 2, { silent: true })
    if (id === P.VOICE_MODE) this.syncVoiceLeds()
    if (id === P.ARP_LATCH) this.syncArpLatchLed()
    if (id === P.SLIDER_ASSIGN) this.syncSlider()
  }

  private resyncAll(): void {
    this.binder.resyncAll()
    this.syncVoiceLeds()
    this.syncArpLatchLed()
    this.syncSlider()
    this.syncTempo()
    this.updateStepLeds()
    this.updateProgramReadout()
    this.syncRec()
    this.keyboard.setOctaveShift(this.store.getParam(P.OCTAVE) - 2, { silent: true })
  }

  /* ================================================================ */
  /* VOICE MODE buttons                                                */
  /* ================================================================ */

  private vmPress(i: number): void {
    if (i === 6) this.arpDownAt = Date.now()
    this.store.setParam(P.VOICE_MODE, i, 'ui')
  }

  private vmRelease(i: number): void {
    // hardware gesture: hold ARP (button 7) >500ms toggles latch
    if (i === 6 && Date.now() - this.arpDownAt > ARP_HOLD_MS) {
      this.store.setParam(P.ARP_LATCH, this.store.getParam(P.ARP_LATCH) === 1 ? 0 : 1, 'ui')
    }
    // the momentary button zeroes its own LED after release — re-assert
    queueMicrotask(() => this.syncVoiceLeds())
  }

  private syncVoiceLeds(): void {
    const mode = Math.round(this.store.getParam(P.VOICE_MODE))
    for (let i = 0; i < this.vmBtns.length; i++) {
      this.vmBtns[i].setValue(i === mode ? 1 : 0, { silent: true })
    }
  }

  /** ARP button LED blinks while latched (the xd's latch treatment). */
  private syncArpLatchLed(): void {
    const arp = this.vmBtns[6]
    if (arp) arp.el.classList.toggle('xd-blink', this.store.getParam(P.ARP_LATCH) === 1)
  }

  /* ================================================================ */
  /* SLIDER (assignable bender)                                        */
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
  /* keyboard notes (incl. hold-step chord entry + rec)                */
  /* ================================================================ */

  private handleNoteOn(note: number, vel: number): void {
    if (this.heldSteps.size > 0) {
      // step edit: held step(s) + key writes notes into those steps
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

  private loadStepsVisible(): boolean {
    try {
      return (globalThis as { localStorage?: Storage }).localStorage?.getItem(STEP_STRIP_LS) === '1'
    } catch {
      return false
    }
  }

  private setStepsVisible(on: boolean, persist = true): void {
    this.stepsVisible = on
    this.stepsWrap.hidden = !on
    this.stepsChip.classList.toggle('is-on', on)
    this.stepsChip.setAttribute('aria-pressed', on ? 'true' : 'false')
    if (!on) {
      // nothing can stay held inside a hidden strip
      this.heldSteps.clear()
      this.pendingToggle.clear()
      this.holdWrote.clear()
    }
    if (persist) {
      try {
        ;(globalThis as { localStorage?: Storage }).localStorage?.setItem(STEP_STRIP_LS, on ? '1' : '0')
      } catch {
        /* storage unavailable: the toggle still works for this session */
      }
    }
  }

  private stepPress(i: number): void {
    if (this.store.recMode === 'step') {
      this.store.jumpStepRec(i)
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

  private updateProgramReadout(): void {
    this.progNum.textContent = String(this.store.slot + 1).padStart(3, '0')
    this.progName.textContent = this.store.program.name
  }

  /** WRITE commits the program (green flash / ~1s error blink, like the xd). */
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

  /** Program readout: browser over all slots, plus rename (xd pattern). */
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
      'og-sec-master',
      row('xd-ctl-row', master.el, this.tempoKnob.el),
      row('xd-ctl-row', octave.el),
    )
  }

  private buildVco1(): HTMLElement {
    const wave = this.binder.paramSwitch(P.VCO1_WAVE, { label: 'WAVE' })
    const oct = this.binder.paramSwitch(P.VCO1_OCTAVE, { label: 'OCTAVE' })
    const pitch = this.binder.paramKnob(P.VCO1_PITCH, 'm', { label: 'PITCH', bipolar: true })
    const shape = this.binder.paramKnob(P.VCO1_SHAPE, 'm', { label: 'SHAPE' })
    return section(
      'VCO 1',
      'og-sec-vco1',
      row('xd-ctl-row', wave.el, oct.el),
      row('xd-ctl-row', pitch.el, shape.el),
    )
  }

  private buildVco2(): HTMLElement {
    const wave = this.binder.paramSwitch(P.VCO2_WAVE, { label: 'WAVE' })
    const oct = this.binder.paramSwitch(P.VCO2_OCTAVE, { label: 'OCTAVE' })
    const pitch = this.binder.paramKnob(P.VCO2_PITCH, 'm', { label: 'PITCH', bipolar: true })
    const shape = this.binder.paramKnob(P.VCO2_SHAPE, 'm', { label: 'SHAPE' })
    // VCO2 MODULATION sub-section (og-spec §4): cross mod, pitch EG, sync, ring
    const cross = this.binder.paramKnob(P.CROSS_MOD, 'm', { label: 'CROSS MOD DEPTH' })
    const egInt = this.binder.paramKnob(P.PITCH_EG_INT, 'm', { label: 'PITCH EG INT', bipolar: true })
    const sync = this.binder.paramSwitch(P.SYNC, { label: 'SYNC' })
    const ring = this.binder.paramSwitch(P.RING, { label: 'RING' })
    return section(
      'VCO 2',
      'og-sec-vco2',
      row('xd-ctl-row', wave.el, oct.el),
      row('xd-ctl-row', pitch.el, shape.el),
      div('xd-legend xd-legend--dim og-subhead', 'VCO 2 MODULATION'),
      row('xd-ctl-row', cross.el, egInt.el, sync.el, ring.el),
    )
  }

  private buildMixer(): HTMLElement {
    const v1 = this.binder.paramKnob(P.VCO1_LEVEL, 'm', { label: 'VCO 1' })
    const v2 = this.binder.paramKnob(P.VCO2_LEVEL, 'm', { label: 'VCO 2' })
    const noise = this.binder.paramKnob(P.NOISE_LEVEL, 'm', { label: 'NOISE' })
    return section(
      'MIXER',
      'og-sec-mixer',
      row('xd-ctl-row xd-ctl-col', v1.el, v2.el, noise.el),
    )
  }

  private buildFilter(): HTMLElement {
    const cutoff = this.binder.paramKnob(P.CUTOFF, 'xl', { label: 'CUTOFF' })
    const reso = this.binder.paramKnob(P.RESONANCE, 'l', { label: 'RESONANCE' })
    const egInt = this.binder.paramKnob(P.EG_INT, 'm', { label: 'EG INT', bipolar: true })
    const type = this.binder.paramSwitch(P.FILTER_TYPE, { label: 'FILTER TYPE' })
    const keytrack = this.binder.paramSwitch(P.KEYTRACK, { label: 'KEY TRACK' })
    const velo = this.binder.paramSwitch(P.CUTOFF_VELOCITY, { label: 'VELOCITY' })
    const right = div('og-filter-right')
    right.append(
      row('xd-ctl-row', reso.el, egInt.el),
      row('xd-ctl-row', type.el, keytrack.el, velo.el),
    )
    return section('FILTER', 'og-sec-filter', row('xd-ctl-row og-filter-row', cutoff.el, right))
  }

  private buildAmpEg(): HTMLElement {
    const a = this.binder.paramKnob(P.AMP_ATTACK, 'm', { label: 'ATTACK' })
    const d = this.binder.paramKnob(P.AMP_DECAY, 'm', { label: 'DECAY' })
    const s = this.binder.paramKnob(P.AMP_SUSTAIN, 'm', { label: 'SUSTAIN' })
    const r = this.binder.paramKnob(P.AMP_RELEASE, 'm', { label: 'RELEASE' })
    return section('AMP EG', 'og-sec-amp', row('xd-ctl-row', a.el, d.el, s.el, r.el))
  }

  private buildEg(): HTMLElement {
    const a = this.binder.paramKnob(P.EG_ATTACK, 'm', { label: 'ATTACK' })
    const d = this.binder.paramKnob(P.EG_DECAY, 'm', { label: 'DECAY' })
    const s = this.binder.paramKnob(P.EG_SUSTAIN, 'm', { label: 'SUSTAIN' })
    const r = this.binder.paramKnob(P.EG_RELEASE, 'm', { label: 'RELEASE' })
    return section('EG', 'og-sec-eg', row('xd-ctl-row', a.el, d.el, s.el, r.el))
  }

  private buildLfo(): HTMLElement {
    const wave = this.binder.paramSwitch(P.LFO_WAVE, { label: 'WAVE' })
    const egMod = this.binder.paramSwitch(P.LFO_EG_MOD, { label: 'EG MOD' })
    const target = this.binder.paramSwitch(P.LFO_TARGET, { label: 'TARGET' })
    const rate = this.binder.paramKnob(P.LFO_RATE, 'm', {
      label: 'RATE',
      format: (v) =>
        this.store.getParam(P.LFO_BPM_SYNC) === 1
          ? curves.LFO_BPM_DIVISIONS[curves.lfoBpmDivIndex(v)].label
          : formatParam(P.LFO_RATE, v),
    })
    const int = this.binder.paramKnob(P.LFO_INT, 'm', { label: 'INT' }) // unipolar on the OG
    return section(
      'LFO',
      'og-sec-lfo',
      row('xd-ctl-row', wave.el, egMod.el, target.el),
      row('xd-ctl-row', rate.el, int.el),
    )
  }

  private buildDelay(): HTMLElement {
    const hipass = this.binder.paramKnob(P.DELAY_HIPASS, 'm', { label: 'HI PASS CUTOFF' })
    const time = this.binder.paramKnob(P.DELAY_TIME, 'm', { label: 'TIME' })
    const feedback = this.binder.paramKnob(P.DELAY_FEEDBACK, 'm', { label: 'FEEDBACK' })
    const routing = this.binder.paramSwitch(P.DELAY_ROUTING, { label: 'OUTPUT ROUTING' })
    return section(
      'DELAY',
      'og-sec-delay',
      row('xd-ctl-row', hipass.el, time.el, feedback.el),
      row('xd-ctl-row', routing.el),
    )
  }

  private buildVoiceMode(): HTMLElement {
    const labels = PARAMS[P.VOICE_MODE].labels ?? []
    const btns = div('og-vm-btns')
    for (let i = 0; i < labels.length; i++) {
      const b = new LedButton({
        label: labels[i],
        onPress: () => this.vmPress(i),
        onRelease: () => this.vmRelease(i),
      })
      this.vmBtns.push(b)
      btns.append(b.el)
    }
    const depth = this.binder.paramKnob(P.VM_DEPTH, 'l', {
      label: 'DEPTH',
      format: (v) => this.formatVmDepth(v),
    })
    return section('VOICE MODE', 'og-sec-vm', row('xd-ctl-row', btns, depth.el))
  }

  private formatVmDepth(v: number): string {
    switch (Math.round(this.store.getParam(P.VOICE_MODE))) {
      case 0: // POLY: chord invert 0..8
        return 'Invert ' + curves.polyInvert(v)
      case 1: // DUO
        return curves.duoDetuneCents(v).toFixed(1) + ' Cent'
      case 2: // UNISON
        return curves.unisonDetuneCents(v).toFixed(1) + ' Cent'
      case 3: { // MONO: sub-oscillator mix
        const m = curves.monoSubMix(v)
        return 'Sub ' + Math.round(m.sub1 * 100) + '/' + Math.round(m.sub2 * 100)
      }
      case 4: // CHORD
        return curves.CHORDS[curves.chordIndex(v)].name
      case 5: // DELAY: tempo-synced echo spacing
        return curves.delayModeDivision(v).label
      case 6: // ARP
        return curves.ARP_TYPES[curves.arpTypeIndex(v)]
      default: // SIDE CHAIN: duck amount
        return Math.round((v / 1023) * 100) + '%'
    }
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

    const side = div('og-prog-side')
    side.append(enc.el, row('og-prog-btns', this.writeBtn.el, exitBtn.el, editBtn.el))

    const main = div('xd-prog-main')
    main.append(this.displaySlot, side)

    return section('PROGRAM', 'og-sec-prog', top, main)
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

    // The OG hardware has no 16-button strip — this one is an optional
    // convenience, hidden behind the STEPS chip (persisted in localStorage).
    this.stepsChip = document.createElement('button')
    this.stepsChip.type = 'button'
    this.stepsChip.className = 'og-steps-chip'
    this.stepsChip.textContent = 'STEPS'
    this.stepsChip.title = 'show/hide the 16-step editing strip'
    this.stepsChip.addEventListener('click', () => this.setStepsVisible(!this.stepsVisible))

    this.stepsWrap = div('xd-seq-steps og-seq-steps')
    for (let i = 0; i < NUM_STEPS; i++) {
      const b = new StepButton({
        index: i,
        onPress: (idx) => this.stepPress(idx),
        onRelease: (idx) => this.stepRelease(idx),
      })
      this.stepBtns.push(b)
      this.stepsWrap.append(b.el)
    }

    return row('xd-row xd-row-seq og-row-seq', transport, this.stepsChip, this.stepsWrap)
  }
}
