/*
 * minilogue xd program init + serialization: makeProgramCodec bound to the
 * xd param table. Serialization is by stable param key so saved programs
 * survive id changes.
 */
import { makeProgramCodec } from '../../shared/program'
import { PARAMS, PARAM_BY_KEY, clampParam } from './params'

export const SYNTH_ID = 'xd'

// v1 files predate synthId and are always xd programs, so accept them here.
export const { initProgram, cloneProgram, serializeProgram, deserializeProgram } = makeProgramCodec({
  synthId: SYNTH_ID,
  params: PARAMS,
  paramByKey: PARAM_BY_KEY,
  clampParam,
  acceptLegacyNoSynthId: true,
})
