/*
 * Korg monologue synth definition (pure data half — no DOM, no worklet URL;
 * the registry composes those). See src/synths/def.ts.
 */
import type { SynthDef } from '../def'
import { MONO_PROCESSOR_NAME } from './ids'
import { PARAMS, PARAM_COUNT, clampParam } from './params'
import { initProgram, cloneProgram, serializeProgram, deserializeProgram } from './program'
import { FACTORY_PRESETS } from './presets'
import { NUM_SLOTS } from '../../state/persist'

export const MONO_DEF: SynthDef = {
  id: 'mono',
  title: 'monologue',
  processorName: MONO_PROCESSOR_NAME,
  params: PARAMS,
  paramCount: PARAM_COUNT,
  clampParam,
  initProgram,
  cloneProgram,
  serializeProgram,
  deserializeProgram,
  factoryPresets: FACTORY_PRESETS,
  bankKey: 'mono-web-bank-v1',
  numSlots: NUM_SLOTS, // replica choice: 500 (hardware has 100)
}
