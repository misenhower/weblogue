/*
 * AudioWorklet processor for the minilogue xd replica: the shared worklet
 * shell (dsp/procshell.ts) around this synth's Engine.
 */
import { Engine, DBG_TAP_SIZE } from './engine'
import { XD_PROCESSOR_NAME } from './ids'
import { registerSynthProcessor } from '../../dsp/procshell'

registerSynthProcessor(XD_PROCESSOR_NAME, DBG_TAP_SIZE, (sr) => new Engine(sr))
