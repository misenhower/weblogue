/*
 * AudioWorklet processor for the Korg monologue replica: the shared worklet
 * shell (dsp/procshell.ts) around this synth's Engine (one voice — the
 * monologue is monophonic).
 */
import { Engine, DBG_TAP_SIZE } from './engine'
import { MONO_PROCESSOR_NAME } from './ids'
import { registerSynthProcessor } from '../../dsp/procshell'

registerSynthProcessor(MONO_PROCESSOR_NAME, DBG_TAP_SIZE, (sr) => new Engine(sr), 1)
