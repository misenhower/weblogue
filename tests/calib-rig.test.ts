import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRig, saveRig } from '../tools/calib/lib/rig'

describe('calibration rig resolution', () => {
  it('combines ignored local routing with committed unit provenance', () => {
    const root = mkdtempSync(join(tmpdir(), 'calib-rig-'))
    mkdirSync(join(root, 'calib', 'rigs'), { recursive: true })
    writeFileSync(
      join(root, 'calib', 'rig.local.json'),
      JSON.stringify({ unitId: 'unit-a', midiPort: 'local midi', midiChannel: 2, audioDevice: 'local input' }),
    )
    writeFileSync(
      join(root, 'calib', 'rigs', 'unit-a.json'),
      JSON.stringify({
        hardwareUnit: { model: 'Korg minilogue xd', unitId: 'unit-a', firmware: '2.10' },
        captureChain: { interface: 'Interface A', sampleRateHz: 48_000, synthOutput: 'L', interfaceInput: '1', recorder: 'helper' },
      }),
    )

    const rig = loadRig(root)!
    expect(rig.midiPort).toBe('local midi')
    expect(rig.hardwareUnit?.unitId).toBe('unit-a')
    expect(rig.captureChain?.interface).toBe('Interface A')

    saveRig(root, { ...rig, audioDevice: 'replacement input' })
    const local = JSON.parse(readFileSync(join(root, 'calib', 'rig.local.json'), 'utf8'))
    expect(local).toEqual({
      unitId: 'unit-a',
      midiPort: 'local midi',
      midiChannel: 2,
      audioDevice: 'replacement input',
    })
    expect(existsSync(join(root, 'calib', 'rig.json'))).toBe(false)
  })
})
