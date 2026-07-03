// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Slider } from '../src/ui/slider';
import { pev } from './helpers/dom';

function kev(key: string): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
}

function track(s: Slider): HTMLElement {
  const t = s.el.querySelector<HTMLElement>('.xd-hslider-track');
  if (!t) throw new Error('no track element');
  return t;
}

describe('Slider', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('builds track, cap and etched label; width opt sizes the root', () => {
    const s = new Slider({ spring: false, label: 'BEND', width: 220 });
    document.body.appendChild(s.el);
    expect(s.el.classList.contains('xd-hslider')).toBe(true);
    expect(s.el.getAttribute('role')).toBe('slider');
    expect(s.el.getAttribute('aria-orientation')).toBe('horizontal');
    expect(s.el.getAttribute('aria-valuemin')).toBe('-1');
    expect(s.el.getAttribute('aria-valuemax')).toBe('1');
    expect(s.el.querySelector('.xd-hslider-track')).toBeTruthy();
    expect(s.el.querySelector('.xd-hslider-cap')).toBeTruthy();
    expect(s.el.querySelector('.xd-hslider-label')?.textContent).toBe('BEND');
    expect(s.el.style.width).toBe('220px');

    // no label opt -> no label element
    const bare = new Slider({ spring: true });
    expect(bare.el.querySelector('.xd-hslider-label')).toBeNull();
  });

  it('setValue is silent, clamps to -1..1 and sanitizes NaN', () => {
    const spy = vi.fn();
    const s = new Slider({ spring: false, onChange: spy });
    document.body.appendChild(s.el);

    s.setValue(5);
    expect(s.getValue()).toBe(1);
    s.setValue(-3);
    expect(s.getValue()).toBe(-1);
    s.setValue(0.25);
    expect(s.getValue()).toBe(0.25);
    s.setValue(Number.NaN);
    expect(s.getValue()).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('pointer drag fires onChange with values clamped to -1..1', () => {
    const spy = vi.fn();
    const s = new Slider({ spring: false, onChange: spy });
    document.body.appendChild(s.el);
    const t = track(s);

    t.dispatchEvent(pev('pointerdown', { clientX: 10 }));
    t.dispatchEvent(pev('pointermove', { clientX: 500 }));
    t.dispatchEvent(pev('pointermove', { clientX: -500 }));
    expect(spy).toHaveBeenCalled();
    for (const [v] of spy.mock.calls as [number][]) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
      expect(Number.isFinite(v)).toBe(true);
    }

    // after pointerup further moves are ignored
    t.dispatchEvent(pev('pointerup'));
    const n = spy.mock.calls.length;
    t.dispatchEvent(pev('pointermove', { clientX: 100 }));
    expect(spy.mock.calls.length).toBe(n);
  });

  it('spring mode returns to 0 after release, emitting intermediate values', async () => {
    const spy = vi.fn();
    const s = new Slider({ spring: true, onChange: spy });
    document.body.appendChild(s.el);
    const t = track(s);

    t.dispatchEvent(pev('pointerdown', { clientX: 10 }));
    // happy-dom rects are degenerate (0-size) so drag geometry computes 0 —
    // set the deflection programmatically before release, exactly like the
    // Joystick spring test does (silent setValue is the test seam).
    s.setValue(0.8);
    t.dispatchEvent(pev('pointerup'));

    // rAF path or the SPRING_MS+60 fallback timer — both settle well within 400ms
    await new Promise((r) => setTimeout(r, 400));

    expect(s.getValue()).toBe(0);
    expect(spy.mock.calls.at(-1)?.[0]).toBe(0);
    for (const [v] of spy.mock.calls as [number][]) {
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
    }
  });

  it('non-spring mode holds its value after release', async () => {
    const spy = vi.fn();
    const s = new Slider({ spring: false, onChange: spy });
    document.body.appendChild(s.el);
    const t = track(s);

    t.dispatchEvent(pev('pointerdown', { clientX: 10 }));
    s.setValue(0.5);
    t.dispatchEvent(pev('pointerup'));
    const n = spy.mock.calls.length;

    await new Promise((r) => setTimeout(r, 250));

    expect(s.getValue()).toBe(0.5);
    expect(spy.mock.calls.length).toBe(n); // no spring emissions
  });

  it('arrow keys adjust the value and clamp; Home centers', () => {
    const spy = vi.fn();
    const s = new Slider({ spring: false, onChange: spy });
    document.body.appendChild(s.el);

    s.el.dispatchEvent(kev('ArrowRight'));
    expect(s.getValue()).toBe(0.05);
    expect(spy).toHaveBeenLastCalledWith(0.05);

    s.el.dispatchEvent(kev('ArrowUp'));
    expect(s.getValue()).toBe(0.1);

    s.el.dispatchEvent(kev('ArrowLeft'));
    s.el.dispatchEvent(kev('ArrowLeft'));
    s.el.dispatchEvent(kev('ArrowDown'));
    expect(s.getValue()).toBe(-0.05);

    // clamps at the ends
    for (let i = 0; i < 30; i++) s.el.dispatchEvent(kev('ArrowRight'));
    expect(s.getValue()).toBe(1);
    for (let i = 0; i < 60; i++) s.el.dispatchEvent(kev('ArrowLeft'));
    expect(s.getValue()).toBe(-1);

    s.el.dispatchEvent(kev('Home'));
    expect(s.getValue()).toBe(0);
    expect(spy).toHaveBeenLastCalledWith(0);
  });

  it('double-click centers and fires onChange', () => {
    const spy = vi.fn();
    const s = new Slider({ spring: false, onChange: spy });
    document.body.appendChild(s.el);

    s.setValue(0.7);
    s.el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(s.getValue()).toBe(0);
    expect(spy).toHaveBeenCalledWith(0);
  });

  it('wheel adjusts the value in both directions', () => {
    // (happy-dom's WheelEvent constructor drops shiftKey, so the fine step
    // is not exercised here — same limitation as the Knob wheel test.)
    const spy = vi.fn();
    const s = new Slider({ spring: true, onChange: spy });
    document.body.appendChild(s.el);

    s.el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    expect(s.getValue()).toBe(0.05);
    expect(spy).toHaveBeenLastCalledWith(0.05);
    s.el.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
    expect(s.getValue()).toBe(0);
    expect(spy).toHaveBeenLastCalledWith(0);
  });
});
