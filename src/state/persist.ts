/*
 * Bank persistence: program slots backed by localStorage, namespaced per
 * synth definition (def.bankKey).
 *
 * Storage layout (under the def's namespace, e.g. 'xd-web-bank-v1'):
 *   '<bankKey>'         -> marker written once the bank has been seeded
 *   '<bankKey>/<slot>'  -> one serialized program per slot (O(1) writes)
 *   '<bankKey>/names'   -> JSON string[] of numSlots names (cheap index)
 *
 * loadBank() returns a Proxy-backed Program[] that lazy-loads slots on first
 * access, so startup never deserializes the whole bank. Corrupt entries fall
 * back to Init Program; missing entries fall back to the factory preset for
 * that slot (if any) and Init Program otherwise.
 */
import type { Program } from '../shared/program'
import type { StoreDef } from '../synths/def'

export const NUM_SLOTS = 500

/** Sentinel name for empty/unwritten slots (also the init-program name). */
export const INIT_NAME = 'Init Program'

function slotKey(def: StoreDef, slot: number): string {
  return def.bankKey + '/' + slot
}

function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null
  } catch {
    return null
  }
}

function safeGet(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null
  } catch {
    return null
  }
}

/** Returns false when the write did not persist (quota / storage unavailable). */
function safeSet(key: string, value: string): boolean {
  try {
    const s = storage()
    if (!s) return false
    s.setItem(key, value)
    return true
  } catch {
    /* quota exceeded / storage unavailable: keep running in-memory */
    return false
  }
}

/** Names index caches per bank namespace; refreshed by loadBank(). */
const namesCaches = new Map<string, string[]>()

function readNames(def: StoreDef): string[] {
  const raw = safeGet(def.bankKey + '/names')
  if (raw !== null) {
    try {
      const arr: unknown = JSON.parse(raw)
      if (Array.isArray(arr)) {
        const names = new Array<string>(def.numSlots)
        for (let i = 0; i < def.numSlots; i++) {
          const n: unknown = arr[i]
          names[i] = typeof n === 'string' ? n : INIT_NAME
        }
        return names
      }
    } catch {
      /* corrupt index: rebuild below */
    }
  }
  return new Array<string>(def.numSlots).fill(INIT_NAME)
}

function ensureNames(def: StoreDef): string[] {
  let names = namesCaches.get(def.bankKey)
  if (!names) {
    names = readNames(def)
    namesCaches.set(def.bankKey, names)
  }
  return names
}

function readSlot(def: StoreDef, slot: number): Program {
  const raw = safeGet(slotKey(def, slot))
  if (raw !== null) {
    // Entry exists: use it, or fall back to Init Program if corrupt.
    const p = def.deserializeProgram(raw)
    return p ?? def.initProgram()
  }
  // Missing entry: factory preset for the first slots, Init Program elsewhere.
  const factory = def.factoryPresets
  if (slot < factory.length) return def.cloneProgram(factory[slot])
  return def.initProgram()
}

/**
 * Load a def's bank. On first run, seeds factory presets into the first
 * slots (Init Program elsewhere). Returned array lazy-loads each slot on
 * first access; index assignment updates the in-memory cache only (use
 * saveBankSlot for the write-through).
 */
export function loadBank(def: StoreDef): Program[] {
  const n = def.numSlots
  if (safeGet(def.bankKey) === null) {
    // First run: seed factory presets + names index.
    const factory = def.factoryPresets
    const names = new Array<string>(n).fill(INIT_NAME)
    for (let i = 0; i < factory.length && i < n; i++) {
      safeSet(slotKey(def, i), def.serializeProgram(factory[i]))
      names[i] = factory[i].name
    }
    safeSet(def.bankKey + '/names', JSON.stringify(names))
    safeSet(def.bankKey, '1')
    namesCaches.set(def.bankKey, names)
  } else {
    namesCaches.set(def.bankKey, readNames(def))
  }

  const cache = new Map<number, Program>()
  const target: Program[] = new Array<Program>(n)

  const indexOf = (prop: string | symbol): number => {
    if (typeof prop !== 'string') return -1
    const i = Number(prop)
    return Number.isInteger(i) && i >= 0 && i < n ? i : -1
  }

  return new Proxy(target, {
    get(t, prop, receiver): unknown {
      const i = indexOf(prop)
      if (i >= 0) {
        let p = cache.get(i)
        if (!p) {
          p = readSlot(def, i)
          cache.set(i, p)
        }
        return p
      }
      return Reflect.get(t, prop, receiver)
    },
    set(t, prop, value, receiver): boolean {
      const i = indexOf(prop)
      if (i >= 0) {
        cache.set(i, value as Program)
        return true
      }
      return Reflect.set(t, prop, value, receiver)
    },
    has(t, prop): boolean {
      return indexOf(prop) >= 0 || Reflect.has(t, prop)
    },
  })
}

/**
 * Write-through save of a single slot; O(1) in the number of slots.
 * Returns false when the write did not persist (e.g. QuotaExceededError);
 * the in-memory names index is still updated (the program is live).
 */
export function saveBankSlot(def: StoreDef, slot: number, p: Program): boolean {
  if (!Number.isInteger(slot) || slot < 0 || slot >= def.numSlots) return false
  const slotOk = safeSet(slotKey(def, slot), def.serializeProgram(p))
  const names = ensureNames(def)
  names[slot] = p.name
  const namesOk = safeSet(def.bankKey + '/names', JSON.stringify(names))
  if (safeGet(def.bankKey) === null) safeSet(def.bankKey, '1')
  return slotOk && namesOk
}

/**
 * Batch write of consecutive slots starting at startSlot (clipped to the end
 * of the bank). Each slot entry is written individually, but the names index
 * (and the bank marker) is written once at the end — saveBankSlot rewrites
 * the whole index per call, which hurts on multi-hundred-program imports.
 * Returns false when any write did not persist; the in-memory names cache is
 * still updated (the programs are live).
 */
export function saveBankSlots(def: StoreDef, startSlot: number, programs: readonly Program[]): boolean {
  if (!Number.isInteger(startSlot) || startSlot < 0 || startSlot >= def.numSlots) return false
  if (programs.length === 0) return true
  const names = ensureNames(def)
  let ok = true
  for (let i = 0; i < programs.length; i++) {
    const slot = startSlot + i
    if (slot >= def.numSlots) break
    if (!safeSet(slotKey(def, slot), def.serializeProgram(programs[i]))) ok = false
    names[slot] = programs[i].name
  }
  if (!safeSet(def.bankKey + '/names', JSON.stringify(names))) ok = false
  if (safeGet(def.bankKey) === null) safeSet(def.bankKey, '1')
  return ok
}

/** True iff the slot has a stored entry (factory-seeded or user-written) —
 *  mirrors readSlot's branch. Content-based "is this slot non-empty" check. */
export function hasBankSlot(def: StoreDef, slot: number): boolean {
  if (!Number.isInteger(slot) || slot < 0 || slot >= def.numSlots) return false
  return safeGet(slotKey(def, slot)) !== null
}

/** Cheap name lookup from the names index (no program deserialization). */
export function slotName(def: StoreDef, slot: number): string {
  if (!Number.isInteger(slot) || slot < 0 || slot >= def.numSlots) return INIT_NAME
  return ensureNames(def)[slot]
}
