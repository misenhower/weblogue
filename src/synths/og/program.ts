/*
 * Original Korg minilogue (OG) program init + serialization: makeProgramCodec
 * bound to the OG param table. Serialization is by stable param key so saved
 * programs survive id changes. Mirrors synths/xd/program.ts.
 */
import { makeProgramCodec } from '../../shared/program'
import { PARAMS, PARAM_BY_KEY, clampParam } from './params'

export const SYNTH_ID = 'og'

// v1 files (no synthId) predate the synth split and are xd programs — refuse.
export const { initProgram, cloneProgram, serializeProgram, deserializeProgram } = makeProgramCodec({
  synthId: SYNTH_ID,
  params: PARAMS,
  paramByKey: PARAM_BY_KEY,
  clampParam,
  acceptLegacyNoSynthId: false,
})
