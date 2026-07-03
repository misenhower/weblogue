/*
 * Original Korg minilogue (OG) DebugDef — same shape as the xd's
 * (synths/xd/debug-def.ts) over the OG signal path and param table.
 *
 * Signal path: VCO 1 ⊕ VCO 2 ⊕ NOISE -> MIX -> FILTER -> VCA -> Σ×4 ->
 * HI PASS+DELAY -> OUTPUT. The OG engine records the same 12-ring dbg layout
 * as the xd (see synths/og/engine.ts): voice taps 0-5 are VCO1/VCO2/NOISE/
 * MIX/FILTER/VCA (tapM carries NOISE — there is no multi engine), FX pairs
 * 6-7 = the PRE-DELAY voice sum, 8-9 = POST-DELAY, 10-11 = final output.
 *
 * Readout differences vs the xd: LFO INT is UNIPOLAR (0..1023 -> 0..1, no
 * 512 center), the filter EG always targets CUTOFF (no EG TARGET switch),
 * and the separate PITCH EG INT knob (EG -> VCO 2 pitch, ±4800¢) gets its
 * own badge + wire.
 */
import type { DebugDef } from '../../ui/debugpanel'
import type { Store } from '../../state/store'
import { P } from './params'
import { egIntToPercent, pitchEgIntToCents, lfoIntTo01 } from './curves'

/** Filter EG intensity 0..1 (bipolar percent knob, quadratic curve). */
const egAmt = (s: Store): number => Math.abs(egIntToPercent(s.getParam(P.EG_INT))) / 100
/** Pitch EG intensity 0..1 (±4800¢ knob, EG -> VCO 2 pitch). */
const pitchEgAmt = (s: Store): number =>
  Math.abs(pitchEgIntToCents(s.getParam(P.PITCH_EG_INT))) / 4800
/** LFO intensity 0..1 — unipolar on the OG (og-spec.md §8). */
const lfoAmt = (s: Store): number => lfoIntTo01(s.getParam(P.LFO_INT))

export const OG_DEBUG_DEF: DebugDef = {
  stages: [
    { label: 'VCO 1', l: 0, x: 8, y: 4 },
    { label: 'VCO 2', l: 1, x: 8, y: 76 },
    { label: 'NOISE', l: 2, x: 8, y: 148 },
    { label: 'MIX', l: 3, x: 260, y: 76 },
    { label: 'FILTER', l: 4, x: 480, y: 76 },
    { label: 'VCA', l: 5, x: 8, y: 236 },
    // The OG is strictly MONO out (single output jack; stereo came with the
    // xd) — the engine's FX tap pairs carry identical channels, so these
    // cells render mono (no L/R overlay or legend).
    { label: 'PRE DELAY', l: 6, x: 248, y: 236 },
    { label: 'HI PASS+DELAY', l: 8, x: 444, y: 236 },
    { label: 'OUTPUT', l: 10, x: 626, y: 236 },
  ],
  wires: [
    // Audio path (all static: the OG has no multi pre/post-VCF routing).
    { d: 'M178 27 H219 V99 H260' }, // VCO1 -> MIX
    { d: 'M178 99 H260' }, // VCO2 -> MIX
    { d: 'M178 171 H219 V99' }, // NOISE -> MIX
    { d: 'M430 99 H480' }, // MIX -> FILTER
    { d: 'M650 99 H726 V212 H93 V236' }, // FILTER down into the VCA
    { d: 'M178 259 H248' }, // VCA -> (voice sum) -> PRE DELAY
    { d: 'M418 259 H444' }, // PRE DELAY -> HI PASS+DELAY
    { d: 'M614 259 H626' }, // HI PASS+DELAY -> OUTPUT
    // Mod routing (opacity follows the intensity knobs; the filter EG has a
    // fixed CUTOFF target, so only the intensities gate visibility).
    { d: 'M360 17 H560 V76', cls: 'xd-w-eg', on: () => true, amt: egAmt },
    { d: 'M300 39 H219 V90', cls: 'xd-w-eg', on: () => true, amt: pitchEgAmt },
    { d: 'M360 197 H560 V140', cls: 'xd-w-lfo', on: (s) => s.getParam(P.LFO_TARGET) === 0, amt: lfoAmt },
    { d: 'M300 197 H219 V180', cls: 'xd-w-lfo', on: (s) => s.getParam(P.LFO_TARGET) !== 0, amt: lfoAmt },
  ],
  // VCO1<->VCO2 relationship badges (same trio as the xd: the OG panel has
  // SYNC/RING switches and a CROSS MOD DEPTH knob).
  toggleBadges: [
    { x: 186, y: 36, label: 'SYNC', on: (s) => s.getParam(P.SYNC) >= 0.5 },
    { x: 186, y: 56, label: 'RING', on: (s) => s.getParam(P.RING) >= 0.5 },
    { x: 186, y: 76, label: 'X-MOD', on: (s) => s.getParam(P.CROSS_MOD) > 8 },
  ],
  // The OG mono-sums all four voices between the VCAs and the delay
  // (synths/og/engine.ts voice loop); same wire midpoint as the xd.
  sumBadge: {
    x: 213,
    y: 259,
    label: 'Σ ×4',
    title: 'all four voices are mono-summed here, before the delay',
  },
  modBadges: [
    {
      x: 296,
      y: 6,
      cls: 'xd-svc-badge--eg',
      label: 'EG',
      text: () => 'EG → CUTOFF', // fixed target; only the intensity varies
      amt: egAmt,
    },
    {
      x: 296,
      y: 28,
      cls: 'xd-svc-badge--eg',
      label: 'PITCH EG',
      text: () => 'PITCH EG → VCO 2',
      amt: pitchEgAmt,
    },
    {
      x: 296,
      y: 186,
      cls: 'xd-svc-badge--lfo',
      label: 'LFO',
      // 0 CUTOFF, 1 SHAPE, 2 PITCH — no per-oscillator selector on the OG.
      text: (s) => 'LFO → ' + (['CUTOFF', 'SHAPE', 'PITCH'][s.getParam(P.LFO_TARGET)] ?? ''),
      amt: lfoAmt,
    },
  ],
  /** Compact strip: VCO 1 ⊕ VCO 2 ⊕ NOISE → MIX → FILTER → OUTPUT. */
  compact: { indices: [0, 1, 2, 3, 4, 8], arrows: ['⊕', '⊕', '→', '→', '→'] },
  // The OG's assignable EG is a full ADSR simply labeled "EG" (og-spec.md §7).
  modSigs: [
    { label: 'AMP EG', color: '#8fe0a0', bipolar: false },
    { label: 'EG', color: '#e0c98f', bipolar: false },
    { label: 'LFO', color: '#8fb8e0', bipolar: true },
  ],
}
