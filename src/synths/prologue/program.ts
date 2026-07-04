/*
 * Korg prologue program init + serialization: makeProgramCodec bound to the
 * prologue param table. Serialization is by stable param key so saved
 * programs survive id changes. Mirrors synths/og/program.ts.
 *
 * One SYNTH_ID serves both variants: prologue-8 and prologue-16 programs are
 * format-identical on hardware (prologue-spec.md §14) — the 8-vs-16 choice
 * is app-level configuration, and programs move freely between the two.
 */
import { makeProgramCodec } from '../../shared/program'
import { PARAMS, PARAM_BY_KEY, clampParam } from './params'

export const SYNTH_ID = 'prologue'

// v1 files (no synthId) predate the synth split and are xd programs — refuse.
export const { initProgram, cloneProgram, serializeProgram, deserializeProgram } = makeProgramCodec({
  synthId: SYNTH_ID,
  params: PARAMS,
  paramByKey: PARAM_BY_KEY,
  clampParam,
  acceptLegacyNoSynthId: false,
})
