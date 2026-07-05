/*
 * Shared preset-pack infrastructure: the zero-dependency ZIP reader/writer
 * (shared/zip.ts), the Korg container walker (shared/korgfile.ts) and the
 * weblogue JSON pack codec (shared/pack.ts).
 */
import { describe, expect, it } from 'vitest'
import { zip, unzip, crc32 } from '../src/shared/zip'
import { parseKorgContainer, buildKorgProgFile } from '../src/shared/korgfile'
import { makePack, parsePack, PACK_VERSION } from '../src/shared/pack'
import { XD_DEF } from '../src/synths/xd/def'
import { OG_DEF } from '../src/synths/og/def'
import { FACTORY_PRESETS } from '../src/synths/xd/presets'
import { makePrologueDef } from '../src/synths/prologue/def'
import { RP } from '../src/synths/prologue/params'

describe('zip', () => {
  it('roundtrips entries through write + read', async () => {
    const entries = [
      { name: 'a.txt', data: new TextEncoder().encode('hello world') },
      { name: 'dir/b.bin', data: new Uint8Array([0, 1, 2, 250, 251, 252]) },
      { name: 'empty', data: new Uint8Array(0) },
    ]
    const bytes = await zip(entries)
    const out = await unzip(bytes)
    expect(out.map((e) => e.name)).toEqual(['a.txt', 'dir/b.bin', 'empty'])
    expect(new TextDecoder().decode(out[0].data)).toBe('hello world')
    expect([...out[1].data]).toEqual([0, 1, 2, 250, 251, 252])
    expect(out[2].data.length).toBe(0)
  })

  it('roundtrips a large incompressible payload', async () => {
    const data = new Uint8Array(50000)
    for (let i = 0; i < data.length; i++) data[i] = (i * 7919 + (i >> 3)) & 0xff
    const out = await unzip(await zip([{ name: 'noise', data }]))
    expect(out[0].data).toEqual(data)
  })

  it('rejects non-zip data', async () => {
    await expect(unzip(new TextEncoder().encode('definitely not a zip file, no sir'))).rejects.toThrow(/ZIP/)
  })

  it('crc32 matches the reference value for "123456789"', () => {
    // Canonical CRC-32 check value (ISO 3309 / zlib).
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })
})

describe('korg container', () => {
  it('extracts prog_bin entries sorted by index and ignores other files', async () => {
    const bytes = await zip([
      { name: 'FileInformation.xml', data: new TextEncoder().encode('<xml/>') },
      { name: 'Prog_010.prog_bin', data: new Uint8Array([10]) },
      { name: 'Prog_002.prog_bin', data: new Uint8Array([2]) },
      { name: 'Prog_002.prog_info', data: new TextEncoder().encode('<info/>') },
    ])
    const bins = await parseKorgContainer(bytes)
    expect(bins.map((b) => b.index)).toEqual([2, 10])
    expect([...bins[0].data]).toEqual([2])
  })

  it('buildKorgProgFile produces a container the walker can read back', async () => {
    const payload = new Uint8Array([80, 82, 79, 71, 1, 2, 3])
    const file = await buildKorgProgFile('minilogue xd', 'xd_ProgramInformation', payload)
    const bins = await parseKorgContainer(file)
    expect(bins.length).toBe(1)
    expect(bins[0].name).toBe('Prog_000.prog_bin')
    expect(bins[0].data).toEqual(payload)
    const all = await unzip(file)
    const manifest = all.find((e) => e.name === 'FileInformation.xml')
    expect(manifest).toBeDefined()
    expect(new TextDecoder().decode(manifest!.data)).toContain('<Product>minilogue xd</Product>')
  })
})

describe('pack', () => {
  it('roundtrips factory presets through makePack + parsePack', () => {
    const programs = FACTORY_PRESETS.slice(0, 5)
    const json = makePack(XD_DEF, 'test pack', programs)
    const parsed = parsePack(XD_DEF, json)
    expect(parsed).not.toBeNull()
    expect(parsed!.skipped).toBe(0)
    expect(parsed!.programs.length).toBe(5)
    for (let i = 0; i < 5; i++) {
      expect(XD_DEF.serializeProgram(parsed!.programs[i])).toBe(XD_DEF.serializeProgram(programs[i]))
    }
  })

  it('rejects packs for another synth', () => {
    const json = makePack(XD_DEF, 'xd pack', FACTORY_PRESETS.slice(0, 1))
    expect(parsePack(OG_DEF, json)).toBeNull()
  })

  it('rejects packs from a newer format version', () => {
    const obj = JSON.parse(makePack(XD_DEF, 'future pack', FACTORY_PRESETS.slice(0, 1))) as Record<string, unknown>
    obj.version = PACK_VERSION + 1
    expect(parsePack(XD_DEF, JSON.stringify(obj))).toBeNull()
    obj.version = PACK_VERSION // sanity: same pack parses at the current version
    expect(parsePack(XD_DEF, JSON.stringify(obj))).not.toBeNull()
  })

  it('prologue packs cross variants: the envelope carries the program-level id', () => {
    const p8 = makePrologueDef(8)
    const p16 = makePrologueDef(16)

    // 8-voice pack opens on the 16.
    const json8 = makePack(p8, 'from the 8', [p8.initProgram('Eight Prog')])
    const on16 = parsePack(p16, json8)
    expect(on16).not.toBeNull()
    expect(on16!.skipped).toBe(0)
    expect(on16!.programs.length).toBe(1)
    expect(on16!.programs[0].name).toBe('Eight Prog')

    // 16-voice pack opens on the 8, and its VOICE CAP clamp still applies.
    const wide = p16.initProgram('Sixteen Prog')
    wide.params[RP.VOICE_CAP] = 16
    const on8 = parsePack(p8, makePack(p16, 'from the 16', [wide]))
    expect(on8).not.toBeNull()
    expect(on8!.programs.length).toBe(1)
    expect(on8!.programs[0].params[RP.VOICE_CAP]).toBe(8)
  })

  it('accepts a bare single-program export', () => {
    const single = XD_DEF.serializeProgram(FACTORY_PRESETS[0])
    const parsed = parsePack(XD_DEF, single)
    expect(parsed).not.toBeNull()
    expect(parsed!.programs.length).toBe(1)
    expect(parsed!.programs[0].name).toBe(FACTORY_PRESETS[0].name)
  })

  it('does not misread arbitrary JSON objects as a bare program', () => {
    // package.json-shaped: no 'v'/'params'/'synthId' key, so the bare-program
    // fallback must not hand it to the codec's legacy no-synthId acceptance.
    const pkg = JSON.stringify({ name: 'some-package', version: '1.0.0', private: true })
    expect(parsePack(XD_DEF, pkg)).toBeNull()
  })

  it('returns null for garbage', () => {
    expect(parsePack(XD_DEF, 'not json at all')).toBeNull()
    expect(parsePack(XD_DEF, '{"format":"weblogue-pack","synthId":"xd"}')).toBeNull()
  })
})
