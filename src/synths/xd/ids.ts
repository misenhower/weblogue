/*
 * Worklet-safe identifiers shared by def.ts (main thread) and processor.ts
 * (worklet bundle) — kept out of def.ts so the worklet bundle never pulls in
 * the factory presets.
 */

/** AudioWorkletProcessor registration name. */
export const XD_PROCESSOR_NAME = 'xd-processor'
