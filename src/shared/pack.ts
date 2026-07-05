/*
 * Preset pack format — weblogue's own JSON container for sharing programs.
 * A pack embeds serialized v2 program objects (shared/program.ts codec), so
 * everything a patch holds (params, sequence, motion lanes) round-trips.
 *
 *   { "format": "weblogue-pack", "version": 1, "synthId": "xd",
 *     "name": "My Pack", "programs": [ {v:2 ...}, ... ] }
 *
 * parsePack() also accepts a bare single-program JSON (the export-program
 * file) so users can drop either kind of file on the importer.
 */
import type { Program } from './program'
import type { StoreDef } from '../synths/def'

export const PACK_FORMAT = 'weblogue-pack'
export const PACK_VERSION = 1

export interface ParsedPack {
  programs: Program[]
  /** Entries that failed to deserialize (wrong synth, corrupt, ...). */
  skipped: number
}

/** The PROGRAM-level synth id (Program.synthId) — equals def.id everywhere
 *  except the prologue variants, which share one program format ('prologue')
 *  across 'prologue8'/'prologue16'. Packs stamp/compare this id so a pack
 *  exported on one variant opens on the other. */
function packSynthId(def: StoreDef): string {
  return def.initProgram().synthId
}

export function makePack(def: StoreDef, name: string, programs: readonly Program[]): string {
  return JSON.stringify(
    {
      format: PACK_FORMAT,
      version: PACK_VERSION,
      synthId: packSynthId(def),
      name,
      programs: programs.map((p) => JSON.parse(def.serializeProgram(p)) as unknown),
    },
    null,
    1,
  )
}

/** Parse a pack (or a bare single-program file). Null = not for this synth
 *  or not recognizable at all. */
export function parsePack(def: StoreDef, json: string): ParsedPack | null {
  let root: unknown
  try {
    root = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof root !== 'object' || root === null) return null
  const r = root as Record<string, unknown>

  if (r.format === PACK_FORMAT) {
    // A pack from a newer app version may hold data this codec misreads.
    if (typeof r.version === 'number' && r.version > PACK_VERSION) return null
    if (r.synthId !== packSynthId(def)) return null
    const list = Array.isArray(r.programs) ? r.programs : []
    const programs: Program[] = []
    let skipped = 0
    for (const el of list) {
      const p = def.deserializeProgram(JSON.stringify(el))
      if (p) programs.push(p)
      else skipped++
    }
    if (programs.length === 0 && skipped === 0) return null
    return { programs, skipped }
  }

  // Bare single program (the "export program" file) — but only when the
  // object is program-shaped. Arbitrary JSON (a package.json, say) must not
  // fall through to a codec's legacy no-synthId acceptance and "parse" as an
  // init program.
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(r, k)
  if (!has('v') && !has('params') && !has('synthId')) return null
  const single = def.deserializeProgram(json)
  if (single) return { programs: [single], skipped: 0 }
  return null
}
