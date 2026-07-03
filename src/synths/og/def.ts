/*
 * Original minilogue synth definition (pure data half — no DOM, no worklet
 * URL; the registry composes those). See src/synths/def.ts.
 */
import type { SynthDef } from '../def'
import { PARAMS, PARAM_COUNT, clampParam } from './params'
import { initProgram, cloneProgram, serializeProgram, deserializeProgram } from './program'
import { FACTORY_PRESETS } from './presets'
import { NUM_SLOTS } from '../../state/persist'

export const OG_DEF: SynthDef = {
  id: 'og',
  title: 'minilogue',
  processorName: 'og-processor', // must match OG_PROCESSOR_NAME (./processor.ts)
  params: PARAMS,
  paramCount: PARAM_COUNT,
  clampParam,
  initProgram,
  cloneProgram,
  serializeProgram,
  deserializeProgram,
  factoryPresets: FACTORY_PRESETS,
  bankKey: 'og-web-bank-v1',
  numSlots: NUM_SLOTS, // replica choice: 500 like the xd (hardware has 200)
}
