/*
 * prologue synth definitions — one parameterized factory, two variants
 * (prologue-8 / prologue-16). Programs are format-identical across variants
 * (SYNTH_ID 'prologue'); each variant keeps its own bank. The 8-voice
 * variant clamps the replica-only VOICE CAP param on init/load so its
 * programs never allocate beyond its hardware pool.
 */
import type { SynthDef } from '../def'
import type { Program } from '../../shared/program'
import { PROLOGUE_PROCESSOR_NAME, type PrologueVariant, VARIANT_VOICES } from './ids'
import { PARAMS, PARAM_COUNT, clampParam, RP } from './params'
import { initProgram, cloneProgram, serializeProgram, deserializeProgram } from './program'
import { FACTORY_PRESETS } from './presets'
import { NUM_SLOTS } from '../../state/persist'

function capped(p: Program | null, cap: number): Program | null {
  if (p && p.params[RP.VOICE_CAP] > cap) p.params[RP.VOICE_CAP] = cap
  return p
}

export function makePrologueDef(variant: PrologueVariant): SynthDef {
  const cap = VARIANT_VOICES[variant]
  return {
    id: `prologue${variant}`,
    title: `prologue ${variant}`,
    processorName: PROLOGUE_PROCESSOR_NAME,
    params: PARAMS,
    paramCount: PARAM_COUNT,
    clampParam,
    initProgram: (name?: string) => capped(initProgram(name), cap) as Program,
    cloneProgram: (p: Program) => capped(cloneProgram(p), cap) as Program,
    serializeProgram,
    deserializeProgram: (json: string) => capped(deserializeProgram(json), cap),
    factoryPresets: FACTORY_PRESETS,
    bankKey: `prologue${variant}-web-bank-v1`,
    numSlots: NUM_SLOTS,
  }
}
