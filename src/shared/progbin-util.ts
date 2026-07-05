/*
 * Byte-level helpers shared by the 'logue-family prog_bin codecs
 * (src/synths/<id>/progbin.ts). Only utilities that are genuinely identical
 * across the four synths live here — every codec keeps its own layout
 * constants, offsets and value transforms, which is where the formats differ.
 */

/** Round + clamp into [lo, hi]. */
export function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)))
}

// ---------------------------------------------------------------------------
// Magic tags ('PROG', 'SEQD', 'PRED', 'SQ')
// ---------------------------------------------------------------------------

/** True when `magic` is stored as raw ASCII at `off`. */
export function hasMagic(bytes: Uint8Array, off: number, magic: string): boolean {
  for (let i = 0; i < magic.length; i++) {
    if (bytes[off + i] !== magic.charCodeAt(i)) return false
  }
  return true
}

/** Write `magic` as raw ASCII at `off`. */
export function writeMagic(out: Uint8Array, off: number, magic: string): void {
  for (let i = 0; i < magic.length; i++) out[off + i] = magic.charCodeAt(i)
}

// ---------------------------------------------------------------------------
// PROGRAM NAME field (fixed-width ASCII, NUL padded)
// ---------------------------------------------------------------------------

/**
 * Read a fixed-width NUL-terminated program name. One normalization for all
 * four codecs: keep printable ASCII (32..126) only — anything else is
 * dropped — trim trailing whitespace, and fall back to 'Program' when the
 * result is empty, so an all-NUL name field never yields a nameless program.
 */
export function readFixedAscii(bytes: Uint8Array, off: number, len: number): string {
  let s = ''
  for (let i = 0; i < len; i++) {
    const c = bytes[off + i]
    if (c === 0) break // NUL terminator
    if (c >= 32 && c <= 126) s += String.fromCharCode(c)
  }
  s = s.replace(/\s+$/, '')
  return s.length > 0 ? s : 'Program'
}

/**
 * Write a program name into its fixed-width field: truncated to `len`,
 * printable ASCII kept, anything else stored as '?' (visible and
 * position-preserving); NUL padding is the buffer's existing zeros.
 */
export function writeFixedAscii(out: Uint8Array, off: number, len: number, name: string): void {
  const n = Math.min(len, name.length)
  for (let i = 0; i < n; i++) {
    const c = name.charCodeAt(i)
    out[off + i] = c >= 32 && c <= 126 ? c : 0x3f // '?'
  }
}

// ---------------------------------------------------------------------------
// MICRO TUNING id maps (monologue note P11 / prologue note P8 — same list)
// ---------------------------------------------------------------------------

/**
 * The hardware's built-in tuning list, index = stored id. Hardware-only
 * entries the replicas don't ship (Ionian/Dorian/Aeolian 8~10 on some
 * models, AFX/DC sets, user slots 128~139) simply never match by name.
 */
export const HW_TUNING_NAMES: readonly string[] = [
  'Equal Temp', 'Pure Major', 'Pure Minor', 'Pythagorean', 'Werckmeister',
  'Kirnburger', 'Slendro', 'Pelog', 'Ionian', 'Dorian', 'Aeolian',
  'Major Penta', 'Minor Penta', 'Reverse',
]

export interface TuningMaps {
  /** Replica MICRO_TUNINGS index -> hardware value. */
  toHw: readonly number[]
  /** Hardware value -> replica index; first replica entry with an id wins. */
  fromHw: ReadonlyMap<number, number>
}

/**
 * Build replica index <-> hardware value maps for a synth's MICRO_TUNINGS
 * subset, matched by name. Names absent from the hardware list encode as
 * Equal Temp (0); unmapped hardware values decode via `fromHw.get(...) ?? 0`.
 */
export function buildTuningMaps(tunings: ReadonlyArray<{ name: string }>): TuningMaps {
  const toHw = tunings.map((t) => {
    const i = HW_TUNING_NAMES.indexOf(t.name)
    return i >= 0 ? i : 0
  })
  const fromHw: ReadonlyMap<number, number> = new Map(
    toHw.map((hw, i) => [hw, i] as [number, number]).reverse(), // first replica entry wins
  )
  return { toHw, fromHw }
}
