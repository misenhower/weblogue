/*
 * Ambient declarations for the AudioWorkletGlobalScope, which is not covered
 * by lib.dom. Only what the DSP code uses.
 */

declare const sampleRate: number
declare const currentFrame: number
declare const currentTime: number

interface AudioWorkletProcessor {
  readonly port: MessagePort
}

declare const AudioWorkletProcessor: {
  prototype: AudioWorkletProcessor
  new (options?: any): AudioWorkletProcessor
}

interface AudioParamDescriptor {
  name: string
  defaultValue?: number
  minValue?: number
  maxValue?: number
  automationRate?: 'a-rate' | 'k-rate'
}

declare function registerProcessor(
  name: string,
  processorCtor: (new (options?: any) => AudioWorkletProcessor & {
    process(
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      parameters: Record<string, Float32Array>,
    ): boolean
  }) & { parameterDescriptors?: AudioParamDescriptor[] },
): void
