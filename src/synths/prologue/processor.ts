/*
 * AudioWorklet processor for the Korg prologue replica: the shared worklet
 * shell (dsp/procshell.ts) around this synth's Engine.
 *
 * ONE processor serves BOTH hardware variants (spec §14): the worklet always
 * builds the full 16-voice engine; the prologue-8 variant is app-level
 * configuration via the replica-only VOICE CAP param (params.ts RP), which
 * bounds allocation to the first 8 voices — programs stay format-identical
 * and move freely between the two.
 */
import { Engine, DBG_TAP_SIZE } from './engine'
import { PROLOGUE_PROCESSOR_NAME } from './ids'
import { registerSynthProcessor } from '../../dsp/procshell'

registerSynthProcessor(PROLOGUE_PROCESSOR_NAME, DBG_TAP_SIZE, (sr) => new Engine(sr, 16), 16)
