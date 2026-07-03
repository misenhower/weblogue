/*
 * minilogue xd DebugDef — SERVICE MODE's synth-specific surface: tap
 * labels/positions, the block-diagram wires (audio path + store-driven mod
 * routing), SYNC/RING/X-MOD badges, the EG/LFO routing readouts with their
 * intensity curves, the compact-strip layout, and the modulator lane labels.
 * Hoisted out of src/ui/debugpanel.ts so the drawer can be reused by other
 * synth definitions (same pattern as display-def.ts).
 *
 * Signal path (see docs/service-mode.md): VCO 1 ⊕ VCO 2 ⊕ MULTI -> MIX ->
 * VCF -> VCA -> Σ×4 -> MOD FX -> DELAY -> OUTPUT. Tap indices follow the dbg
 * frame layout in shared/messages.ts (0-5 mono voice stages, 6-11 stereo FX
 * pairs).
 */
import type { DebugDef } from '../../ui/debugpanel'
import type { Store } from '../../state/store'
import { P } from './params'
import { egIntToPercent, lfoIntTo01 } from './curves'

/** EG intensity 0..1 (bipolar percent knob, quadratic curve). */
const egAmt = (s: Store): number => Math.abs(egIntToPercent(s.getParam(P.EG_INT))) / 100
/** LFO intensity 0..1 (bipolar 512-centered store). */
const lfoAmt = (s: Store): number => Math.abs(lfoIntTo01(s.getParam(P.LFO_INT)))

export const XD_DEBUG_DEF: DebugDef = {
  stages: [
    { label: 'VCO 1', l: 0, x: 8, y: 4 },
    { label: 'VCO 2', l: 1, x: 8, y: 76 },
    { label: 'MULTI', l: 2, x: 8, y: 148 },
    { label: 'MIX', l: 3, x: 260, y: 76 },
    { label: 'VCF', l: 4, x: 480, y: 76 },
    { label: 'VCA', l: 5, x: 8, y: 236 },
    { label: 'MOD FX', l: 6, r: 7, x: 248, y: 236 },
    { label: 'DELAY', l: 8, r: 9, x: 444, y: 236 },
    { label: 'OUTPUT', l: 10, r: 11, x: 626, y: 236 },
  ],
  wires: [
    // Audio path.
    { d: 'M178 27 H219 V99 H260' }, // VCO1 -> MIX
    { d: 'M178 99 H260' }, // VCO2 -> MIX
    // MULTI routing pre/post VCF (visibility follows Multi Routing).
    { d: 'M178 171 H219 V99', on: (s) => s.getParam(P.MULTI_ROUTING) < 0.5 },
    { d: 'M178 171 H726 V212', on: (s) => s.getParam(P.MULTI_ROUTING) >= 0.5 },
    { d: 'M430 99 H480' }, // MIX -> VCF
    { d: 'M650 99 H726 V212 H93 V236' }, // VCF down into the VCA
    { d: 'M178 259 H248' }, // VCA -> (voice sum) -> MOD FX
    { d: 'M418 259 H444' }, // MOD FX -> DELAY
    { d: 'M614 259 H626' }, // DELAY -> OUTPUT
    // Mod routing (visibility/opacity follow the current program).
    { d: 'M360 17 H560 V76', cls: 'xd-w-eg', on: (s) => s.getParam(P.EG_TARGET) === 0, amt: egAmt },
    { d: 'M300 17 H219 V90', cls: 'xd-w-eg', on: (s) => s.getParam(P.EG_TARGET) !== 0, amt: egAmt },
    { d: 'M360 197 H560 V140', cls: 'xd-w-lfo', on: (s) => s.getParam(P.LFO_TARGET) === 0, amt: lfoAmt },
    { d: 'M300 197 H219 V180', cls: 'xd-w-lfo', on: (s) => s.getParam(P.LFO_TARGET) !== 0, amt: lfoAmt },
  ],
  // VCO1<->VCO2 relationship badges.
  toggleBadges: [
    { x: 186, y: 36, label: 'SYNC', on: (s) => s.getParam(P.SYNC) >= 0.5 },
    { x: 186, y: 56, label: 'RING', on: (s) => s.getParam(P.RING) >= 0.5 },
    { x: 186, y: 76, label: 'X-MOD', on: (s) => s.getParam(P.CROSS_MOD) > 8 },
  ],
  // The xd mono-sums all four voices between the VCAs and the FX chain.
  // Centered on the VCA->MOD FX wire (gap midpoint x=213, wire y=259).
  sumBadge: {
    x: 213,
    y: 259,
    label: 'Σ ×4',
    title: 'all four voices are mono-summed here, before the effects',
  },
  modBadges: [
    {
      x: 296,
      y: 6,
      cls: 'xd-svc-badge--eg',
      label: 'EG',
      text: (s) => 'EG → ' + (['CUTOFF', 'PITCH 2', 'PITCH'][s.getParam(P.EG_TARGET)] ?? ''),
      amt: egAmt,
    },
    {
      x: 296,
      y: 186,
      cls: 'xd-svc-badge--lfo',
      label: 'LFO',
      text: (s) => {
        const lfoT = s.getParam(P.LFO_TARGET) // 0 CUTOFF, 1 SHAPE, 2 PITCH
        const oscSel = ['ALL', 'VCO 1+2', 'VCO 2', 'MULTI'][s.getParam(P.LFO_TARGET_OSC)] ?? 'ALL'
        return 'LFO → ' + (['CUTOFF', 'SHAPE', 'PITCH'][lfoT] ?? '') + (lfoT !== 0 ? ' · ' + oscSel : '')
      },
      amt: lfoAmt,
    },
  ],
  /** Compact strip: VCO 1 ⊕ VCO 2 ⊕ MULTI → MIX → VCF → OUTPUT. */
  compact: { indices: [0, 1, 2, 3, 4, 8], arrows: ['⊕', '⊕', '→', '→', '→'] },
  modSigs: [
    { label: 'AMP EG', color: '#8fe0a0', bipolar: false },
    { label: 'MOD EG', color: '#e0c98f', bipolar: false },
    { label: 'LFO', color: '#8fb8e0', bipolar: true },
  ],
}
