/*
 * minilogue xd synth definition (pure data half — no DOM, no worklet URL;
 * the registry composes those). See src/synths/def.ts.
 */
import type { SynthDef } from '../def'
import { PARAMS, PARAM_COUNT, clampParam } from './params'
import { initProgram, cloneProgram, serializeProgram, deserializeProgram } from './program'
import { FACTORY_PRESETS } from './presets'
import { NUM_SLOTS } from '../../state/persist'

export const XD_DEF: SynthDef = {
  id: 'xd',
  title: 'minilogue xd',
  processorName: 'xd-processor',
  params: PARAMS,
  paramCount: PARAM_COUNT,
  clampParam,
  initProgram,
  cloneProgram,
  serializeProgram,
  deserializeProgram,
  factoryPresets: FACTORY_PRESETS,
  bankKey: 'xd-web-bank-v1', // pre-multi-synth key: existing user banks keep working
  numSlots: NUM_SLOTS,
}
