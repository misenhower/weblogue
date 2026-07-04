/*
 * Worklet-safe identifiers shared by def.ts (main thread) and processor.ts
 * (worklet bundle) — kept out of def.ts so the worklet bundle never pulls in
 * the factory presets. Mirrors synths/og/ids.ts.
 */

/** AudioWorkletProcessor registration name. */
export const MONO_PROCESSOR_NAME = 'mono-processor'
