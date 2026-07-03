/*
 * Generic math + display-format helpers, shared by UI and DSP. Synth-specific
 * raw->physical curves live in the synth definition (src/synths/<id>/curves.ts).
 */

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Exponential map of raw 0..1023 onto [lo, hi] (both > 0). */
export function expMap(raw: number, lo: number, hi: number): number {
  const t = clamp(raw, 0, 1023) / 1023
  return lo * Math.pow(hi / lo, t)
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

/** Finite v, else def. */
export function fin(v: number, def: number): number {
  return Number.isFinite(v) ? v : def
}

/** Rounded and clamped int, def on junk. */
export function clampInt(v: number, lo: number, hi: number, def: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : def
}

// ---------------------------------------------------------------------------
// Display formatting helpers (OLED-style)
// ---------------------------------------------------------------------------
export function fmtRaw(raw: number): string {
  return String(Math.round(raw))
}
export function fmtSec(s: number): string {
  if (s < 0.01) return (s * 1000).toFixed(1) + 'ms'
  if (s < 1) return Math.round(s * 1000) + 'ms'
  return s.toFixed(2) + 's'
}
export function fmtHz(hz: number): string {
  if (hz < 100) return hz.toFixed(2) + 'Hz'
  if (hz < 1000) return Math.round(hz) + 'Hz'
  return (hz / 1000).toFixed(2) + 'kHz'
}
export function fmtPercent01(v01: number): string {
  return Math.round(v01 * 100) + '%'
}
export function fmtDb(db: number): string {
  return (db > 0 ? '+' : '') + db.toFixed(1) + 'dB'
}
