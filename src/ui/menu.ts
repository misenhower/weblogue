/*
 * Lightweight popover menu for panel readouts (multi engine type, FX type,
 * program browser). One menu at a time; closes on pick, outside click, or
 * Escape. Long lists scroll with the selected row centered.
 */

export interface MenuItem {
  label: string
  /** Absent = non-selectable group header. */
  value?: number | string
  selected?: boolean
  /** Action row styling (e.g. "Rename…"). */
  action?: boolean
}

let openEl: HTMLElement | null = null
let cleanup: (() => void) | null = null

export function closeMenu(): void {
  if (cleanup) cleanup()
}

export function menuOpen(): boolean {
  return openEl !== null
}

export function showMenu(
  anchor: HTMLElement,
  items: MenuItem[],
  onPick: (value: number | string) => void,
): HTMLElement {
  closeMenu()

  const menu = document.createElement('div')
  menu.className = 'xd-menu'
  let selectedRow: HTMLElement | null = null
  for (const item of items) {
    if (item.value === undefined) {
      const h = document.createElement('div')
      h.className = 'xd-menu-header'
      h.textContent = item.label
      menu.appendChild(h)
      continue
    }
    const row = document.createElement('button')
    row.className = 'xd-menu-item' + (item.action ? ' is-action' : '') + (item.selected ? ' is-selected' : '')
    row.textContent = item.label
    const value = item.value
    row.addEventListener('click', (e) => {
      e.stopPropagation()
      closeMenu()
      onPick(value)
    })
    if (item.selected) selectedRow = row
    menu.appendChild(row)
  }
  document.body.appendChild(menu)

  // Position under the anchor, clamped to the viewport; flip above if the
  // space below is too tight.
  const r = anchor.getBoundingClientRect()
  const mw = menu.offsetWidth || 180
  const mh = menu.offsetHeight || 200
  const vw = window.innerWidth || 1440
  const vh = window.innerHeight || 900
  let x = Math.min(Math.max(4, r.left), Math.max(4, vw - mw - 4))
  let y = r.bottom + 4
  if (y + mh > vh - 4 && r.top - mh - 4 > 4) y = r.top - mh - 4
  y = Math.min(Math.max(4, y), Math.max(4, vh - mh - 4))
  menu.style.left = x + 'px'
  menu.style.top = y + 'px'

  if (selectedRow && typeof selectedRow.scrollIntoView === 'function') {
    selectedRow.scrollIntoView({ block: 'center' })
  }

  const onDown = (e: PointerEvent): void => {
    if (e.target instanceof Node && menu.contains(e.target)) return
    closeMenu()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') closeMenu()
  }
  // Defer the outside-click listener so the opening click doesn't close it.
  const arm = setTimeout(() => {
    window.addEventListener('pointerdown', onDown, true)
  }, 0)
  window.addEventListener('keydown', onKey, true)

  openEl = menu
  cleanup = () => {
    clearTimeout(arm)
    window.removeEventListener('pointerdown', onDown, true)
    window.removeEventListener('keydown', onKey, true)
    menu.remove()
    openEl = null
    cleanup = null
  }
  return menu
}
