/**
 * Slim on-screen keyboard — framework-free. Defaults to the minilogue xd's
 * 37 keys (E..E, base MIDI 52..88); lowestNote/highestNote override the
 * range for other 'logue keybeds (e.g. the monologue's 25-key E..E).
 *
 * `setOctaveShift` transposes emitted notes by +/-12 per step (-2..+2).
 * Mouse/touch presses derive velocity from the vertical position within the
 * key (top ~45, bottom ~127), dragging across keys glides, and multi-touch
 * plays chords.
 */

export interface KeyboardOptions {
  onNoteOn: (note: number, velocity: number) => void;
  onNoteOff: (note: number) => void;
  /** Base (unshifted) MIDI range; defaults to the xd's 52..88 (37 keys). */
  lowestNote?: number;
  highestNote?: number;
}

const LOWEST_NOTE = 52; // E3
const HIGHEST_NOTE = 88; // E6
const WHITE_W = 26; // px, slim minilogue-style keys
const BLACK_W = 15; // px
const MIN_SHIFT = -2;
const MAX_SHIFT = 2;
const VEL_TOP = 45;
const VEL_BOTTOM = 127;
const DEFAULT_VELOCITY = 100;

const BLACK_PCS = new Set([1, 3, 6, 8, 10]);
/** Horizontal nudge (px) so black keys cluster like a real keybed. */
const BLACK_NUDGE: Record<number, number> = { 1: -2.5, 3: 2.5, 6: -3, 8: 0, 10: 3 };

interface ActivePointer {
  /** Base (unshifted) note currently sounding for this pointer, -1 if dragged off the keys. */
  base: number;
  /** Emitted (post-shift) note, so note-off stays consistent if the shift changes mid-hold. */
  emitted: number;
}

function clampInt(v: number, lo: number, hi: number): number {
  const n = Math.round(v);
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

export class Keyboard {
  readonly el: HTMLElement;
  /** Hook for the app to reflect octave shift changes (e.g. LED display). */
  onOctaveShift?: (o: number) => void;

  private readonly noteOnCb: (note: number, velocity: number) => void;
  private readonly noteOffCb: (note: number) => void;
  private readonly lowest: number;
  private readonly highest: number;
  private readonly keysEl: HTMLElement;
  private readonly keyEls = new Map<number, HTMLElement>();
  private shift = 0;
  private readonly pointers = new Map<number, ActivePointer>();
  /** base note -> emitted note, for programmatic (computer-keyboard) presses. */
  private readonly programmatic = new Map<number, number>();
  /** base note -> press refcount (pointer + programmatic) for the visual down state. */
  private readonly downCounts = new Map<number, number>();
  private litEls: HTMLElement[] = [];
  private windowBound = false;

  constructor(opts: KeyboardOptions) {
    this.noteOnCb = opts.onNoteOn;
    this.noteOffCb = opts.onNoteOff;
    this.lowest = clampInt(opts.lowestNote ?? LOWEST_NOTE, 0, 127);
    this.highest = clampInt(opts.highestNote ?? HIGHEST_NOTE, this.lowest, 127);

    this.el = document.createElement('div');
    this.el.className = 'xd-kbd';
    this.keysEl = document.createElement('div');
    this.keysEl.className = 'xd-kbd-keys';
    this.el.appendChild(this.keysEl);

    const whites: HTMLElement[] = [];
    const blacks: HTMLElement[] = [];
    let whiteIndex = 0;
    for (let note = this.lowest; note <= this.highest; note++) {
      const pc = note % 12;
      const key = document.createElement('div');
      key.dataset.note = String(note);
      if (BLACK_PCS.has(pc)) {
        key.className = 'xd-key xd-key--black';
        const left = whiteIndex * WHITE_W - BLACK_W / 2 + (BLACK_NUDGE[pc] ?? 0);
        key.style.left = `${left}px`;
        key.style.width = `${BLACK_W}px`;
        blacks.push(key);
      } else {
        key.className = 'xd-key xd-key--white';
        key.style.left = `${whiteIndex * WHITE_W}px`;
        key.style.width = `${WHITE_W - 1}px`; // 1px panel gap between whites
        whites.push(key);
        whiteIndex++;
      }
      this.keyEls.set(note, key);
    }
    for (const w of whites) this.keysEl.appendChild(w);
    for (const b of blacks) this.keysEl.appendChild(b); // blacks on top
    this.keysEl.style.width = `${whiteIndex * WHITE_W}px`;

    this.keysEl.addEventListener('pointerdown', this.handleDown);
    this.keysEl.addEventListener('pointermove', this.handleMove);
    this.keysEl.addEventListener('pointerup', this.handleUp);
    this.keysEl.addEventListener('pointercancel', this.handleUp);
  }

  get octaveShift(): number {
    return this.shift;
  }

  /** `silent` skips onOctaveShift — for programmatic resyncs (store -> UI),
   *  so they don't echo back as a user edit. */
  setOctaveShift(o: number, opts?: { silent?: boolean }): void {
    const next = clampInt(o, MIN_SHIFT, MAX_SHIFT);
    if (next === this.shift) return;
    this.shift = next;
    if (!opts?.silent) this.onOctaveShift?.(next);
  }

  /** Highlight keys (sequencer/arp feedback). Notes are post-shift MIDI; out-of-range ignored. */
  setLit(notes: number[]): void {
    for (const el of this.litEls) el.classList.remove('xd-key--lit');
    this.litEls = [];
    for (const n of notes) {
      if (!Number.isFinite(n)) continue;
      const base = Math.round(n) - this.shift * 12;
      const el = this.keyEls.get(base);
      if (el) {
        el.classList.add('xd-key--lit');
        this.litEls.push(el);
      }
    }
  }

  releaseAll(): void {
    for (const ap of this.pointers.values()) {
      if (ap.base >= 0) this.noteOffCb(ap.emitted);
    }
    this.pointers.clear();
    for (const emitted of this.programmatic.values()) this.noteOffCb(emitted);
    this.programmatic.clear();
    for (const base of this.downCounts.keys()) this.keyEls.get(base)?.classList.remove('xd-key--down');
    this.downCounts.clear();
    this.unbindWindow();
  }

  /**
   * Programmatic press by base (unshifted) note — used by attachComputerKeyboard.
   * Repeated presses of an already-held base note are ignored, as are base
   * notes outside the keybed range (no key, no note — matching the pointer path).
   */
  pressNote(baseNote: number, velocity: number): void {
    const base = Math.round(baseNote);
    if (!Number.isFinite(base) || this.programmatic.has(base)) return;
    if (base < this.lowest || base > this.highest) return;
    const emitted = base + this.shift * 12;
    this.programmatic.set(base, emitted);
    this.markDown(base, +1);
    this.noteOnCb(emitted, clampInt(velocity, 1, 127));
  }

  /** Release a programmatic press previously started with pressNote. */
  releaseNote(baseNote: number): void {
    const base = Math.round(baseNote);
    const emitted = this.programmatic.get(base);
    if (emitted === undefined) return;
    this.programmatic.delete(base);
    this.markDown(base, -1);
    this.noteOffCb(emitted);
  }

  // ------------------------------------------------------------------ private

  private markDown(base: number, delta: number): void {
    const count = (this.downCounts.get(base) ?? 0) + delta;
    const el = this.keyEls.get(base);
    if (count <= 0) {
      this.downCounts.delete(base);
      el?.classList.remove('xd-key--down');
    } else {
      this.downCounts.set(base, count);
      el?.classList.add('xd-key--down');
    }
  }

  private pointerId(e: Event): number {
    const id = (e as PointerEvent).pointerId;
    return typeof id === 'number' && Number.isFinite(id) ? id : -1;
  }

  private keyFromTarget(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    const key = typeof target.closest === 'function' ? target.closest('.xd-key') : null;
    if (key instanceof HTMLElement && this.keysEl.contains(key)) return key;
    return null;
  }

  private baseOf(keyEl: HTMLElement): number {
    const n = Number(keyEl.dataset.note);
    return Number.isFinite(n) ? n : -1;
  }

  private velocityFrom(keyEl: HTMLElement, clientY: number): number {
    const r = keyEl.getBoundingClientRect();
    if (!(r.height > 0)) return DEFAULT_VELOCITY; // degenerate rect (tests / detached DOM)
    const t = (clientY - r.top) / r.height;
    if (!Number.isFinite(t)) return DEFAULT_VELOCITY;
    const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.round(VEL_TOP + clamped * (VEL_BOTTOM - VEL_TOP));
  }

  private handleDown = (e: Event): void => {
    const keyEl = this.keyFromTarget(e.target);
    if (!keyEl) return;
    const id = this.pointerId(e);
    if (this.pointers.has(id)) return; // idempotent (container + window can both see the event)
    const base = this.baseOf(keyEl);
    if (base < 0) return;
    const pe = e as PointerEvent;
    const emitted = base + this.shift * 12;
    this.pointers.set(id, { base, emitted });
    this.markDown(base, +1);
    this.noteOnCb(emitted, this.velocityFrom(keyEl, pe.clientY));
    // Pointer capture keeps move/up flowing to us; guarded for happy-dom / old engines.
    if (typeof keyEl.setPointerCapture === 'function' && typeof pe.pointerId === 'number') {
      try {
        keyEl.setPointerCapture(pe.pointerId);
      } catch {
        /* not supported / synthetic event — window listeners cover us */
      }
    }
    this.bindWindow();
    if (e.cancelable) e.preventDefault();
  };

  private handleMove = (e: Event): void => {
    const id = this.pointerId(e);
    const ap = this.pointers.get(id);
    if (!ap) return;
    const pe = e as PointerEvent;
    if (!Number.isFinite(pe.clientX) || !Number.isFinite(pe.clientY)) return;
    const doc = this.el.ownerDocument;
    if (!doc || typeof doc.elementFromPoint !== 'function') return;
    let hit: Element | null = null;
    try {
      hit = doc.elementFromPoint(pe.clientX, pe.clientY);
    } catch {
      return;
    }
    if (!hit) return; // can't hit-test (degenerate layout) — keep current note
    const keyEl = this.keyFromTarget(hit);
    const newBase = keyEl ? this.baseOf(keyEl) : -1;
    if (newBase === ap.base) return;
    // Glide: release old, start new.
    if (ap.base >= 0) {
      this.markDown(ap.base, -1);
      this.noteOffCb(ap.emitted);
    }
    if (keyEl && newBase >= 0) {
      ap.base = newBase;
      ap.emitted = newBase + this.shift * 12;
      this.markDown(newBase, +1);
      this.noteOnCb(ap.emitted, this.velocityFrom(keyEl, pe.clientY));
    } else {
      ap.base = -1;
      ap.emitted = -1;
    }
  };

  private handleUp = (e: Event): void => {
    const id = this.pointerId(e);
    const ap = this.pointers.get(id);
    if (!ap) return;
    this.pointers.delete(id);
    if (ap.base >= 0) {
      this.markDown(ap.base, -1);
      this.noteOffCb(ap.emitted);
    }
    if (this.pointers.size === 0) this.unbindWindow();
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
}

/** QWERTY offsets in semitones from the anchor C. */
const QWERTY_MAP: Record<string, number> = {
  a: 0,
  w: 1,
  s: 2,
  e: 3,
  d: 4,
  f: 5,
  t: 6,
  g: 7,
  y: 8,
  h: 9,
  u: 10,
  j: 11,
  k: 12,
  o: 13,
  l: 14,
  p: 15,
  ';': 16,
};

/** One octave above the keyboard's lowest C (base MIDI 60) -> anchor at 72. */
const QWERTY_ANCHOR = 72;
const QWERTY_VELOCITY = 100;

/**
 * Maps the computer keyboard onto `kbd` (a=C..;=E+1, fixed velocity 100,
 * z/x octave down/up). Returns a detach function that also releases any
 * held notes. Key events are ignored while a text control has focus.
 */
export function attachComputerKeyboard(kbd: Keyboard): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const held = new Map<string, number>(); // normalized key -> base note

  const isTextTarget = (): boolean => {
    const a = typeof document !== 'undefined' ? document.activeElement : null;
    if (!a) return false;
    const tag = a.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return (a as HTMLElement).isContentEditable === true;
  };

  const normalize = (key: string): string => (key.length === 1 ? key.toLowerCase() : key);

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTextTarget()) return;
    const key = normalize(e.key);
    if (key === 'z' || key === 'x') {
      kbd.setOctaveShift(kbd.octaveShift + (key === 'z' ? -1 : 1));
      e.preventDefault();
      return;
    }
    const offset = QWERTY_MAP[key];
    if (offset === undefined || held.has(key)) return;
    const base = QWERTY_ANCHOR + offset;
    held.set(key, base);
    kbd.pressNote(base, QWERTY_VELOCITY);
    e.preventDefault();
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    const key = normalize(e.key);
    const base = held.get(key);
    if (base === undefined) return;
    held.delete(key);
    kbd.releaseNote(base);
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    for (const base of held.values()) kbd.releaseNote(base);
    held.clear();
  };
}
