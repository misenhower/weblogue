// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keyboard, attachComputerKeyboard } from '../src/ui/keyboard';
import { Joystick } from '../src/ui/joystick';
import { pev } from './helpers/dom';

function key(kbd: Keyboard, note: number): HTMLElement {
  const el = kbd.el.querySelector<HTMLElement>(`.xd-key[data-note="${note}"]`);
  if (!el) throw new Error(`no key element for note ${note}`);
  return el;
}

describe('Keyboard', () => {
  let onNoteOn: ReturnType<typeof vi.fn>;
  let onNoteOff: ReturnType<typeof vi.fn>;
  let kbd: Keyboard;

  beforeEach(() => {
    document.body.innerHTML = '';
    onNoteOn = vi.fn();
    onNoteOff = vi.fn();
    kbd = new Keyboard({ onNoteOn, onNoteOff });
    document.body.appendChild(kbd.el);
  });

  it('renders 37 keys (22 white, 15 black) spanning E..E (52..88)', () => {
    expect(kbd.el.querySelectorAll('.xd-key').length).toBe(37);
    expect(kbd.el.querySelectorAll('.xd-key--white').length).toBe(22);
    expect(kbd.el.querySelectorAll('.xd-key--black').length).toBe(15);
    expect(kbd.el.querySelector('.xd-key[data-note="52"]')).toBeTruthy();
    expect(kbd.el.querySelector('.xd-key[data-note="88"]')).toBeTruthy();
    expect(kbd.el.querySelector('.xd-key[data-note="51"]')).toBeNull();
    expect(kbd.el.querySelector('.xd-key[data-note="89"]')).toBeNull();
  });

  it('pointerdown fires onNoteOn with the key note, pointerup fires onNoteOff', () => {
    const k = key(kbd, 52);
    k.dispatchEvent(pev('pointerdown', { clientY: 5 }));
    expect(onNoteOn).toHaveBeenCalledTimes(1);
    const [note, vel] = onNoteOn.mock.calls[0] as [number, number];
    expect(note).toBe(52);
    expect(vel).toBeGreaterThanOrEqual(1);
    expect(vel).toBeLessThanOrEqual(127);
    expect(k.classList.contains('xd-key--down')).toBe(true);

    k.dispatchEvent(pev('pointerup'));
    expect(onNoteOff).toHaveBeenCalledTimes(1);
    expect(onNoteOff).toHaveBeenCalledWith(52);
    expect(k.classList.contains('xd-key--down')).toBe(false);
  });

  it('supports simultaneous pointers (chords) and releaseAll', () => {
    key(kbd, 60).dispatchEvent(pev('pointerdown', { pointerId: 1 }));
    key(kbd, 64).dispatchEvent(pev('pointerdown', { pointerId: 2 }));
    expect(onNoteOn).toHaveBeenCalledTimes(2);
    kbd.releaseAll();
    expect(onNoteOff).toHaveBeenCalledTimes(2);
    const offNotes = onNoteOff.mock.calls.map((c) => c[0]).sort((a, b) => a - b);
    expect(offNotes).toEqual([60, 64]);
  });

  it('setOctaveShift(+1) shifts emitted notes by 12 and clamps to -2..+2', () => {
    kbd.setOctaveShift(1);
    const k = key(kbd, 52);
    k.dispatchEvent(pev('pointerdown'));
    expect(onNoteOn.mock.calls[0][0]).toBe(64);
    k.dispatchEvent(pev('pointerup'));
    expect(onNoteOff).toHaveBeenCalledWith(64);

    kbd.setOctaveShift(9);
    expect(kbd.octaveShift).toBe(2);
    kbd.setOctaveShift(-9);
    expect(kbd.octaveShift).toBe(-2);
  });

  it('notifies onOctaveShift when the shift changes', () => {
    const spy = vi.fn();
    kbd.onOctaveShift = spy;
    kbd.setOctaveShift(2);
    expect(spy).toHaveBeenCalledWith(2);
    kbd.setOctaveShift(2); // no change -> no extra call
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('setLit highlights in-range keys and ignores out-of-range notes', () => {
    kbd.setLit([60, 200, -3]);
    expect(key(kbd, 60).classList.contains('xd-key--lit')).toBe(true);
    kbd.setLit([61]);
    expect(key(kbd, 60).classList.contains('xd-key--lit')).toBe(false);
    expect(key(kbd, 61).classList.contains('xd-key--lit')).toBe(true);
    kbd.setLit([]);
    expect(kbd.el.querySelectorAll('.xd-key--lit').length).toBe(0);
  });
});

describe('attachComputerKeyboard', () => {
  let onNoteOn: ReturnType<typeof vi.fn>;
  let onNoteOff: ReturnType<typeof vi.fn>;
  let kbd: Keyboard;

  beforeEach(() => {
    document.body.innerHTML = '';
    onNoteOn = vi.fn();
    onNoteOff = vi.fn();
    kbd = new Keyboard({ onNoteOn, onNoteOff });
    document.body.appendChild(kbd.el);
  });

  it("keydown 'a' fires noteOn C one octave above lowest C (72) at velocity 100; keyup releases", () => {
    const detach = attachComputerKeyboard(kbd);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(onNoteOn).toHaveBeenCalledTimes(1);
    expect(onNoteOn).toHaveBeenCalledWith(72, 100);

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a' }));
    expect(onNoteOff).toHaveBeenCalledTimes(1);
    expect(onNoteOff).toHaveBeenCalledWith(72);
    detach();
  });

  it('ignores key repeat', () => {
    const detach = attachComputerKeyboard(kbd);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', repeat: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })); // still held
    expect(onNoteOn).toHaveBeenCalledTimes(1);
    detach();
  });

  it('z/x shift the octave and affect emitted notes', () => {
    const detach = attachComputerKeyboard(kbd);
    const octSpy = vi.fn();
    kbd.onOctaveShift = octSpy;

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }));
    expect(kbd.octaveShift).toBe(1);
    expect(octSpy).toHaveBeenCalledWith(1);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(onNoteOn).toHaveBeenCalledWith(84, 100);
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a' }));
    expect(onNoteOff).toHaveBeenCalledWith(84);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z' })); // clamps at -2
    expect(kbd.octaveShift).toBe(-2);
    detach();
  });

  it('detach removes listeners and releases held notes', () => {
    const detach = attachComputerKeyboard(kbd);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h' })); // A -> 72 + 9 = 81
    expect(onNoteOn).toHaveBeenCalledWith(81, 100);
    detach();
    expect(onNoteOff).toHaveBeenCalledWith(81); // held note released on detach
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a' }));
    expect(onNoteOn).toHaveBeenCalledTimes(1);
    expect(onNoteOff).toHaveBeenCalledTimes(1);
  });

  it('ignores key events while a text control is focused', () => {
    const detach = attachComputerKeyboard(kbd);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(onNoteOn).not.toHaveBeenCalled();
    input.blur();
    detach();
  });
});

describe('Joystick', () => {
  let onX: ReturnType<typeof vi.fn>;
  let onY: ReturnType<typeof vi.fn>;
  let joy: Joystick;
  let well: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    onX = vi.fn();
    onY = vi.fn();
    joy = new Joystick({ onX, onY });
    document.body.appendChild(joy.el);
    const w = joy.el.querySelector<HTMLElement>('.xd-joy-well');
    if (!w) throw new Error('no well element');
    well = w;
  });

  it('renders a well with cross-hair and stick', () => {
    expect(joy.el.querySelector('.xd-joy-cross')).toBeTruthy();
    expect(joy.el.querySelector('.xd-joy-stick')).toBeTruthy();
  });

  it('pointer drag emits onX/onY values within -1..1', () => {
    well.dispatchEvent(pev('pointerdown', { clientX: 30, clientY: 80 }));
    well.dispatchEvent(pev('pointermove', { clientX: 500, clientY: -500 }));
    well.dispatchEvent(pev('pointermove', { clientX: -500, clientY: 500 }));

    expect(onX).toHaveBeenCalled();
    expect(onY).toHaveBeenCalled();
    for (const [v] of onX.mock.calls as [number][]) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
      expect(Number.isFinite(v)).toBe(true);
    }
    for (const [v] of onY.mock.calls as [number][]) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
      expect(Number.isFinite(v)).toBe(true);
    }
    well.dispatchEvent(pev('pointerup'));
  });

  it('setX/setY are silent and clamp/sanitize', () => {
    joy.setX(0.5);
    joy.setY(-3);
    joy.setX(Number.NaN);
    expect(onX).not.toHaveBeenCalled();
    expect(onY).not.toHaveBeenCalled();
  });

  it('springs both axes back to 0 after release, emitting intermediate values', async () => {
    well.dispatchEvent(pev('pointerdown', { clientX: 10, clientY: 10 }));
    // Degenerate happy-dom rects compute 0 from geometry, so set a deflection
    // programmatically before release to exercise the spring.
    joy.setX(0.8);
    joy.setY(-0.6);
    well.dispatchEvent(pev('pointerup'));

    await new Promise((r) => setTimeout(r, 400));

    const lastX = onX.mock.calls.at(-1)?.[0];
    const lastY = onY.mock.calls.at(-1)?.[0];
    expect(lastX).toBe(0);
    expect(lastY).toBe(0);
    for (const [v] of onX.mock.calls as [number][]) {
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
    }
  });
});
