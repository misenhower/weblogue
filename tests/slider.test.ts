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

describe('Slider vertical + unipolar (prologue-style wheels)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('vertical variant adds the modifier class and aria bits; height opt sizes the root', () => {
    const s = new Slider({ spring: true, orientation: 'vertical', height: 130, label: 'BEND' });
    document.body.appendChild(s.el);
    expect(s.el.classList.contains('xd-hslider')).toBe(true);
    expect(s.el.classList.contains('xd-hslider--v')).toBe(true);
    expect(s.el.getAttribute('aria-orientation')).toBe('vertical');
    expect(s.el.getAttribute('aria-valuemin')).toBe('-1'); // bipolar pitch wheel
    expect(s.el.style.height).toBe('130px');

    // horizontal default keeps the plain class
    const h = new Slider({ spring: false });
    expect(h.el.classList.contains('xd-hslider--v')).toBe(false);
    expect(h.el.getAttribute('aria-orientation')).toBe('horizontal');
  });

  it('unipolar model: aria-valuemin 0, setValue clamps to 0..1, NaN -> 0', () => {
    const spy = vi.fn();
    const s = new Slider({ spring: false, orientation: 'vertical', unipolar: true, onChange: spy });
    document.body.appendChild(s.el);
    expect(s.el.getAttribute('aria-valuemin')).toBe('0');
    expect(s.el.getAttribute('aria-valuemax')).toBe('1');

    s.setValue(0.6);
    expect(s.getValue()).toBe(0.6);
    s.setValue(-0.5); // below the unipolar floor
    expect(s.getValue()).toBe(0);
    s.setValue(3);
    expect(s.getValue()).toBe(1);
    s.setValue(Number.NaN);
    expect(s.getValue()).toBe(0);
    expect(spy).not.toHaveBeenCalled(); // setValue stays silent
  });

  it('unipolar keyboard: up/down adjust and clamp at 0 and 1; Home resets to 0', () => {
    const spy = vi.fn();
    const s = new Slider({ spring: false, orientation: 'vertical', unipolar: true, onChange: spy });
    document.body.appendChild(s.el);

    s.el.dispatchEvent(kev('ArrowUp'));
    expect(s.getValue()).toBe(0.05);
    expect(spy).toHaveBeenLastCalledWith(0.05);
    s.el.dispatchEvent(kev('ArrowDown'));
    s.el.dispatchEvent(kev('ArrowDown')); // clamps at the unipolar floor
    expect(s.getValue()).toBe(0);
    for (let i = 0; i < 30; i++) s.el.dispatchEvent(kev('ArrowUp'));
    expect(s.getValue()).toBe(1);
    s.el.dispatchEvent(kev('Home'));
    expect(s.getValue()).toBe(0);
  });

  it('unipolar drag emits values clamped to 0..1', () => {
    const spy = vi.fn();
    const s = new Slider({ spring: false, orientation: 'vertical', unipolar: true, onChange: spy });
    document.body.appendChild(s.el);
    const t = track(s);

    t.dispatchEvent(pev('pointerdown', { clientY: 10 }));
    t.dispatchEvent(pev('pointermove', { clientY: -500 }));
    t.dispatchEvent(pev('pointermove', { clientY: 500 }));
    t.dispatchEvent(pev('pointerup'));
    expect(spy).toHaveBeenCalled();
    for (const [v] of spy.mock.calls as [number][]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('mod wheel (unipolar, non-spring) holds its value after release', async () => {
    const spy = vi.fn();
    const s = new Slider({ spring: false, orientation: 'vertical', unipolar: true, onChange: spy });
    document.body.appendChild(s.el);
    const t = track(s);

    t.dispatchEvent(pev('pointerdown', { clientY: 10 }));
    s.setValue(0.75); // silent seam: happy-dom rects are degenerate
    t.dispatchEvent(pev('pointerup'));
    const n = spy.mock.calls.length;

    await new Promise((r) => setTimeout(r, 250));

    expect(s.getValue()).toBe(0.75);
    expect(spy.mock.calls.length).toBe(n); // no spring emissions
  });

  it('pitch wheel (vertical bipolar, spring) returns to 0 after release', async () => {
    const spy = vi.fn();
    const s = new Slider({ spring: true, orientation: 'vertical', onChange: spy });
    document.body.appendChild(s.el);
    const t = track(s);

    t.dispatchEvent(pev('pointerdown', { clientY: 10 }));
    s.setValue(-0.8);
    t.dispatchEvent(pev('pointerup'));

    await new Promise((r) => setTimeout(r, 400));

    expect(s.getValue()).toBe(0);
    expect(spy.mock.calls.at(-1)?.[0]).toBe(0);
  });
});
