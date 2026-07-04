/*
 * Korg monologue DebugDef — same shape as the og's (synths/og/debug-def.ts)
 * over the monologue signal path and param table.
 *
 * Signal path (monologue-spec.md §1): VCO 1 ⊕ VCO 2/NOISE -> MIX -> FILTER
 * (2-pole LP) -> VCA -> DRIVE -> OUTPUT. Strictly MONO out and monophonic:
 * numVoices is 1 (the drawer hides its 1V/all-V toggle), every scope cell
 * renders single-channel (no L/R overlays), and there is no voice sum.
 *
 * ASSUMED TAP ORDER — coordinate with the mono engine (built separately):
 * voice taps 0-5 = [VCO1, VCO2/NOISE, MIX, FILTER, VCA, DRIVE] and the
 * OUTPUT cell reads tap 10, the family 12-ring dbg layout's final-output
 * slot (shared/messages.ts; the og engine records the same ring). DRIVE is
 * post-VCA inside the voice (spec §14) so it gets the 6th voice tap — the
 * family's layouts have no drive slot. If the engine records a different
 * layout, adjust these indices at integration.
 *
 * Readout differences vs the og: EG INT and LFO INT are BIPOLAR
 * (center-512 store, spec §5/§6) — badge text carries a − sign for negative
 * intensities; the EG has a TARGET switch (CUTOFF/PITCH 2/PITCH, spec §5);
 * the LFO badge shows a mode-aware rate readout (FAST/SLOW/1-SHOT ranges or
 * the BPM-sync division, spec §6).
 */
import type { DebugDef } from '../../ui/debugpanel'
import type { Store } from '../../state/store'
import { fmtHz } from '../../shared/maps'
import { P } from './params'
import {
  egIntTo01,
  lfoIntTo01,
  lfoRateToHz,
  lfoBpmDivIndex,
  LFO_BPM_DIVISIONS,
} from './curves'

/** EG intensity 0..1 (bipolar center-512 knob, spec §5). */
const egAmt = (s: Store): number => Math.abs(egIntTo01(s.getParam(P.EG_INT)))
/** LFO intensity 0..1 (bipolar center-512 knob, spec §6). */
const lfoAmt = (s: Store): number => Math.abs(lfoIntTo01(s.getParam(P.LFO_INT)))

/** 'EG → CUTOFF' / 'EG → −PITCH 2' — target + bipolar-INT sign. */
const egText = (s: Store): string => {
  const target = ['CUTOFF', 'PITCH 2', 'PITCH'][Math.round(s.getParam(P.EG_TARGET))] ?? ''
  const sign = egIntTo01(s.getParam(P.EG_INT)) < 0 ? '−' : ''
  return 'EG → ' + sign + target
}

/** 'LFO → PITCH · FAST 440Hz' — target + sign + mode-aware rate readout. */
const lfoText = (s: Store): string => {
  const target = ['CUTOFF', 'SHAPE', 'PITCH'][Math.round(s.getParam(P.LFO_TARGET))] ?? ''
  const mode = Math.round(s.getParam(P.LFO_MODE))
  const modeLabel = ['1-SHOT', 'SLOW', 'FAST'][mode] ?? ''
  const rate = s.getParam(P.LFO_RATE)
  const rateStr =
    s.getParam(P.LFO_BPM_SYNC) === 1
      ? LFO_BPM_DIVISIONS[lfoBpmDivIndex(rate)].label
      : fmtHz(lfoRateToHz(rate, mode))
  const sign = lfoIntTo01(s.getParam(P.LFO_INT)) < 0 ? '−' : ''
  return 'LFO → ' + sign + target + ' · ' + modeLabel + ' ' + rateStr
}

export const MONO_DEBUG_DEF: DebugDef = {
  numVoices: 1, // monophonic (spec §1) — hides the 1V/all-V toggle
  stages: [
    { label: 'VCO 1', l: 0, x: 8, y: 4 },
    // VCO2's wave selector carries the NOISE generator (spec §1/§3).
    { label: 'VCO 2/NOISE', l: 1, x: 8, y: 76 },
    { label: 'MIX', l: 2, x: 260, y: 40 },
    { label: 'FILTER', l: 3, x: 480, y: 40 },
    { label: 'VCA', l: 4, x: 8, y: 236 },
    // DRIVE is post-VCA, the final stage before the output jack (spec §7).
    { label: 'DRIVE', l: 5, x: 300, y: 236 },
    // Family final-output tap slot (see the ASSUMED TAP ORDER note above).
    { label: 'OUTPUT', l: 10, x: 560, y: 236 },
  ],
  wires: [
    // Audio path (all static: no routing switches on the monologue).
    { d: 'M178 27 H219 V63 H260' }, // VCO1 -> MIX
    { d: 'M178 99 H219 V63' }, // VCO2/NOISE joins the same MIX node
    { d: 'M430 63 H480' }, // MIX -> FILTER
    { d: 'M650 63 H726 V212 H93 V236' }, // FILTER down into the VCA
    { d: 'M178 259 H300' }, // VCA -> DRIVE
    { d: 'M470 259 H560' }, // DRIVE -> OUTPUT
    // Mod routing (visibility follows the TARGET switches, opacity the INTs).
    { d: 'M360 17 H560 V40', cls: 'xd-w-eg', on: (s) => s.getParam(P.EG_TARGET) === 0, amt: egAmt },
    { d: 'M300 17 H219 V90', cls: 'xd-w-eg', on: (s) => s.getParam(P.EG_TARGET) !== 0, amt: egAmt },
    { d: 'M360 197 H560 V104', cls: 'xd-w-lfo', on: (s) => s.getParam(P.LFO_TARGET) === 0, amt: lfoAmt },
    { d: 'M300 197 H219 V122', cls: 'xd-w-lfo', on: (s) => s.getParam(P.LFO_TARGET) !== 0, amt: lfoAmt },
  ],
  // The exclusive SYNC/RING 3-position switch (spec §3) as a tri-state badge
  // pair: SYNC lit at position 2, RING lit at position 0, neither = OFF.
  toggleBadges: [
    { x: 186, y: 46, label: 'SYNC', on: (s) => Math.round(s.getParam(P.SYNC_RING)) === 2 },
    { x: 186, y: 66, label: 'RING', on: (s) => Math.round(s.getParam(P.SYNC_RING)) === 0 },
  ],
  // Single voice: no voice sum. The badge slot marks the mono path on the
  // VCA -> DRIVE wire instead.
  sumBadge: {
    x: 239,
    y: 259,
    label: 'MONO',
    title: 'single voice, strictly mono output — DRIVE is the final stage (spec §1/§7)',
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
      y: 186,
      cls: 'xd-svc-badge--lfo',
      label: 'LFO',
      text: lfoText,
      amt: lfoAmt,
    },
  ],
  /** Compact strip: VCO 1 ⊕ VCO 2/NOISE → MIX → FILTER → DRIVE → OUTPUT. */
  compact: { indices: [0, 1, 2, 3, 5, 6], arrows: ['⊕', '→', '→', '→', '→'] },
  // Fixed source order (DbgVoice.amp, .modEg, .lfo): amp = the VCA level as
  // shaped by the EG TYPE (A/D, A/G/D or flat GATE, spec §5), modEg = the
  // A/D envelope feeding the EG TARGET, lfo = the (bipolar) LFO.
  modSigs: [
    { label: 'VCA', color: '#8fe0a0', bipolar: false },
    { label: 'EG', color: '#e0c98f', bipolar: false },
    { label: 'LFO', color: '#8fb8e0', bipolar: true },
  ],
}
