/**
 * Pitch/mod slider — the original minilogue's horizontal bender (left of the
 * keybed where the xd has its joystick) and, rotated vertical, the prologue's
 * pitch-bend + mod wheels. Value is -1..1, 0 = center (or 0..1 with
 * `unipolar`, 0 = released/bottom).
 *
 * Two modes, chosen at construction:
 *   { spring: true }  pitch-bend style — on release the cap springs back to 0
 *                     over ~120ms, emitting intermediate values each frame
 *                     (same return pattern as joystick.ts)
 *   { spring: false } assignable-mod style — the cap stays where you leave it
 *
 * Orientation: 'horizontal' (default; right = +) or 'vertical' (up = +,
 * unipolar bottom = 0). Unipolar models a mod wheel: value 0..1.
 *
 * Interaction: pointer-capture drag, wheel, keyboard (arrows adjust, Home
 * resets) and double-click to reset (0 in both models). setValue() is a
 * silent resync (no onChange) — e.g. to reflect incoming MIDI pitch bend.
 *
 * Framework-free DOM/CSS; styles live in src/ui/panel.css (`.xd-hslider`,
 * vertical variant `.xd-hslider--v`).
 */

export interface SliderOptions {
  /** true = pitch-bend (spring-return to 0); false = mod (holds position). */
  spring: boolean;
  /** Track direction (default 'horizontal'); 'vertical' reads up = +. */
  orientation?: 'horizontal' | 'vertical';
  /** 0..1 value model (mod wheel: bottom = 0); default bipolar -1..1. */
  unipolar?: boolean;
  /** Overall width in logical px (default 180 via CSS). */
  width?: number;
  /** Overall height in logical px (vertical variant; default 130 via CSS). */
  height?: number;
  /** Etched label under the track (e.g. 'PITCH' / 'MOD'). */
  label?: string;
  onChange?: (v: number) => void;
}

const SPRING_MS = 120;
/** Cap center travel from track center, as % of track width (stays inside). */
const RENDER_PCT = 42;
/** Fraction of the track half-extent at which the value reaches full deflection. */
const USABLE = 0.84;
const EPS = 1e-4;
const KEY_STEP = 0.05;
const WHEEL_STEP = 0.05;
const WHEEL_STEP_FINE = 0.01;

function clamp1(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export class Slider {
  readonly el: HTMLElement;

  private readonly track: HTMLElement;
  private readonly cap: HTMLElement;
  private readonly spring: boolean;
  private readonly vertical: boolean;
  private readonly unipolar: boolean;
  private readonly onChange: ((v: number) => void) | undefined;

  private value = 0;
  private activeId: number | null = null;
  private windowBound = false;

  // Spring-back state (spring mode only)
  private springing = false;
  private s0 = 0;
  private t0 = 0;
  private rafId: number | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: SliderOptions) {
    this.spring = opts.spring;
    this.vertical = opts.orientation === 'vertical';
    this.unipolar = opts.unipolar === true;
    this.onChange = opts.onChange;

    this.el = document.createElement('div');
    this.el.className = this.vertical ? 'xd-hslider xd-hslider--v' : 'xd-hslider';
    this.el.tabIndex = 0;
    this.el.setAttribute('role', 'slider');
    this.el.setAttribute('aria-label', opts.label ?? 'Bend');
    this.el.setAttribute('aria-orientation', this.vertical ? 'vertical' : 'horizontal');
    this.el.setAttribute('aria-valuemin', this.unipolar ? '0' : '-1');
    this.el.setAttribute('aria-valuemax', '1');
    if (opts.width !== undefined && Number.isFinite(opts.width) && opts.width > 0) {
      this.el.style.width = `${opts.width}px`;
    }
    if (opts.height !== undefined && Number.isFinite(opts.height) && opts.height > 0) {
      this.el.style.height = `${opts.height}px`;
    }

    this.track = document.createElement('div');
    this.track.className = 'xd-hslider-track';
    this.cap = document.createElement('div');
    this.cap.className = 'xd-hslider-cap';
    this.track.appendChild(this.cap);
    this.el.appendChild(this.track);

    if (opts.label !== undefined && opts.label !== '') {
      const label = document.createElement('div');
      label.className = 'xd-legend xd-hslider-label';
      label.textContent = opts.label;
      this.el.appendChild(label);
    }

    this.track.addEventListener('pointerdown', this.handleDown);
    this.track.addEventListener('pointermove', this.handleMove);
    this.track.addEventListener('pointerup', this.handleUp);
    this.track.addEventListener('pointercancel', this.handleUp);
    this.el.addEventListener('wheel', this.handleWheel, { passive: false });
    this.el.addEventListener('dblclick', this.handleDblClick);
    this.el.addEventListener('keydown', this.handleKeyDown);

    this.render();
  }

  getValue(): number {
    return this.value;
  }

  /** Programmatic, silent resync (no onChange). Clamps to the value model
   *  (-1..1, or 0..1 when unipolar); NaN -> 0. */
  setValue(v: number): void {
    this.cancelSpring();
    this.value = this.clampV(v);
    this.render();
  }

  // ------------------------------------------------------------------ private

  /** Model clamp: -1..1 bipolar, 0..1 unipolar; NaN -> 0. */
  private clampV(v: number): number {
    const c = clamp1(v);
    return this.unipolar && c < 0 ? 0 : c;
  }

  private emit(v: number): void {
    this.onChange?.(v);
  }

  /** Wheel / keyboard / dblclick path: fire onChange only when it changed. */
  private apply(v: number): void {
    // kill float noise from repeated 0.05 steps (e.g. 0.15000000000000002)
    const c = Math.round(this.clampV(v) * 1e9) / 1e9;
    if (c === this.value) return;
    this.value = c;
    this.render();
    this.emit(c);
  }

  private pointerId(e: Event): number {
    const id = (e as PointerEvent).pointerId;
    return typeof id === 'number' && Number.isFinite(id) ? id : -1;
  }

  private valueFromEvent(e: PointerEvent): number {
    const r = this.track.getBoundingClientRect();
    let d = 0;
    // Guard division for degenerate (0-size) rects — detached DOM / happy-dom.
    if (this.vertical) {
      const hh = r.height / 2;
      if (hh > 0) d = -(e.clientY - (r.top + hh)) / (hh * USABLE); // up = +
    } else {
      const hw = r.width / 2;
      if (hw > 0) d = (e.clientX - (r.left + hw)) / (hw * USABLE);
    }
    // Unipolar: full down-travel = 0, full up-travel = 1.
    return this.clampV(this.unipolar ? (clamp1(d) + 1) / 2 : d);
  }

  private applyDrag(e: PointerEvent): void {
    const v = this.valueFromEvent(e);
    this.value = v;
    this.render();
    // Emit unconditionally while dragging — hosts treat these as absolute values.
    this.emit(v);
  }

  private handleDown = (e: Event): void => {
    if (this.activeId !== null) return;
    this.activeId = this.pointerId(e);
    this.cancelSpring();
    const pe = e as PointerEvent;
    if (typeof this.track.setPointerCapture === 'function' && typeof pe.pointerId === 'number') {
      try {
        this.track.setPointerCapture(pe.pointerId);
      } catch {
        /* unsupported / synthetic event — window listeners cover us */
      }
    }
    this.bindWindow();
    this.el.classList.add('is-dragging');
    this.el.focus?.();
    this.applyDrag(pe);
    if (e.cancelable) e.preventDefault();
  };

  private handleMove = (e: Event): void => {
    if (this.activeId === null || this.pointerId(e) !== this.activeId) return;
    this.applyDrag(e as PointerEvent);
  };

  private handleUp = (e: Event): void => {
    if (this.activeId === null || this.pointerId(e) !== this.activeId) return;
    this.activeId = null;
    this.unbindWindow();
    this.el.classList.remove('is-dragging');
    if (this.spring) this.startSpring();
  };

  private bindWindow(): void {
    if (this.windowBound || typeof window === 'undefined') return;
    this.windowBound = true;
    window.addEventListener('pointermove', this.handleMove);
    window.addEventListener('pointerup', this.handleUp);
    window.addEventListener('pointercancel', this.handleUp);
  }

  private unbindWindow(): void {
    if (!this.windowBound || typeof window === 'undefined') return;
    this.windowBound = false;
    window.removeEventListener('pointermove', this.handleMove);
    window.removeEventListener('pointerup', this.handleUp);
    window.removeEventListener('pointercancel', this.handleUp);
  }

  private handleWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : e.deltaY > 0 ? -1 : 0;
    if (dir === 0) return;
    this.cancelSpring();
    this.apply(this.value + dir * (e.shiftKey ? WHEEL_STEP_FINE : WHEEL_STEP));
  };

  private handleDblClick = (e: MouseEvent): void => {
    e.preventDefault();
    this.cancelSpring();
    this.apply(0);
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    let d = 0;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        d = 1;
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        d = -1;
        break;
      case 'Home':
        e.preventDefault();
        this.cancelSpring();
        this.apply(0);
        return;
      default:
        return;
    }
    e.preventDefault();
    this.cancelSpring();
    this.apply(this.value + d * KEY_STEP);
  };

  // ------------------------------------------------- spring return (like joystick)

  private startSpring(): void {
    if (Math.abs(this.value) <= EPS) {
      // Already centered (flush any sub-epsilon residue silently).
      this.value = 0;
      this.render();
      return;
    }
    this.springing = true;
    this.s0 = this.value;
    this.t0 = now();
    if (typeof requestAnimationFrame !== 'function') {
      this.finishSpring();
      return;
    }
    this.scheduleFrame();
    // Safety net: rAF can stall (hidden tab, test env) — never leave bend stuck.
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      this.finishSpring();
    }, SPRING_MS + 60);
  }

  private scheduleFrame(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(this.springStep);
  }

  private springStep = (): void => {
    this.rafId = null;
    if (!this.springing) return;
    const k = Math.min(1, (now() - this.t0) / SPRING_MS);
    const decay = (1 - k) * (1 - k); // fast ease-out, spring-like settle
    let nv = k >= 1 ? 0 : this.s0 * decay;
    if (Math.abs(nv) < EPS) nv = 0; // flush denormal-ish residue
    if (nv !== this.value) {
      this.value = nv;
      this.emit(nv);
    }
    this.render();
    if (nv === 0) {
      this.springing = false;
      this.clearTimers();
    } else {
      this.scheduleFrame();
    }
  };

  private finishSpring(): void {
    if (this.springing) {
      this.springing = false;
      this.value = 0;
      this.emit(0);
      this.render();
    }
    this.clearTimers();
  }

  private cancelSpring(): void {
    this.springing = false;
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.rafId !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.fallbackTimer !== null) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  private render(): void {
    // Cap deflection is always -1..1: unipolar maps 0..1 across the travel.
    const d = this.unipolar ? this.value * 2 - 1 : this.value;
    if (this.vertical) {
      this.cap.style.top = `calc(50% - ${(d * RENDER_PCT).toFixed(3)}%)`; // up = +
    } else {
      this.cap.style.left = `calc(50% + ${(d * RENDER_PCT).toFixed(3)}%)`;
    }
    this.el.setAttribute('aria-valuenow', String(Math.round(this.value * 1000) / 1000));
  }
}
