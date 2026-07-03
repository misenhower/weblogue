/*
 * Shared DOM test scaffolding (happy-dom): Map-backed localStorage mock with
 * install/restore, and pointer-ish event construction.
 */

/** Map-backed localStorage stand-in. */
export class LocalStorageMock {
  private map = new Map<string, string>()
  /** Every key passed to getItem, in order (for lazy-load assertions). */
  gets: string[] = []
  getItem(key: string): string | null {
    this.gets.push(key)
    const v = this.map.get(key)
    return v === undefined ? null : v
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
  get length(): number {
    return this.map.size
  }
  key(i: number): string | null {
    return Array.from(this.map.keys())[i] ?? null
  }
}

/**
 * Replace globalThis.localStorage with a fresh mock (call in beforeEach);
 * returns the mock plus a restore fn for afterEach.
 */
export function installLocalStorageMock(): { mock: LocalStorageMock; restore: () => void } {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage')
  const orig = had ? (globalThis as { localStorage?: unknown }).localStorage : undefined
  const mock = new LocalStorageMock()
  Object.defineProperty(globalThis, 'localStorage', {
    value: mock,
    configurable: true,
    writable: true,
  })
  const restore = (): void => {
    if (had) {
      Object.defineProperty(globalThis, 'localStorage', {
        value: orig,
        configurable: true,
        writable: true,
      })
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage
    }
  }
  return { mock, restore }
}

/** Build a pointer-ish event that works in happy-dom (falls back to MouseEvent). */
export function pev(type: string, init: Record<string, unknown> = {}): Event {
  const full = { bubbles: true, cancelable: true, pointerId: 1, ...init }
  if (typeof PointerEvent === 'function') {
    return new PointerEvent(type, full as PointerEventInit)
  }
  return new MouseEvent(type, full as MouseEventInit)
}
