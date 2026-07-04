/**
 * Skeuomorphic front-panel UI for the Korg prologue replica — ONE Panel class
 * serves BOTH hardware variants ({ variant: 8 | 16 } in PanelOpts; programs
 * are format-identical, prologue-spec.md §14):
 *
 *   prologue-8 : 49 keys, no TIMBRE section / VOICE SPREAD knob / L.F. COMP
 *                (timbre + spread stay reachable via the display's PROG EDIT
 *                menu — see display-def.ts)
 *   prologue-16: 61 keys + TIMBRE section (SUB ON, BALANCE, TYPE, PANEL
 *                edit-select), VOICE SPREAD knob and the L.F. COMP block.
 *
 * Mirrors the xd panel (the closest family member: multi engine, grouped FX
 * pickers, SHIFT-rebound SHAPE knob) with the og program strip (PROGRAM/VALUE
 * encoder + WRITE/EXIT/EDIT). Store contract as everywhere:
 *
 *   control.onInput  -> store.setParam
 *   store.onParam    -> control.setValue(v, { silent: true })
 *   store.onProgram  -> full resync
 *   store.onSeq      -> TEMPO knob
 *
 * prologue-specific behavior:
 *   - TIMBRE SCOPING (the panel's crux, spec §2/§11): every per-timbre
 *     control binds to the TIMBRE 1 or TIMBRE 2 param id selected by the
 *     program-global EDIT TIMBRE param. An EDIT TIMBRE change silently
 *     resyncs all timbre-scoped controls to the newly addressed block (the
 *     xd's engine-select dynamic-rebind precedent — no 'ui' echo). The '+'
 *     (Main+Sub) position edits MAIN: the hardware shows the layered state
 *     there and which timbre its knobs address is UNCONFIRMED — replica
 *     treats '+' like MAIN for editing.
 *   - The PANEL edit-select switch (16 only) prints SUB / + / MAIN
 *     top-to-bottom — the REVERSE of the stored enum (Main, Main+Sub, Sub;
 *     CC85 arrives in panel order too, see cc.ts) — the mono reversedSwitch
 *     precedent.
 *   - WHEELS: vertical pitch-bend (spring, bipolar -> onBend) and mod wheel
 *     (holds, unipolar 0..1 -> onJoyY; the engine resolves the per-timbre
 *     M.WHEEL ASSIGN destination) sit in a column left of the keybed.
 *   - MULTI ENGINE: xd pattern — NOISE/VPM/USR switch, octave, TYPE encoder
 *     + readout menu (grouped picker), SHAPE knob readdressed by type and by
 *     SHIFT (SHIFT SHAPE; NOISE has none, spec §6).
 *   - EFFECT: MOD FX on/off + grouped type/sub picker + SPEED/DEPTH;
 *     DELAY/REVERB as the exclusive 3-position switch [OFF, DELAY, REVERB]
 *     + type picker + TIME/DEPTH (SHIFT+DEPTH edits the FW2 DRY/WET, the
 *     xd's SHIFT-DEPTH precedent — DRY/WET is knob-kind so it has no menu
 *     page).
 *   - ARPEGGIATOR: ON/LATCH is one button — tap toggles Off <-> On, hold
 *     >500ms latches (blinking LED; og ARP-hold gesture precedent, exact
 *     hardware threshold UNCONFIRMED); RANGE/TYPE/RATE knobs; TEMPO binds
 *     Program.seq.bpm (the arp transport tempo, spec §15).
 *   - NO step strip, NO PLAY/REC transport row: the prologue has no
 *     sequencer and no motion recording (spec §10) — setPlayhead is a no-op.
 *   - L.F. COMP (16 only, spec §7): app-level state, NOT program data (zero
 *     MIDI/program presence on hardware) — GAIN + ON persist to localStorage
 *     like UI prefs and feed the optional onLfCompGain/onLfCompOn hooks. The
 *     GR meter renders a static VU face in v1: live gain-reduction needs
 *     engine telemetry (dsp/fx/lfcomp.ts grLevel), which lands with the
 *     engine.
 *
 * Layout/styling lives in src/ui/panel.css under the .prologue- prefix.
 * Logical panel widths: 1550 (prologue-8) / 1750 (prologue-16), set inline
 * per variant; scale var --prologue-scale (fitWidth = width + 16 margin,
 * the family formula).
 */
import type { Store } from '../../state/store'
import { NUM_SLOTS } from '../../state/persist'
import {
  P,
  PARAMS,
  formatParam,
  TIMBRE_BLOCKS,
  type TimbreKey,
} from './params'
import type { PrologueVariant } from './ids'
import { fmtPercent01, fmtHz } from '../../shared/maps'
import * as curves from './curves'
import { Knob, SelectorSwitch, LedButton, EncoderWheel, Led } from '../../ui/components'
import { div, row, section } from '../../ui/dom'
import { ParamBinder, type Bindable } from '../../ui/parambinder'
import { Keyboard } from '../../ui/keyboard'
import { Slider } from '../../ui/slider'
import { showMenu, closeMenu, type MenuItem } from '../../ui/menu'

export interface PanelOpts {
  store: Store
  /** Hardware variant: 8 = prologue-8, 16 = prologue-16 (spec §14). */
  variant: PrologueVariant
  onNoteOn(note: number, vel: number): void
  onNoteOff(note: number): void
  onBend(v: number): void
  onJoyY(v: number): void
  onMaster(v: number): void // master volume 0..1 (not a program param)
  /** L.F. COMP hooks (16 only; app-level state, not program data — spec §7). */
  onLfCompGain?(v: number): void // 0..1
  onLfCompOn?(on: boolean): void
}

const MASTER_DEFAULT = 0.8
/** TEMPO knob range. Hardware spans 30.0-600.0 (spec §2) but the shared
 *  transport clamps bpm to 10..300 (shared/program.ts) — the knob covers the
 *  reachable span; a documented deviation. */
const TEMPO_MIN = 30
const TEMPO_MAX = 300
/** xd SHIFT gesture: quick tap latches, hold >350ms is momentary. */
const SHIFT_HOLD_MS = 350
/** Hold ARP ON/LATCH this long to latch (og ARP-hold precedent; exact
 *  hardware threshold UNCONFIRMED). */
const ARP_HOLD_MS = 500
/** Keybed anchors per variant. UNCONFIRMED anchor notes (spec §14 gives only
 *  49/61 keys): 49 keys = E1..E5 (MIDI 28..76, the family's E-to-E look),
 *  61 keys = C2..C7 (MIDI 36..96, the standard 61-key C-to-C span). */
const KBD_RANGE: Record<PrologueVariant, readonly [number, number]> = {
  8: [28, 76],
  16: [36, 96],
}
/** Logical panel widths (px) — the 16 needs room for TIMBRE + L.F. COMP. */
const PANEL_WIDTH: Record<PrologueVariant, number> = { 8: 1550, 16: 1750 }
/** localStorage key for the L.F. COMP app-level state (16 only). */
const LFCOMP_LS = 'prologue-lfcomp'

/* per-multi-type timbre-param names (spec §6: NOISE has no shift shape) */
const MULTI_SELECTS = ['selectNoise', 'selectVpm', 'selectUser'] as const
const MULTI_SHAPES = ['shapeNoise', 'shapeVpm', 'shapeUser'] as const
const MULTI_SHIFTSHAPES = [null, 'shiftShapeVpm', 'shiftShapeUser'] as const

/** MOD FX per-type sub params, MODFX_TYPE order. */
const MODFX_SUBS = [
  P.MODFX_SUB_CHORUS,
  P.MODFX_SUB_ENSEMBLE,
  P.MODFX_SUB_PHASER,
  P.MODFX_SUB_FLANGER,
  P.MODFX_SUB_USER,
] as const

/** Any change in this set refreshes the EFFECT readouts. */
const FX_PANEL_IDS = new Set<number>([
  P.MODFX_ON,
  P.MODFX_TYPE,
  ...MODFX_SUBS,
  P.DLRV_SELECT,
  P.DELAY_SUB,
  P.REVERB_SUB,
])

/** Reverse lookup: timbre param id -> block index + semantic name, for
 *  routing external changes to the (possibly) bound timbre control. */
const TIMBRE_ID_INFO: ReadonlyMap<number, { t: 0 | 1; name: TimbreKey }> = (() => {
  const m = new Map<number, { t: 0 | 1; name: TimbreKey }>()
  for (const t of [0, 1] as const) {
    for (const [name, id] of Object.entries(TIMBRE_BLOCKS[t]) as [TimbreKey, number][]) {
      m.set(id, { t, name })
    }
  }
  return m
})()

export class Panel {
  el: HTMLElement
  /** Empty well where the OLED module mounts later (~330x140). */
  displaySlot: HTMLElement
  keyboard: Keyboard

  private store: Store
  private opts: PanelOpts
  private variant: PrologueVariant

  /** program-GLOBAL param binds (shared plumbing, ui/parambinder). */
  private binder: ParamBinder

  /** TIMBRE-SCOPED controls by semantic name — rebound (silently resynced)
   *  whenever EDIT TIMBRE re-addresses the block they edit. */
  private tControls = new Map<TimbreKey, Bindable>()

  /* voice mode buttons (one per mode; lit = selected; per-timbre param) */
  private vmBtns: LedButton[] = []

  /* MULTI ENGINE dynamic controls (rebound on type/SHIFT/EDIT TIMBRE) */
  private multiShapeKnob!: Knob
  private multiDisplay!: HTMLElement

  /* SHIFT (readdresses multi SHAPE -> SHIFT SHAPE, DL/RV DEPTH -> DRY/WET) */
  private shiftOn = false
  private shiftBtn!: LedButton
  private shiftDownAt = 0
  private shiftPressTurnedOn = false

  /* EFFECT readouts + the SHIFT-readdressed DL/RV depth knob */
  private modFxLine1!: HTMLElement
  private modFxLine2!: HTMLElement
  private dlRvLine1!: HTMLElement
  private dlRvLine2!: HTMLElement
  private dlRvDepthKnob!: Knob

  /* ARP ON/LATCH gesture */
  private arpBtn!: LedButton
  private arpDownAt = 0

  /* L.F. COMP app-level state (16 only; persisted like UI prefs) */
  private lfGain = 0.5
  private lfOn = false

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
    this.variant = opts.variant === 16 ? 16 : 8

    this.binder = new ParamBinder({
      store: this.store,
      params: PARAMS,
      formatParam,
      // No step strip on the prologue (spec §10): the motion-write diversion
      // never engages.
      isStepHeld: () => false,
      writeHeldStepMotion: () => {},
    })

    const [kbdLow, kbdHigh] = KBD_RANGE[this.variant]
    this.keyboard = new Keyboard({
      lowestNote: kbdLow,
      highestNote: kbdHigh,
      onNoteOn: (n, v) => this.opts.onNoteOn(n, v), // no rec paths (spec §10)
      onNoteOff: (n) => this.opts.onNoteOff(n),
    })

    if (this.variant === 16) this.loadLfComp()

    /* ---- build DOM ------------------------------------------------ */
    const width = PANEL_WIDTH[this.variant]
    const scale = div('prologue-panel-scale')
    scale.style.width = `${width}px`
    const panel = div(`xd-panel prologue-panel-root prologue-panel-root--${this.variant}`)
    panel.style.width = `${width}px`
    scale.append(panel)
    this.el = scale

    this.displaySlot = div('xd-display-slot')

    const rowASections = [
      this.buildMaster(),
      this.buildVoiceMode(),
      ...(this.variant === 16 ? [this.buildTimbre()] : []),
      this.buildVco1(),
      this.buildVco2(),
      this.buildModulation(),
      this.buildMulti(),
      this.buildMixer(),
      this.buildFilter(),
    ]
    const rowA = row('xd-row prologue-row prologue-row-a', ...rowASections)

    const rowBSections = [
      this.buildProgram(),
      this.buildAmpEg(),
      this.buildEg(),
      this.buildLfo(),
      this.buildFx(),
      this.buildArp(),
      ...(this.variant === 16 ? [this.buildLfComp()] : []),
    ]
    const rowB = row('xd-row prologue-row prologue-row-b', ...rowBSections)

    // Wheels column left of the keybed (spec §3): vertical spring pitch bend
    // + vertical non-spring unipolar mod wheel.
    const pitchWheel = new Slider({
      spring: true,
      orientation: 'vertical',
      label: 'PITCH',
      onChange: (v) => this.opts.onBend(v),
    })
    const modWheel = new Slider({
      spring: false,
      orientation: 'vertical',
      unipolar: true,
      label: 'MOD',
      onChange: (v) => this.opts.onJoyY(v),
    })
    const wheels = div('prologue-wheels')
    wheels.append(pitchWheel.el, modWheel.el)

    // Arp-only transport (spec §10): no PLAY/REC/step strip row at all.
    const rowKbd = row('xd-row xd-row-kbd prologue-row-kbd', wheels, this.keyboard.el)

    panel.append(rowA, rowB, rowKbd)

    /* ---- store subscriptions -------------------------------------- */
    this.store.onParam((id, v, source) => this.onParamChange(id, v, source))
    this.store.onProgram(() => this.resyncAll())
    this.store.onSeq(() => this.syncTempo())

    this.resyncAll()
  }

  /* ================================================================ */
  /* public API (SynthPanel surface)                                   */
  /* ================================================================ */

  /** No step strip on the prologue (spec §10) — nothing to light. */
  setPlayhead(_i: number): void {}

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
  /* timbre scoping (the crux)                                         */
  /* ================================================================ */

  /** Edited timbre block: 0 = MAIN, 1 = SUB. The '+' (Main+Sub) position
   *  edits MAIN — UNCONFIRMED interpretation (spec §3): hardware shows the
   *  layered state there; which timbre its knobs address is undocumented. */
  private editIndex(): 0 | 1 {
    return Math.round(this.store.getParam(P.EDIT_TIMBRE)) === 2 ? 1 : 0
  }

  /** Currently addressed param id for a timbre-scoped control. */
  private tid(name: TimbreKey): number {
    return TIMBRE_BLOCKS[this.editIndex()][name]
  }

  /** Timbre-scoped knob: binds to tid(name) at input time; registered for
   *  EDIT-TIMBRE rebinds. Both blocks share ranges/defaults (one spec list,
   *  params.ts) so only the value needs resyncing. */
  private tKnob(
    name: TimbreKey,
    size: 'xl' | 'l' | 'm',
    extra: { label: string; bipolar?: boolean; format?: (v: number) => string },
  ): Knob {
    const m = PARAMS[TIMBRE_BLOCKS[0][name]]
    const k = new Knob({
      label: extra.label,
      size,
      min: m.min,
      max: m.max,
      value: this.store.getParam(this.tid(name)),
      defaultValue: m.def,
      bipolar: extra.bipolar,
      format: extra.format ?? ((v) => formatParam(this.tid(name), v)),
      onInput: (v) => this.store.setParam(this.tid(name), v, 'ui'),
    })
    this.tControls.set(name, k)
    return k
  }

  /** Timbre-scoped selector switch (positions from the shared block meta). */
  private tSwitch(name: TimbreKey, label: string): SelectorSwitch {
    const m = PARAMS[TIMBRE_BLOCKS[0][name]]
    const s = new SelectorSwitch({
      label,
      positions: m.labels ? [...m.labels] : [],
      value: this.store.getParam(this.tid(name)),
      onInput: (v) => this.store.setParam(this.tid(name), v, 'ui'),
    })
    this.tControls.set(name, s)
    return s
  }

  /** EDIT TIMBRE re-addressed the per-timbre block: silently resync every
   *  timbre-scoped control to the new block's values (no 'ui' echo — the
   *  xd's dynamic-rebind pattern). */
  private resyncTimbre(): void {
    for (const [name, ctl] of this.tControls) {
      ctl.setValue(this.store.getParam(this.tid(name)), { silent: true })
    }
    this.rebindMultiShape()
    this.updateMultiDisplay()
    this.syncVoiceLeds()
  }

  private onParamChange(id: number, v: number, source: string): void {
    if (source !== 'ui') {
      // resync statically bound controls (panel-originated edits already show)
      this.binder.resync(id, v)
      // timbre-scoped controls: only if the change hits the ADDRESSED block
      const info = TIMBRE_ID_INFO.get(id)
      if (info && info.t === this.editIndex()) {
        this.tControls.get(info.name)?.setValue(v, { silent: true })
      }
      // dynamic knobs
      if (id === this.multiShapeId()) this.multiShapeKnob.setValue(v, { silent: true })
      if (id === this.dlRvDepthId()) this.dlRvDepthKnob.setValue(v, { silent: true })
    }
    // side effects that must run for every source (including 'ui')
    if (id === P.OCTAVE) this.keyboard.setOctaveShift(v - 2, { silent: true })
    if (id === P.EDIT_TIMBRE) this.resyncTimbre()
    const info = TIMBRE_ID_INFO.get(id)
    if (info && info.t === this.editIndex()) {
      if (info.name === 'multiType') {
        this.rebindMultiShape()
        this.updateMultiDisplay()
      } else if (info.name === 'selectNoise' || info.name === 'selectVpm' || info.name === 'selectUser') {
        this.updateMultiDisplay()
      } else if (info.name === 'voiceMode') {
        this.syncVoiceLeds()
      }
    }
    if (id === P.ARP_ON_LATCH) this.syncArpLed()
    if (FX_PANEL_IDS.has(id)) this.syncFxReadouts()
  }

  private resyncAll(): void {
    this.binder.resyncAll()
    this.resyncTimbre()
    this.rebindDlRvDepth()
    this.syncFxReadouts()
    this.syncArpLed()
    this.syncTempo()
    this.updateProgramReadout()
    this.keyboard.setOctaveShift(this.store.getParam(P.OCTAVE) - 2, { silent: true })
  }

  /* ================================================================ */
  /* VOICE MODE buttons (per-timbre param)                             */
  /* ================================================================ */

  private vmPress(i: number): void {
    this.store.setParam(this.tid('voiceMode'), i, 'ui')
  }

  private vmRelease(): void {
    // the momentary button zeroes its own LED after release — re-assert
    queueMicrotask(() => this.syncVoiceLeds())
  }

  private syncVoiceLeds(): void {
    const mode = Math.round(this.store.getParam(this.tid('voiceMode')))
    for (let i = 0; i < this.vmBtns.length; i++) {
      this.vmBtns[i].setValue(i === mode ? 1 : 0, { silent: true })
    }
  }

  private formatVmDepth(v: number): string {
    // VOICE MODE order (spec §4): POLY, MONO, UNISON, CHORD
    switch (Math.round(this.store.getParam(this.tid('voiceMode')))) {
      case 1: {
        // MONO: sub-oscillator mix (the OG MONO model)
        const m = curves.monoSubMix(v)
        return 'Sub ' + Math.round(m.sub1 * 100) + '/' + Math.round(m.sub2 * 100)
      }
      case 2: // UNISON: detune across all of the timbre's voices
        return curves.unisonDetuneCents(v).toFixed(1) + ' Cent'
      case 3: // CHORD: family 14-chord zone table
        return curves.CHORDS[curves.chordIndex(v)].name
      default: {
        // POLY: 0..255 poly, 256..1023 DUO
        const pd = curves.polyDuo(v)
        return pd.duo ? 'Duo ' + Math.round(pd.amount * 100) : 'Poly'
      }
    }
  }

  /* ================================================================ */
  /* SHIFT (xd gesture: tap latches, hold is momentary)                */
  /* ================================================================ */

  private setShift(on: boolean): void {
    if (this.shiftOn === on) return
    this.shiftOn = on
    this.el.classList.toggle('xd-shift-on', on)
    this.shiftBtn.setLed(on ? 1 : 0)
    // SHIFT re-addresses the multi SHAPE knob and the DL/RV DEPTH knob
    this.rebindMultiShape()
    this.rebindDlRvDepth()
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
  /* MULTI ENGINE dynamic binding (type + SHIFT + EDIT TIMBRE)         */
  /* ================================================================ */

  private multiType(): number {
    const t = Math.round(this.store.getParam(this.tid('multiType')))
    return t >= 0 && t <= 2 ? t : 1
  }

  private multiShapeName(): TimbreKey {
    const t = this.multiType()
    if (this.shiftOn) {
      const s = MULTI_SHIFTSHAPES[t]
      if (s) return s // NOISE has no shift shape (spec §6): fall through
    }
    return MULTI_SHAPES[t]
  }

  private multiShapeId(): number {
    return this.tid(this.multiShapeName())
  }

  private rebindMultiShape(): void {
    this.multiShapeKnob.setValue(this.store.getParam(this.multiShapeId()), { silent: true })
  }

  private updateMultiDisplay(): void {
    const selId = this.tid(MULTI_SELECTS[this.multiType()])
    this.multiDisplay.textContent = formatParam(selId, this.store.getParam(selId))
  }

  private stepMultiSelect(dir: 1 | -1): void {
    const selId = this.tid(MULTI_SELECTS[this.multiType()])
    const m = PARAMS[selId]
    const n = m.max - m.min + 1
    const cur = this.store.getParam(selId)
    const next = m.min + ((cur - m.min + dir + n) % n) // wraps
    this.store.setParam(selId, next, 'ui')
    this.updateMultiDisplay()
  }

  /* ================================================================ */
  /* EFFECT dynamic binding + readouts                                 */
  /* ================================================================ */

  /** SHIFT + DEPTH edits the FW2 DRY/WET (xd SHIFT-DEPTH precedent; DRY/WET
   *  is knob-kind so it has no PROG EDIT page). */
  private dlRvDepthId(): number {
    return this.shiftOn ? P.DLRV_DRYWET : P.DLRV_DEPTH
  }

  private rebindDlRvDepth(): void {
    const id = this.dlRvDepthId()
    this.dlRvDepthKnob.setRange(PARAMS[id].min, PARAMS[id].max) // DRY/WET is 0..1024
    this.dlRvDepthKnob.setValue(this.store.getParam(id), { silent: true })
  }

  private syncFxReadouts(): void {
    const type = Math.max(0, Math.min(4, Math.round(this.store.getParam(P.MODFX_TYPE))))
    const subId = MODFX_SUBS[type]
    this.modFxLine1.textContent = formatParam(P.MODFX_TYPE, type)
    this.modFxLine2.textContent = formatParam(subId, this.store.getParam(subId))

    const sel = Math.round(this.store.getParam(P.DLRV_SELECT))
    this.dlRvLine1.textContent = sel === 1 ? 'DELAY' : sel === 2 ? 'REVERB' : 'OFF'
    this.dlRvLine2.textContent =
      sel === 1
        ? formatParam(P.DELAY_SUB, this.store.getParam(P.DELAY_SUB))
        : sel === 2
          ? formatParam(P.REVERB_SUB, this.store.getParam(P.REVERB_SUB))
          : '—'
  }

  /** DELAY/REVERB picker: both sides' types grouped — a pick sets the
   *  exclusive 3-way select AND the side's type together (spec §7). */
  private openDlRvMenu(anchor: HTMLElement): void {
    const sel = Math.round(this.store.getParam(P.DLRV_SELECT))
    const items: MenuItem[] = []
    const sides = [
      { name: 'DELAY', value: 1, subId: P.DELAY_SUB },
      { name: 'REVERB', value: 2, subId: P.REVERB_SUB },
    ] as const
    for (const side of sides) {
      items.push({ label: side.name })
      const labels = PARAMS[side.subId].labels ?? []
      const cur = Math.round(this.store.getParam(side.subId))
      for (let i = 0; i < labels.length; i++) {
        items.push({
          label: labels[i],
          value: side.value * 100 + i,
          selected: sel === side.value && i === cur,
        })
      }
    }
    showMenu(anchor, items, (v) => {
      const side = Math.floor((v as number) / 100)
      this.store.setParam(P.DLRV_SELECT, side, 'ui')
      this.store.setParam(side === 1 ? P.DELAY_SUB : P.REVERB_SUB, (v as number) % 100, 'ui')
    })
  }

  /* ================================================================ */
  /* ARPEGGIATOR ON/LATCH gesture                                      */
  /* ================================================================ */

  private arpPress(): void {
    this.arpDownAt = Date.now()
  }

  /** Tap: Off <-> On (a tap from Latch releases to Off). Hold >500ms: latch
   *  (blinking LED) / release the latch. */
  private arpRelease(): void {
    const v = Math.round(this.store.getParam(P.ARP_ON_LATCH))
    if (Date.now() - this.arpDownAt > ARP_HOLD_MS) {
      this.store.setParam(P.ARP_ON_LATCH, v === 2 ? 0 : 2, 'ui')
    } else {
      this.store.setParam(P.ARP_ON_LATCH, v === 0 ? 1 : 0, 'ui')
    }
    // the momentary button zeroes its own LED after release — re-assert
    queueMicrotask(() => this.syncArpLed())
  }

  /** LED lit while running; blinking = latched (the family latch look). */
  private syncArpLed(): void {
    const v = Math.round(this.store.getParam(P.ARP_ON_LATCH))
    this.arpBtn.setValue(v > 0 ? 1 : 0, { silent: true })
    this.arpBtn.el.classList.toggle('xd-blink', v === 2)
  }

  /* ================================================================ */
  /* L.F. COMP app-level state (16 only)                               */
  /* ================================================================ */

  private loadLfComp(): void {
    try {
      const raw = (globalThis as { localStorage?: Storage }).localStorage?.getItem(LFCOMP_LS)
      if (raw) {
        const p = JSON.parse(raw) as { gain?: number; on?: boolean }
        if (typeof p.gain === 'number' && Number.isFinite(p.gain)) {
          this.lfGain = Math.max(0, Math.min(1, p.gain))
        }
        this.lfOn = p.on === true
      }
    } catch {
      /* no storage / corrupt: keep defaults */
    }
  }

  private saveLfComp(): void {
    try {
      ;(globalThis as { localStorage?: Storage }).localStorage?.setItem(
        LFCOMP_LS,
        JSON.stringify({ gain: this.lfGain, on: this.lfOn }),
      )
    } catch {
      /* storage unavailable: state still works for this session */
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

  /** WRITE commits the program (green flash / ~1s error blink, family look). */
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

  /**
   * Grouped menu over a type param and its per-type sub params (multi engine
   * oscillators, MOD FX types) — the xd pattern: one header row per type,
   * values encoded as t*100+i so a pick sets the type and its sub together.
   */
  private groupedParamMenu(anchor: HTMLElement, typeId: number, subIds: readonly number[]): void {
    const type = Math.round(this.store.getParam(typeId))
    const groups = PARAMS[typeId].labels ?? []
    const items: MenuItem[] = []
    for (let t = 0; t < subIds.length; t++) {
      items.push({ label: String(groups[t] ?? t) })
      const labels = PARAMS[subIds[t]].labels ?? []
      const cur = Math.round(this.store.getParam(subIds[t]))
      for (let i = 0; i < labels.length; i++) {
        items.push({ label: labels[i], value: t * 100 + i, selected: t === type && i === cur })
      }
    }
    showMenu(anchor, items, (v) => {
      const t = Math.floor((v as number) / 100)
      this.store.setParam(typeId, t, 'ui')
      this.store.setParam(subIds[t], (v as number) % 100, 'ui')
    })
  }

  /** Multi readout: every oscillator across all three engines, grouped. */
  private openMultiMenu(): void {
    this.groupedParamMenu(
      this.multiDisplay,
      this.tid('multiType'),
      MULTI_SELECTS.map((n) => this.tid(n)),
    )
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

    const octave = this.binder.paramSwitch(P.OCTAVE, { label: 'OCTAVE' })
    const porta = this.tKnob('portamento', 'm', { label: 'PORTAMENTO' })

    // VOICE SPREAD lives in the MASTER block on the 16 (spec §3); the 8
    // reaches it via the PROG EDIT menu (spec §14).
    const bottom =
      this.variant === 16
        ? row('xd-ctl-row', porta.el, this.tKnob('voiceSpread', 'm', { label: 'VOICE SPREAD' }).el)
        : row('xd-ctl-row', porta.el)

    return section(
      'MASTER',
      'prologue-sec-master',
      row('xd-ctl-row', master.el, octave.el),
      bottom,
    )
  }

  private buildVoiceMode(): HTMLElement {
    const labels = PARAMS[TIMBRE_BLOCKS[0].voiceMode].labels ?? []
    const btns = div('prologue-vm-btns')
    for (let i = 0; i < labels.length; i++) {
      const b = new LedButton({
        label: labels[i],
        onPress: () => this.vmPress(i),
        onRelease: () => this.vmRelease(),
      })
      this.vmBtns.push(b)
      btns.append(b.el)
    }
    const depth = this.tKnob('vmDepth', 'l', {
      label: 'DEPTH',
      format: (v) => this.formatVmDepth(v),
    })
    return section('VOICE MODE', 'prologue-sec-vm', row('xd-ctl-row', btns, depth.el))
  }

  /** TIMBRE section (16 only): SUB ON, BALANCE, TYPE, PANEL edit-select. */
  private buildTimbre(): HTMLElement {
    const subOn = new LedButton({
      label: 'SUB ON',
      latching: true,
      onInput: (v) => this.store.setParam(P.SUB_ON, v, 'ui'),
    })
    this.binder.bind(P.SUB_ON, subOn)

    const balance = this.binder.paramKnob(P.BALANCE, 'm', { label: 'BALANCE' })
    const type = this.binder.paramSwitch(P.TIMBRE_TYPE, { label: 'TYPE' })

    // PANEL edit-select prints SUB / + / MAIN top-to-bottom — the REVERSE of
    // the stored EDIT TIMBRE enum (Main, Main+Sub, Sub; CC85 arrives in this
    // panel order too, cc.ts) — the mono reversedSwitch precedent.
    const m = PARAMS[P.EDIT_TIMBRE]
    const n = m.labels?.length ?? 3
    const panelSel = new SelectorSwitch({
      label: 'PANEL',
      positions: ['SUB', '+', 'MAIN'],
      value: n - 1 - Math.round(this.store.getParam(P.EDIT_TIMBRE)),
      onInput: (pos) => this.store.setParam(P.EDIT_TIMBRE, n - 1 - pos, 'ui'),
    })
    this.binder.bind(P.EDIT_TIMBRE, {
      setValue: (v, o) => panelSel.setValue(n - 1 - Math.round(v), o),
    })

    return section(
      'TIMBRE',
      'prologue-sec-timbre',
      row('xd-ctl-row', subOn.el, balance.el),
      row('xd-ctl-row', type.el, panelSel.el),
    )
  }

  private buildVco1(): HTMLElement {
    const wave = this.tSwitch('vco1Wave', 'WAVE')
    const oct = this.tSwitch('vco1Octave', 'OCTAVE')
    const pitch = this.tKnob('vco1Pitch', 'm', { label: 'PITCH', bipolar: true })
    const shape = this.tKnob('vco1Shape', 'm', { label: 'SHAPE' })
    return section(
      'VCO 1',
      'prologue-sec-vco1',
      row('xd-ctl-row', wave.el, oct.el),
      row('xd-ctl-row', pitch.el, shape.el),
    )
  }

  private buildVco2(): HTMLElement {
    const wave = this.tSwitch('vco2Wave', 'WAVE')
    const oct = this.tSwitch('vco2Octave', 'OCTAVE')
    const pitch = this.tKnob('vco2Pitch', 'm', { label: 'PITCH', bipolar: true })
    const shape = this.tKnob('vco2Shape', 'm', { label: 'SHAPE' })
    return section(
      'VCO 2',
      'prologue-sec-vco2',
      row('xd-ctl-row', wave.el, oct.el),
      row('xd-ctl-row', pitch.el, shape.el),
    )
  }

  /** MODULATION (spec §3): PITCH EG switch+INT, exclusive SYNC/RING 3-way
   *  (printed in stored order RING/OFF/SYNC), stacking CROSS MOD. */
  private buildModulation(): HTMLElement {
    const egTarget = this.tSwitch('pitchEgTarget', 'PITCH EG')
    const egInt = this.tKnob('pitchEgInt', 'm', { label: 'INT', bipolar: true })
    const syncRing = this.tSwitch('syncRing', 'SYNC/RING')
    const cross = this.tKnob('crossMod', 'm', { label: 'CROSS MOD' })
    return section(
      'MODULATION',
      'prologue-sec-modulation',
      row('xd-ctl-row', egTarget.el, egInt.el),
      row('xd-ctl-row', syncRing.el, cross.el),
    )
  }

  private buildMulti(): HTMLElement {
    const type = this.tSwitch('multiType', 'ENGINE')
    const oct = this.tSwitch('multiOctave', 'OCTAVE')

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
      onInput: (v) => this.store.setParam(this.multiShapeId(), v, 'ui'),
    })

    return section(
      'MULTI ENGINE',
      'prologue-sec-multi',
      row('xd-ctl-row', type.el, typeBlock),
      row('xd-ctl-row', oct.el, this.multiShapeKnob.el),
    )
  }

  private buildMixer(): HTMLElement {
    const v1 = this.tKnob('vco1Level', 'm', { label: 'VCO 1' })
    const v2 = this.tKnob('vco2Level', 'm', { label: 'VCO 2' })
    const mu = this.tKnob('multiLevel', 'm', { label: 'MULTI' })
    return section('MIXER', 'prologue-sec-mixer', row('xd-ctl-row xd-ctl-col', v1.el, v2.el, mu.el))
  }

  private buildFilter(): HTMLElement {
    const cutoff = this.tKnob('cutoff', 'xl', { label: 'CUTOFF' })
    const reso = this.tKnob('resonance', 'l', { label: 'RESONANCE' })
    const egInt = this.tKnob('cutoffEgInt', 'm', { label: 'EG INT', bipolar: true })
    const drive = this.tSwitch('drive', 'DRIVE')
    const lowCut = this.tSwitch('lowCut', 'LOW CUT')
    const keytrack = this.tSwitch('keytrack', 'KEYTRACK')
    const right = div('prologue-filter-right')
    right.append(
      row('xd-ctl-row', reso.el, egInt.el),
      row('xd-ctl-row', drive.el, lowCut.el, keytrack.el),
    )
    return section(
      'FILTER',
      'prologue-sec-filter',
      row('xd-ctl-row prologue-filter-row', cutoff.el, right),
    )
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
    // EXIT dismisses any open readout menu; EDIT opens the program browser
    // (edit-mode stand-in) — the og strip, plus the hardware's SHIFT (spec
    // §3) which readdresses SHAPE -> SHIFT SHAPE and DEPTH -> DRY/WET here.
    const exitBtn = new LedButton({ label: 'EXIT', onPress: () => closeMenu() })
    const editBtn = new LedButton({
      label: 'EDIT',
      onPress: () => this.openProgramMenu(this.progReadout),
    })
    this.shiftBtn = new LedButton({
      label: 'SHIFT',
      onPress: this.shiftPress,
      onRelease: this.shiftRelease,
    })

    const top = div('xd-prog-top')
    top.append(this.progReadout, midiWrap)

    const side = div('prologue-prog-side')
    side.append(enc.el, row('prologue-prog-btns', this.writeBtn.el, exitBtn.el, editBtn.el, this.shiftBtn.el))

    const main = div('xd-prog-main')
    main.append(this.displaySlot, side)

    return section('PROGRAM', 'prologue-sec-prog', top, main)
  }

  private buildAmpEg(): HTMLElement {
    const a = this.tKnob('ampAttack', 'm', { label: 'ATTACK' })
    const d = this.tKnob('ampDecay', 'm', { label: 'DECAY' })
    const s = this.tKnob('ampSustain', 'm', { label: 'SUSTAIN' })
    const r = this.tKnob('ampRelease', 'm', { label: 'RELEASE' })
    return section('AMP EG', 'prologue-sec-amp', row('xd-ctl-row', a.el, d.el, s.el, r.el))
  }

  private buildEg(): HTMLElement {
    const a = this.tKnob('egAttack', 'm', { label: 'ATTACK' })
    const d = this.tKnob('egDecay', 'm', { label: 'DECAY' })
    const s = this.tKnob('egSustain', 'm', { label: 'SUSTAIN' })
    const r = this.tKnob('egRelease', 'm', { label: 'RELEASE' })
    return section('EG', 'prologue-sec-eg', row('xd-ctl-row', a.el, d.el, s.el, r.el))
  }

  private buildLfo(): HTMLElement {
    const wave = this.tSwitch('lfoWave', 'WAVE')
    const mode = this.tSwitch('lfoMode', 'MODE') // BPM/SLOW/FAST — no 1-shot
    const target = this.tSwitch('lfoTarget', 'TARGET')
    const rate = this.tKnob('lfoRate', 'm', {
      label: 'RATE',
      format: (v) => this.formatLfoRate(v),
    })
    const int = this.tKnob('lfoInt', 'm', { label: 'INT', bipolar: true })
    return section(
      'LFO',
      'prologue-sec-lfo',
      row('xd-ctl-row', wave.el, mode.el, target.el),
      row('xd-ctl-row', rate.el, int.el),
    )
  }

  /** Mode-aware RATE readout: BPM division in BPM mode, Hz otherwise. */
  private formatLfoRate(v: number): string {
    const mode = Math.round(this.store.getParam(this.tid('lfoMode')))
    if (mode <= 0) return curves.LFO_BPM_DIVISIONS[curves.lfoBpmDivIndex(v)].label
    return fmtHz(curves.lfoRateToHz(v, mode, this.store.program.seq.bpm))
  }

  private buildFx(): HTMLElement {
    // ---- MOD FX ----------------------------------------------------
    const modOn = new LedButton({
      label: 'MOD FX',
      latching: true,
      onInput: (v) => this.store.setParam(P.MODFX_ON, v, 'ui'),
    })
    this.binder.bind(P.MODFX_ON, modOn)

    this.modFxLine1 = div('xd-fx-line1')
    this.modFxLine2 = div('xd-fx-line2')
    const modReadout = div('xd-fx-display')
    modReadout.classList.add('xd-clickable-readout')
    modReadout.title = 'choose mod effect'
    modReadout.addEventListener('click', () => this.groupedParamMenu(modReadout, P.MODFX_TYPE, MODFX_SUBS))
    modReadout.append(this.modFxLine1, this.modFxLine2)

    const speed = this.binder.paramKnob(P.MODFX_SPEED, 'm', { label: 'SPEED' })
    const depth = this.binder.paramKnob(P.MODFX_DEPTH, 'm', { label: 'DEPTH' })

    // ---- DELAY / REVERB (mutually exclusive 3-way, spec §7) ---------
    const sel = this.binder.paramSwitch(P.DLRV_SELECT, { label: 'DELAY/REVERB' })

    this.dlRvLine1 = div('xd-fx-line1')
    this.dlRvLine2 = div('xd-fx-line2')
    const dlRvReadout = div('xd-fx-display')
    dlRvReadout.classList.add('xd-clickable-readout')
    dlRvReadout.title = 'choose delay/reverb type'
    dlRvReadout.addEventListener('click', () => this.openDlRvMenu(dlRvReadout))
    dlRvReadout.append(this.dlRvLine1, this.dlRvLine2)

    const time = this.binder.paramKnob(P.DLRV_TIME, 'm', { label: 'TIME' })
    this.dlRvDepthKnob = new Knob({
      label: 'DEPTH',
      size: 'm',
      min: 0,
      max: 1023,
      value: this.store.getParam(this.dlRvDepthId()),
      defaultValue: 512,
      format: (v) => formatParam(this.dlRvDepthId(), v),
      onInput: (v) => this.store.setParam(this.dlRvDepthId(), v, 'ui'),
    })

    return section(
      'EFFECT',
      'prologue-sec-fx',
      row('xd-ctl-row', modOn.el, modReadout, speed.el, depth.el),
      row('xd-ctl-row', sel.el, dlRvReadout, time.el, this.dlRvDepthKnob.el),
    )
  }

  private buildArp(): HTMLElement {
    this.arpBtn = new LedButton({
      label: 'ON/LATCH',
      onPress: () => this.arpPress(),
      onRelease: () => this.arpRelease(),
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

    const range = this.binder.paramKnob(P.ARP_RANGE, 'm', { label: 'RANGE' })
    const type = this.binder.paramKnob(P.ARP_TYPE, 'm', { label: 'TYPE' })
    const rate = this.binder.paramKnob(P.ARP_RATE, 'm', { label: 'RATE' })

    return section(
      'ARPEGGIATOR',
      'prologue-sec-arp',
      row('xd-ctl-row', this.arpBtn.el, this.tempoKnob.el),
      row('xd-ctl-row', range.el, type.el, rate.el),
    )
  }

  /** L.F. COMP (16 only): app-level GAIN + ON (persisted, spec §7) and a
   *  static-face GR meter — live gain reduction needs engine telemetry
   *  (dsp/fx/lfcomp.ts grLevel); v1 renders the resting face only. */
  private buildLfComp(): HTMLElement {
    const gain = new Knob({
      label: 'GAIN',
      size: 'm',
      min: 0,
      max: 1,
      step: 0.01,
      value: this.lfGain,
      defaultValue: 0.5,
      format: (v) => fmtPercent01(v),
      onInput: (v) => {
        this.lfGain = v
        this.saveLfComp()
        this.opts.onLfCompGain?.(v)
      },
    })

    const on = new LedButton({
      label: 'ON',
      latching: true,
      onInput: (v) => {
        this.lfOn = v === 1
        this.saveLfComp()
        this.opts.onLfCompOn?.(this.lfOn)
      },
    })
    on.setValue(this.lfOn ? 1 : 0, { silent: true })

    const meter = document.createElement('canvas')
    meter.className = 'prologue-lfcomp-meter'
    meter.width = 90
    meter.height = 40
    meter.title = 'gain reduction (static face — live VU lands with the engine)'
    this.drawLfMeterFace(meter)

    return section(
      'L.F. COMP',
      'prologue-sec-lfcomp',
      row('xd-ctl-row', meter),
      row('xd-ctl-row', gain.el, on.el),
    )
  }

  /** Static VU face: arc + ticks + resting needle (no live GR in v1). */
  private drawLfMeterFace(cv: HTMLCanvasElement): void {
    let ctx: CanvasRenderingContext2D | null = null
    try {
      ctx = cv.getContext('2d')
    } catch {
      ctx = null
    }
    if (!ctx) return // happy-dom / detached: the styled canvas is the face
    const w = cv.width
    const h = cv.height
    const cx = w / 2
    const cy = h + 8 // pivot below the visible face
    ctx.clearRect(0, 0, w, h)
    ctx.strokeStyle = '#8fe0a0'
    ctx.globalAlpha = 0.55
    ctx.lineWidth = 1
    // scale arc + ticks (0..-12 dB GR, matching lfcomp.ts GR_FULL_DB)
    const a0 = -Math.PI * 0.78
    const a1 = -Math.PI * 0.22
    ctx.beginPath()
    ctx.arc(cx, cy, h - 4, a0, a1)
    ctx.stroke()
    for (let i = 0; i <= 4; i++) {
      const a = a0 + ((a1 - a0) * i) / 4
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(a) * (h - 8), cy + Math.sin(a) * (h - 8))
      ctx.lineTo(cx + Math.cos(a) * (h - 2), cy + Math.sin(a) * (h - 2))
      ctx.stroke()
    }
    // resting needle at 0 dB GR (left end of the scale)
    ctx.globalAlpha = 0.9
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + Math.cos(a0) * (h - 6), cy + Math.sin(a0) * (h - 6))
    ctx.stroke()
    ctx.globalAlpha = 0.7
    ctx.font = '700 6px monospace'
    ctx.fillStyle = '#8fe0a0'
    ctx.textAlign = 'center'
    ctx.fillText('GR dB', cx, h - 3)
    ctx.globalAlpha = 1
  }
}
