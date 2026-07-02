/*
 * Bank persistence: 500 program slots backed by localStorage.
 *
 * Storage layout (all under the 'xd-web-bank-v1' namespace):
 *   'xd-web-bank-v1'         -> marker written once the bank has been seeded
 *   'xd-web-bank-v1/<slot>'  -> one serialized program per slot (O(1) writes)
 *   'xd-web-bank-v1/names'   -> JSON string[] of NUM_SLOTS names (cheap index)
 *
 * loadBank() returns a Proxy-backed Program[] that lazy-loads slots on first
 * access, so startup never deserializes all 500 programs. Corrupt entries
 * fall back to Init Program; missing entries fall back to the factory preset
 * for that slot (if any) and Init Program otherwise.
 */
import type { Program } from '../shared/program'
import { initProgram, cloneProgram, serializeProgram, deserializeProgram } from '../shared/program'

export const NUM_SLOTS = 500

const BANK_KEY = 'xd-web-bank-v1'
const NAMES_KEY = BANK_KEY + '/names'
const INIT_NAME = 'Init Program'

function slotKey(slot: number): string {
  return BANK_KEY + '/' + slot
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

/** Names index cache; refreshed by loadBank() (i.e. on every app startup). */
let namesCache: string[] | null = null

function readNames(): string[] {
  const raw = safeGet(NAMES_KEY)
  if (raw !== null) {
    try {
      const arr: unknown = JSON.parse(raw)
      if (Array.isArray(arr)) {
        const names = new Array<string>(NUM_SLOTS)
        for (let i = 0; i < NUM_SLOTS; i++) {
          const n: unknown = arr[i]
          names[i] = typeof n === 'string' ? n : INIT_NAME
        }
        return names
      }
    } catch {
      /* corrupt index: rebuild below */
    }
  }
  return new Array<string>(NUM_SLOTS).fill(INIT_NAME)
}

function ensureNames(): string[] {
  if (!namesCache) namesCache = readNames()
  return namesCache
}

function readSlot(slot: number, factory: Program[]): Program {
  const raw = safeGet(slotKey(slot))
  if (raw !== null) {
    // Entry exists: use it, or fall back to Init Program if corrupt.
    const p = deserializeProgram(raw)
    return p ?? initProgram()
  }
  // Missing entry: factory preset for the first slots, Init Program elsewhere.
  if (slot < factory.length) return cloneProgram(factory[slot])
  return initProgram()
}

/**
 * Load the 500-slot bank. On first run, seeds factory presets into the first
 * slots (Init Program elsewhere). Returned array lazy-loads each slot on
 * first access; index assignment updates the in-memory cache only (use
 * saveBankSlot for the write-through).
 */
export function loadBank(factory: Program[]): Program[] {
  if (safeGet(BANK_KEY) === null) {
    // First run: seed factory presets + names index.
    const names = new Array<string>(NUM_SLOTS).fill(INIT_NAME)
    for (let i = 0; i < factory.length && i < NUM_SLOTS; i++) {
      safeSet(slotKey(i), serializeProgram(factory[i]))
      names[i] = factory[i].name
    }
    safeSet(NAMES_KEY, JSON.stringify(names))
    safeSet(BANK_KEY, '1')
    namesCache = names
  } else {
    namesCache = readNames()
  }

  const cache = new Map<number, Program>()
  const target: Program[] = new Array<Program>(NUM_SLOTS)

  const indexOf = (prop: string | symbol): number => {
    if (typeof prop !== 'string') return -1
    const i = Number(prop)
    return Number.isInteger(i) && i >= 0 && i < NUM_SLOTS ? i : -1
  }

  return new Proxy(target, {
    get(t, prop, receiver): unknown {
      const i = indexOf(prop)
      if (i >= 0) {
        let p = cache.get(i)
        if (!p) {
          p = readSlot(i, factory)
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
export function saveBankSlot(slot: number, p: Program): boolean {
  if (!Number.isInteger(slot) || slot < 0 || slot >= NUM_SLOTS) return false
  const slotOk = safeSet(slotKey(slot), serializeProgram(p))
  const names = ensureNames()
  names[slot] = p.name
  const namesOk = safeSet(NAMES_KEY, JSON.stringify(names))
  if (safeGet(BANK_KEY) === null) safeSet(BANK_KEY, '1')
  return slotOk && namesOk
}

/** Cheap name lookup from the names index (no program deserialization). */
export function slotName(slot: number): string {
  if (!Number.isInteger(slot) || slot < 0 || slot >= NUM_SLOTS) return INIT_NAME
  return ensureNames()[slot]
}
