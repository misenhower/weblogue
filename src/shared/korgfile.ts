/*
 * Korg librarian container handling — .mnlgprog/.molgprog/.mnlgxdprog/
 * .prlgprog (single program) and their *lib bank siblings are all ZIP
 * archives holding Prog_NNN.prog_bin binaries plus XML manifests. This
 * module is format-agnostic: it extracts/binds the prog_bin payloads;
 * decoding a payload into a Program is the per-synth codec's job
 * (synths/<id>/progbin.ts, wired as SynthDef.korgFile).
 */
import { unzip, zip, type ZipEntry } from './zip'

export interface KorgBinEntry {
  /** Archive entry name, e.g. 'Prog_012.prog_bin'. */
  name: string
  /** Slot number parsed from the name (-1 when unparseable). */
  index: number
  data: Uint8Array
}

/** Extract every prog_bin payload from a Korg container, sorted by slot. */
export async function parseKorgContainer(bytes: Uint8Array): Promise<KorgBinEntry[]> {
  const entries = await unzip(bytes)
  const bins: KorgBinEntry[] = []
  for (const e of entries) {
    if (!e.name.toLowerCase().endsWith('.prog_bin')) continue
    const m = /(\d+)\.prog_bin$/i.exec(e.name)
    bins.push({ name: e.name, index: m ? Number(m[1]) : -1, data: e.data })
  }
  bins.sort((a, b) => a.index - b.index)
  return bins
}

/**
 * Build a single-program Korg file (the .*prog container): manifest +
 * prog_info + prog_bin, matching the librarian's layout. `product` is the
 * manifest product string (e.g. 'minilogue xd'), `infoTag` the prog_info
 * root element (e.g. 'xd_ProgramInformation').
 */
export async function buildKorgProgFile(
  product: string,
  infoTag: string,
  progBin: Uint8Array,
): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const info =
    '<?xml version="1.0" encoding="UTF-8"?>\n\n' +
    `<${infoTag}>\n` +
    '  <Programmer></Programmer>\n' +
    '  <Comment></Comment>\n' +
    `</${infoTag}>\n`
  const manifest =
    '<?xml version="1.0" encoding="UTF-8"?>\n\n' +
    '<KorgMSLibrarian_Data>\n' +
    `  <Product>${product}</Product>\n` +
    '  <Contents NumProgramData="1" NumPresetInformation="0"\n' +
    '            NumTuneScaleData="0" NumTuneOctData="0">\n' +
    '    <ProgramData>\n' +
    '      <Information>Prog_000.prog_info</Information>\n' +
    '      <ProgramBinary>Prog_000.prog_bin</ProgramBinary>\n' +
    '    </ProgramData>\n' +
    '  </Contents>\n' +
    '</KorgMSLibrarian_Data>\n'
  const entries: ZipEntry[] = [
    { name: 'Prog_000.prog_info', data: enc.encode(info) },
    { name: 'Prog_000.prog_bin', data: progBin },
    { name: 'FileInformation.xml', data: enc.encode(manifest) },
  ]
  return zip(entries)
}
