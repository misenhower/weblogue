/**
 * Pitch/mod joystick — square well, round-capped stick, both axes -1..1.
 * X = pitch bend, Y = mod. On release both axes spring back to 0 over ~120ms,
 * emitting intermediate values each animation frame. setX/setY are silent
 * (used e.g. to reflect incoming MIDI pitch bend).
 */

export interface JoystickOptions {
  onX: (v: number) => void;
  onY: (v: number) => void;
}

const SPRING_MS = 120;
/** Stick center travel, as % of the well (stays inside the well walls). */
const RENDER_PCT = 30;
/** Fraction of the well half-extent at which the axis reaches full deflection. */
const USABLE = 0.78;
const EPS = 1e-4;

function clamp1(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export class Joystick {
  readonly el: HTMLElement;

  private readonly well: HTMLElement;
  private readonly stick: HTMLElement;
  private readonly emitXCb: (v: number) => void;
  private readonly emitYCb: (v: number) => void;

  private x = 0;
  private y = 0;
  private activeId: number | null = null;
  private windowBound = false;

  // Spring-back state
  private springX = false;
  private springY = false;
  private sx0 = 0;
  private sy0 = 0;
  private st0 = 0;
  private rafId: number | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: JoystickOptions) {
    this.emitXCb = opts.onX;
    this.emitYCb = opts.onY;

    this.el = document.createElement('div');
    this.el.className = 'xd-joy';
    this.well = document.createElement('div');
    this.well.className = 'xd-joy-well';
    const cross = document.createElement('div');
    cross.className = 'xd-joy-cross';
    this.stick = document.createElement('div');
    this.stick.className = 'xd-joy-stick';
    this.well.appendChild(cross);
    this.well.appendChild(this.stick);
    this.el.appendChild(this.well);

    this.well.addEventListener('pointerdown', this.handleDown);
    this.well.addEventListener('pointermove', this.handleMove);
    this.well.addEventListener('pointerup', this.handleUp);
    this.well.addEventListener('pointercancel', this.handleUp);

    this.render();
  }

  /** Programmatic, silent (no onX callback). */
  setX(v: number): void {
    this.springX = false;
    this.stopAnimIfIdle();
    this.x = clamp1(v);
    this.render();
  }

  /** Programmatic, silent (no onY callback). */
  setY(v: number): void {
    this.springY = false;
    this.stopAnimIfIdle();
    this.y = clamp1(v);
    this.render();
  }

  // ------------------------------------------------------------------ private

  private pointerId(e: Event): number {
    const id = (e as PointerEvent).pointerId;
    return typeof id === 'number' && Number.isFinite(id) ? id : -1;
  }

  private valueFromEvent(e: PointerEvent): { x: number; y: number } {
    const r = this.well.getBoundingClientRect();
    const hw = r.width / 2;
    const hh = r.height / 2;
    let x = 0;
    let y = 0;
    // Guard division for degenerate (0-size) rects — e.g. detached DOM / happy-dom.
    if (hw > 0) x = (e.clientX - (r.left + hw)) / (hw * USABLE);
    if (hh > 0) y = (r.top + hh - e.clientY) / (hh * USABLE); // up = +1
    return { x: clamp1(x), y: clamp1(y) };
  }

  private applyDrag(e: PointerEvent): void {
    const v = this.valueFromEvent(e);
    this.x = v.x;
    this.y = v.y;
    this.render();
    // Emit unconditionally while dragging — hosts treat these as absolute values.
    this.emitXCb(v.x);
    this.emitYCb(v.y);
  }

  private handleDown = (e: Event): void => {
    if (this.activeId !== null) return;
    this.activeId = this.pointerId(e);
    this.cancelSpring();
    const pe = e as PointerEvent;
    if (typeof this.well.setPointerCapture === 'function' && typeof pe.pointerId === 'number') {
      try {
        this.well.setPointerCapture(pe.pointerId);
      } catch {
        /* unsupported / synthetic event — window listeners cover us */
      }
    }
    this.bindWindow();
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
    this.startSpring();
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

  private startSpring(): void {
    this.springX = Math.abs(this.x) > EPS;
    this.springY = Math.abs(this.y) > EPS;
    if (!this.springX && !this.springY) {
      // Already centered (flush any sub-epsilon residue silently).
      this.x = 0;
      this.y = 0;
      this.render();
      return;
    }
    this.sx0 = this.x;
    this.sy0 = this.y;
    this.st0 = now();
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
    if (!this.springX && !this.springY) return;
    const k = Math.min(1, (now() - this.st0) / SPRING_MS);
    const decay = (1 - k) * (1 - k); // fast ease-out, spring-like settle
    if (this.springX) {
      let nx = k >= 1 ? 0 : this.sx0 * decay;
      if (Math.abs(nx) < EPS) nx = 0; // flush denormal-ish residue
      if (nx !== this.x) {
        this.x = nx;
        this.emitXCb(nx);
      }
      if (nx === 0) this.springX = false;
    }
    if (this.springY) {
      let ny = k >= 1 ? 0 : this.sy0 * decay;
      if (Math.abs(ny) < EPS) ny = 0;
      if (ny !== this.y) {
        this.y = ny;
        this.emitYCb(ny);
      }
      if (ny === 0) this.springY = false;
    }
    this.render();
    if (this.springX || this.springY) this.scheduleFrame();
    else this.clearTimers();
  };

  private finishSpring(): void {
    if (this.springX) {
      this.springX = false;
      this.x = 0;
      this.emitXCb(0);
    }
    if (this.springY) {
      this.springY = false;
      this.y = 0;
      this.emitYCb(0);
    }
    this.render();
    this.clearTimers();
  }

  private cancelSpring(): void {
    this.springX = false;
    this.springY = false;
    this.clearTimers();
  }

  private stopAnimIfIdle(): void {
    if (!this.springX && !this.springY) this.clearTimers();
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
    this.stick.style.left = `calc(50% + ${(this.x * RENDER_PCT).toFixed(3)}%)`;
    this.stick.style.top = `calc(50% - ${(this.y * RENDER_PCT).toFixed(3)}%)`;
  }
}
