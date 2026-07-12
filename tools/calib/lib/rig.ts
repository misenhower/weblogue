/*
 * Rig identity: which MIDI port and audio device this machine's calibration
 * setup uses. Machine-local routing lives in ignored rig.local.json; stable
 * unit/capture provenance lives in committed rigs/<unit-id>.json.
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

interface LocalRigConfig {
  unitId?: string
  midiPort: string
  midiChannel: number
  audioDevice: string | null
}

type RigIdentity = Pick<RigConfig, 'hardwareUnit' | 'captureChain' | 'notes'>

export function calibDir(root: string): string {
  return join(root, 'calib')
}

export function rigPath(root: string): string {
  return join(calibDir(root), 'rig.local.json')
}

export function rigIdentityPath(root: string, unitId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(unitId)) throw new Error(`invalid rig unit id: ${unitId}`)
  return join(calibDir(root), 'rigs', `${unitId}.json`)
}

export function loadRig(root: string): RigConfig | null {
  const p = rigPath(root)
  if (!existsSync(p)) return null
  const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<LocalRigConfig>
  if (typeof parsed.midiPort !== 'string') return null
  let identity: RigIdentity = {}
  if (typeof parsed.unitId === 'string') {
    const identityPath = rigIdentityPath(root, parsed.unitId)
    if (existsSync(identityPath)) {
      identity = JSON.parse(readFileSync(identityPath, 'utf8')) as RigIdentity
      if (identity.hardwareUnit?.unitId !== parsed.unitId) {
        throw new Error(`rig identity ${identityPath} does not match selected unit ${parsed.unitId}`)
      }
    }
  }
  return {
    midiPort: parsed.midiPort,
    midiChannel: typeof parsed.midiChannel === 'number' ? parsed.midiChannel : 0,
    audioDevice: typeof parsed.audioDevice === 'string' ? parsed.audioDevice : null,
    hardwareUnit:
      identity.hardwareUnit &&
      typeof identity.hardwareUnit.model === 'string' &&
      typeof identity.hardwareUnit.unitId === 'string'
        ? {
            model: identity.hardwareUnit.model,
            unitId: identity.hardwareUnit.unitId,
            firmware: typeof identity.hardwareUnit.firmware === 'string' ? identity.hardwareUnit.firmware : null,
          }
        : undefined,
    captureChain:
      identity.captureChain &&
      typeof identity.captureChain.interface === 'string' &&
      typeof identity.captureChain.sampleRateHz === 'number'
        ? {
            interface: identity.captureChain.interface,
            sampleRateHz: identity.captureChain.sampleRateHz,
            synthOutput: identity.captureChain.synthOutput ?? 'unknown',
            interfaceInput: identity.captureChain.interfaceInput ?? 'unknown',
            recorder: identity.captureChain.recorder ?? 'unknown',
          }
        : undefined,
    notes: typeof identity.notes === 'string' ? identity.notes : undefined,
  }
}

export function saveRig(root: string, rig: RigConfig): void {
  mkdirSync(calibDir(root), { recursive: true })
  const local: LocalRigConfig = {
    ...(rig.hardwareUnit?.unitId ? { unitId: rig.hardwareUnit.unitId } : {}),
    midiPort: rig.midiPort,
    midiChannel: rig.midiChannel,
    audioDevice: rig.audioDevice,
  }
  writeFileSync(rigPath(root), JSON.stringify(local, null, 2) + '\n')
}
