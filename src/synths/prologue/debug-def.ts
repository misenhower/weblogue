/*
 * Korg prologue DebugDef — SERVICE MODE surface, built as a FACTORY over the
 * voice count so one definition serves both variants:
 * makePrologueDebugDef(8) / makePrologueDebugDef(16) (spec §14; the drawer
 * already wraps its legend/lanes for 16 voices).
 *
 * Signal path (spec §1): VCO 1 ⊕ VCO 2 ⊕ MULTI -> MIX -> VCF -> VCA ->
 * Σ×N -> MOD FX -> DELAY-or-REVERB -> OUTPUT.
 *
 * ASSUMED TAP ORDER — coordinate with the prologue engine (built
 * separately): the family 12-ring dbg layout (shared/messages.ts): voice
 * taps 0-5 = [VCO1, VCO2, MULTI, MIX, VCF, VCA] (tapM carries the MULTI
 * engine, like the xd), FX pairs 6-7 = MOD FX, 8-9 = DL-RV, 10-11 = final
 * output. The prologue-16's L.F. COMP sits inside the OUTPUT tap (last in
 * chain, spec §7) — no dedicated cell in the 12-ring layout.
 *
 * TIMBRE SCOPE: the store holds TWO timbre blocks (spec §2); every
 * badge/wire predicate reads the block addressed by EDIT TIMBRE — the same
 * scope the panel edits — so the drawer always describes the timbre under
 * the user's hands ('+' reads MAIN, the panel's UNCONFIRMED interpretation).
 * A dedicated badge shows both timbres' voice modes at a glance.
 *
 * Readout notes: SYNC/RING is the exclusive 3-position switch (spec §3) as a
 * tri-state badge pair (mono precedent); the shared EG drives cutoff (EG
 * badge) AND pitch via the PITCH EG switch (own badge + wire; enum order
 * UNCONFIRMED, spec §16.6); the LFO badge is mode-aware (BPM division label
 * in BPM mode — no 1-shot, spec §8).
 */
import type { DebugDef } from '../../ui/debugpanel'
import type { Store } from '../../state/store'
import { fmtHz } from '../../shared/maps'
import { P, TIMBRE_BLOCKS, type TimbreParamIds } from './params'
import {
  egIntToPercent,
  pitchEgIntToCents,
  lfoIntTo01,
  lfoRateToHz,
  lfoBpmDivIndex,
  LFO_BPM_DIVISIONS,
} from './curves'

/** Timbre block addressed by EDIT TIMBRE (0/1 Main, 2 Sub — panel scoping). */
const tb = (s: Store): TimbreParamIds =>
  TIMBRE_BLOCKS[Math.round(s.getParam(P.EDIT_TIMBRE)) === 2 ? 1 : 0]

/** Cutoff-EG intensity 0..1 (bipolar percent knob, family quadratic). */
const egAmt = (s: Store): number => Math.abs(egIntToPercent(s.getParam(tb(s).cutoffEgInt))) / 100
/** Pitch-EG intensity 0..1 (±4800¢ knob behind the PITCH EG switch). */
const pitchEgAmt = (s: Store): number =>
  Math.abs(pitchEgIntToCents(s.getParam(tb(s).pitchEgInt))) / 4800
/** LFO intensity 0..1 (bipolar center-512 store, spec §8). */
const lfoAmt = (s: Store): number => Math.abs(lfoIntTo01(s.getParam(tb(s).lfoInt)))

/** 'EG → CUTOFF' / 'EG → −CUTOFF' — the shared EG's fixed cutoff leg. */
const egText = (s: Store): string =>
  'EG → ' + (egIntToPercent(s.getParam(tb(s).cutoffEgInt)) < 0 ? '−' : '') + 'CUTOFF'

/** 'P.EG → VCO 2 / VCO 1+2 / ALL' — switch labels (order UNCONFIRMED §16.6). */
const pitchEgText = (s: Store): string => {
  const t = ['VCO 2', 'VCO 1+2', 'ALL'][Math.round(s.getParam(tb(s).pitchEgTarget))] ?? ''
  const sign = pitchEgIntToCents(s.getParam(tb(s).pitchEgInt)) < 0 ? '−' : ''
  return 'P.EG → ' + sign + t
}

/** 'LFO → PITCH · SLOW 2.1Hz' — target + sign + mode-aware rate readout. */
const lfoText = (s: Store): string => {
  const t = tb(s)
  const target = ['CUTOFF', 'SHAPE', 'PITCH'][Math.round(s.getParam(t.lfoTarget))] ?? ''
  const mode = Math.round(s.getParam(t.lfoMode))
  const modeLabel = ['BPM', 'SLOW', 'FAST'][mode] ?? ''
  const rate = s.getParam(t.lfoRate)
  const rateStr =
    mode <= 0
      ? LFO_BPM_DIVISIONS[lfoBpmDivIndex(rate)].label
      : fmtHz(lfoRateToHz(rate, mode, s.program.seq.bpm))
  const sign = lfoIntTo01(s.getParam(t.lfoInt)) < 0 ? '−' : ''
  return 'LFO → ' + sign + target + ' · ' + modeLabel + ' ' + rateStr
}

/** Minimal per-timbre voice-mode readout: 'VM M:POLY S:UNI' (both blocks
 *  shown while SUB is on, MAIN alone otherwise). */
const VM_SHORT = ['POLY', 'MONO', 'UNI', 'CHD'] as const
const vmText = (s: Store): string => {
  const main = VM_SHORT[Math.round(s.getParam(TIMBRE_BLOCKS[0].voiceMode))] ?? ''
  if (Math.round(s.getParam(P.SUB_ON)) !== 1) return 'VM ' + main
  const sub = VM_SHORT[Math.round(s.getParam(TIMBRE_BLOCKS[1].voiceMode))] ?? ''
  return 'VM M:' + main + ' S:' + sub
}

export function makePrologueDebugDef(numVoices: number): DebugDef {
  return {
    numVoices,
    stages: [
      { label: 'VCO 1', l: 0, x: 8, y: 4 },
      { label: 'VCO 2', l: 1, x: 8, y: 76 },
      { label: 'MULTI', l: 2, x: 8, y: 148 },
      { label: 'MIX', l: 3, x: 260, y: 76 },
      { label: 'VCF', l: 4, x: 480, y: 76 },
      { label: 'VCA', l: 5, x: 8, y: 236 },
      { label: 'MOD FX', l: 6, r: 7, x: 248, y: 236 },
      { label: 'DL-RV', l: 8, r: 9, x: 444, y: 236 },
      { label: 'OUTPUT', l: 10, r: 11, x: 626, y: 236 },
    ],
    wires: [
      // Audio path.
      { d: 'M178 27 H219 V99 H260' }, // VCO1 -> MIX
      { d: 'M178 99 H260' }, // VCO2 -> MIX
      // MULTI routing pre/post VCF (per-timbre param; EDIT TIMBRE scope).
      { d: 'M178 171 H219 V99', on: (s) => s.getParam(tb(s).multiRouting) < 0.5 },
      { d: 'M178 171 H726 V212', on: (s) => s.getParam(tb(s).multiRouting) >= 0.5 },
      { d: 'M430 99 H480' }, // MIX -> VCF
      { d: 'M650 99 H726 V212 H93 V236' }, // VCF down into the VCA
      { d: 'M178 259 H248' }, // VCA -> (voice sum) -> MOD FX
      { d: 'M418 259 H444' }, // MOD FX -> DL-RV
      { d: 'M614 259 H626' }, // DL-RV -> OUTPUT
      // Mod routing (visibility/opacity follow the addressed timbre).
      // Shared EG -> cutoff (fixed leg, spec §5).
      { d: 'M360 17 H560 V76', cls: 'xd-w-eg', on: () => true, amt: egAmt },
      // Shared EG -> pitch, behind the PITCH EG switch (spec §5).
      { d: 'M300 39 H219 V90', cls: 'xd-w-eg', on: () => true, amt: pitchEgAmt },
      { d: 'M360 197 H560 V140', cls: 'xd-w-lfo', on: (s) => s.getParam(tb(s).lfoTarget) === 0, amt: lfoAmt },
      { d: 'M300 197 H219 V180', cls: 'xd-w-lfo', on: (s) => s.getParam(tb(s).lfoTarget) !== 0, amt: lfoAmt },
    ],
    // VCO1<->VCO2 relationship badges: the exclusive SYNC/RING 3-way as a
    // tri-state pair (timbre byte +25: 0=RING, 1=OFF, 2=SYNC) + stacking
    // CROSS MOD (spec §3).
    toggleBadges: [
      { x: 186, y: 36, label: 'SYNC', on: (s) => Math.round(s.getParam(tb(s).syncRing)) === 2 },
      { x: 186, y: 56, label: 'RING', on: (s) => Math.round(s.getParam(tb(s).syncRing)) === 0 },
      { x: 186, y: 76, label: 'X-MOD', on: (s) => s.getParam(tb(s).crossMod) > 8 },
    ],
    // v1 engine mono-sums all voices before the shared FX; the per-timbre
    // stereo buses (spec §13) land with the engine — same wire midpoint as
    // the family defs.
    sumBadge: {
      x: 213,
      y: 259,
      label: 'Σ ×' + numVoices,
      title: `all ${numVoices} voices are summed here, before the shared effects`,
    },
    modBadges: [
      {
        x: 296,
        y: 6,
        cls: 'xd-svc-badge--eg',
        label: 'EG',
        text: egText,
        amt: egAmt,
      },
      {
        x: 296,
        y: 28,
        cls: 'xd-svc-badge--eg',
        label: 'PITCH EG',
        text: pitchEgText,
        amt: pitchEgAmt,
      },
      {
        x: 296,
        y: 186,
        cls: 'xd-svc-badge--lfo',
        label: 'LFO',
        text: lfoText,
        amt: lfoAmt,
      },
      // Per-timbre voice-mode readout (always legible; base badge styling).
      {
        x: 650,
        y: 6,
        cls: '',
        label: 'VM',
        text: vmText,
        amt: () => 1,
      },
    ],
    /** Compact strip: VCO 1 ⊕ VCO 2 ⊕ MULTI → MIX → VCF → OUTPUT. */
    compact: { indices: [0, 1, 2, 3, 4, 8], arrows: ['⊕', '⊕', '→', '→', '→'] },
    // Fixed source order (DbgVoice.amp, .modEg, .lfo): amp = AMP EG via the
    // VCA, modEg = the shared EG (cutoff + pitch legs), lfo = bipolar LFO.
    modSigs: [
      { label: 'AMP EG', color: '#8fe0a0', bipolar: false },
      { label: 'EG', color: '#e0c98f', bipolar: false },
      { label: 'LFO', color: '#8fb8e0', bipolar: true },
    ],
  }
}
