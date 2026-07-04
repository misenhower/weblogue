/*
 * Worklet-safe identifiers shared by def.ts (main thread) and processor.ts
 * (worklet bundle) — kept out of def.ts so the worklet bundle never pulls in
 * the factory presets. Mirrors synths/og/ids.ts.
 *
 * One worklet serves BOTH prologue variants (prologue-8 / prologue-16):
 * hardware programs are format-identical (prologue-spec.md §14), so the
 * 8-vs-16 choice (voice count, keyboard span, TIMBRE panel, L.F. COMP) is
 * app-level configuration, not a separate synth definition.
 */

/** AudioWorkletProcessor registration name. */
export const PROLOGUE_PROCESSOR_NAME = 'prologue-processor'

/** Hardware variant: prologue-8 or prologue-16 (spec §14). */
export type PrologueVariant = 8 | 16

/** Voice count per variant (bitimbral split is 4+4 / 8+8, spec §14). */
export const VARIANT_VOICES: Record<PrologueVariant, number> = { 8: 8, 16: 16 }
