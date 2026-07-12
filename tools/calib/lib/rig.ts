/*
 * Rig identity: which MIDI port and audio device this machine's calibration
 * setup uses, persisted (committed) in calib/rig.json so sessions are
 * reproducible. Devices are stored by name and resolved at runtime.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface RigConfig {
  /** Substring match against MIDI port names (e.g. "minilogue xd"). */
  midiPort: string
  /** Global MIDI channel, 0-based (xd default: 0 = channel 1). */
  midiChannel: number
  /** Substring match against avfoundation audio device names; null = no interface yet. */
  audioDevice: string | null
  /** The physical synth being characterized. A stable local alias is enough;
   *  do not publish a serial number if the owner considers it sensitive. */
  hardwareUnit?: {
    model: string
    unitId: string
    firmware: string | null
  }
  /** Stable capture topology. Per-run temperature/tuning state lives in the
   *  session metadata rather than here. */
  captureChain?: {
    interface: string
    sampleRateHz: number
    synthOutput: string
    interfaceInput: string
    recorder: string
  }
  notes?: string
}

export function calibDir(root: string): string {
  return join(root, 'calib')
}

export function rigPath(root: string): string {
  return join(calibDir(root), 'rig.json')
}

export function loadRig(root: string): RigConfig | null {
  const p = rigPath(root)
  if (!existsSync(p)) return null
  const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<RigConfig>
  if (typeof parsed.midiPort !== 'string') return null
  return {
    midiPort: parsed.midiPort,
    midiChannel: typeof parsed.midiChannel === 'number' ? parsed.midiChannel : 0,
    audioDevice: typeof parsed.audioDevice === 'string' ? parsed.audioDevice : null,
    hardwareUnit:
      parsed.hardwareUnit &&
      typeof parsed.hardwareUnit.model === 'string' &&
      typeof parsed.hardwareUnit.unitId === 'string'
        ? {
            model: parsed.hardwareUnit.model,
            unitId: parsed.hardwareUnit.unitId,
            firmware: typeof parsed.hardwareUnit.firmware === 'string' ? parsed.hardwareUnit.firmware : null,
          }
        : undefined,
    captureChain:
      parsed.captureChain &&
      typeof parsed.captureChain.interface === 'string' &&
      typeof parsed.captureChain.sampleRateHz === 'number'
        ? {
            interface: parsed.captureChain.interface,
            sampleRateHz: parsed.captureChain.sampleRateHz,
            synthOutput: parsed.captureChain.synthOutput ?? 'unknown',
            interfaceInput: parsed.captureChain.interfaceInput ?? 'unknown',
            recorder: parsed.captureChain.recorder ?? 'unknown',
          }
        : undefined,
    notes: typeof parsed.notes === 'string' ? parsed.notes : undefined,
  }
}

export function saveRig(root: string, rig: RigConfig): void {
  mkdirSync(calibDir(root), { recursive: true })
  writeFileSync(rigPath(root), JSON.stringify(rig, null, 2) + '\n')
}
