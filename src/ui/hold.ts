/*
 * Press-and-hold with acceleration, shared by the OLED soft buttons and the
 * settings drawer steppers: fire on press, then repeat after 250ms every
 * 60ms. A plain synthetic .click() (tests, keyboard) fires once; a real
 * pointer press is not double-counted by its trailing click.
 */

const HOLD_DELAY_MS = 250
const HOLD_REPEAT_MS = 60

export function bindHold(btn: HTMLButtonElement, fn: () => void): void {
  let delay: ReturnType<typeof setTimeout> | null = null
  let repeat: ReturnType<typeof setInterval> | null = null
  let sawPointer = false
  /** The pointer that started the hold; other pointers must not stop it. */
  let activeId: number | null = null
  const stop = (): void => {
    if (delay) clearTimeout(delay)
    if (repeat) clearInterval(repeat)
    delay = null
    repeat = null
  }
  // An aborted press (released off-button or cancelled) produces no
  // trailing click; sawPointer must reset or it would swallow the next
  // keyboard/synthetic click. A release on the button keeps sawPointer so
  // its trailing click is still ignored.
  const windowRelease = (e: PointerEvent): void => {
    if (e.pointerId !== activeId) return
    window.removeEventListener('pointerup', windowRelease)
    window.removeEventListener('pointercancel', windowRelease)
    activeId = null
    stop()
    const onBtn = e.target instanceof Node && btn.contains(e.target)
    if (e.type === 'pointercancel' || !onBtn) sawPointer = false
  }
  btn.addEventListener('pointerdown', (e) => {
    // Secondary buttons must not edit or arm the repeat (undefined = synthetic
    // test events, same convention as components.ts).
    if (e.button !== undefined && e.button !== 0) return
    sawPointer = true
    activeId = e.pointerId
    fn()
    stop()
    window.addEventListener('pointerup', windowRelease)
    window.addEventListener('pointercancel', windowRelease)
    delay = setTimeout(() => {
      repeat = setInterval(fn, HOLD_REPEAT_MS)
    }, HOLD_DELAY_MS)
  })
  const stopIfActive = (e: PointerEvent): void => {
    if (e.pointerId === activeId) stop()
  }
  btn.addEventListener('pointerup', stopIfActive)
  btn.addEventListener('pointercancel', stopIfActive)
  btn.addEventListener('pointerleave', stopIfActive)
  btn.addEventListener('click', () => {
    if (sawPointer) {
      sawPointer = false
      return
    }
    fn()
  })
}
