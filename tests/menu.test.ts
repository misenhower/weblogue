// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { showMenu, closeMenu, menuOpen } from '../src/ui/menu'

function anchor(): HTMLElement {
  const a = document.createElement('div')
  document.body.appendChild(a)
  return a
}

afterEach(() => {
  closeMenu()
  document.body.innerHTML = ''
})

describe('showMenu', () => {
  it('renders headers, items, and the selected row', () => {
    const m = showMenu(anchor(), [
      { label: 'GROUP' },
      { label: 'One', value: 1 },
      { label: 'Two', value: 2, selected: true },
      { label: 'Act…', value: -1, action: true },
    ], () => {})
    expect(m.querySelectorAll('.xd-menu-header').length).toBe(1)
    expect(m.querySelectorAll('.xd-menu-item').length).toBe(3)
    expect(m.querySelector('.xd-menu-item.is-selected')!.textContent).toBe('Two')
    expect(m.querySelector('.xd-menu-item.is-action')!.textContent).toBe('Act…')
    expect(menuOpen()).toBe(true)
  })

  it('pick fires the callback and closes', () => {
    let picked: number | string | null = null
    const m = showMenu(anchor(), [{ label: 'One', value: 1 }], (v) => (picked = v))
    ;(m.querySelector('.xd-menu-item') as HTMLButtonElement).click()
    expect(picked).toBe(1)
    expect(menuOpen()).toBe(false)
    expect(document.querySelector('.xd-menu')).toBeNull()
  })

  it('Escape closes; opening a second menu closes the first', () => {
    showMenu(anchor(), [{ label: 'A', value: 0 }], () => {})
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(menuOpen()).toBe(false)
    showMenu(anchor(), [{ label: 'A', value: 0 }], () => {})
    showMenu(anchor(), [{ label: 'B', value: 1 }], () => {})
    expect(document.querySelectorAll('.xd-menu').length).toBe(1)
  })

  it('outside pointerdown closes after the arming tick', () => {
    vi.useFakeTimers()
    showMenu(anchor(), [{ label: 'A', value: 0 }], () => {})
    vi.advanceTimersByTime(1)
    window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(menuOpen()).toBe(false)
    vi.useRealTimers()
  })
})
