# Implementation notes

Decisions, interpretations, and quirks a maintainer needs but the code can't fully explain in place.
Hardware ground truth lives in [xd-spec.md](xd-spec.md); user-facing departures are summarized in the
README. This file is the engineering detail behind both.

## Architecture in one paragraph

The whole synth runs in a single AudioWorkletProcessor (`src/dsp/processor.ts`, a thin message shell
around `Engine`). The UI owns the Program — `Store` (src/state) is the source of truth, forwarding param
changes and sequence edits to the engine over the `ToEngine` protocol (src/shared/messages.ts); the engine
keeps a playback copy. All raw↔physical mapping goes through `src/shared/maps.ts`, which reproduces
Korg's official piecewise tables exactly (VCO pitch, EG INT quadratic, chord/arp knob zones, LFO BPM
divisions); ids in `src/shared/params.ts` are append-only.

## Interpretations where the hardware is undocumented

These are deliberate choices, not oversights. Marked UNCONFIRMED in code where applicable.

- **Arp type variants**: MANUAL/RISE/FALL/RISE-FALL "1" = one octave, "2" = two octaves; POLY 1 = chord
  each step, POLY 2 = chord alternating octaves; RANDOM 3 adds octave displacement + velocity variation.
  Community-consensus readings; Korg documents only the names and knob zones.
- **VPM SHIFT+SHAPE** = stepped modulator-ratio multiplier ×¼/×½/×1/×2/×4 with a wide exactly-neutral
  center zone (`[0,.15) [.15,.38) [.38,.62] (.62,.85] (.85,1]`). Sin1 at the center detent is a pure
  2-op sine (Goertzel-verified in tests). Per-type internal ratios/feedback are our own voicings of
  Korg's one-line type descriptions.
- **NOISE Peak**: SHAPE controls bandwidth 110–880 Hz per the manual; the *center* frequency is
  undocumented — we keytrack it at 4× the note frequency.
- **Modulation depth scaling** (nowhere documented): EG→pitch ±4800¢ at 100%, EG→cutoff ±10 octaves,
  LFO→pitch ±1200¢, LFO→cutoff ±7 octaves, LFO→shape full-scale.
- **Sequencer TIE**: the hardware stores a per-note trigger-switch bit (gate bit 7); we simplified — a
  sounding tied note continues when the same note appears in the next triggered step and releases
  otherwise. Audible difference only in patterns that relied on trigger=0 continuation across changing
  notes.
- **Realtime-rec gate capture** measures wall-clock hold time against the step duration and writes
  TIE chains across boundaries; hardware precision unknown but behavior matches its description.
- **EG retrigger**: envelopes restart from the *current level* (click-free); voice stealing uses a
  ~1.5 ms kill ramp with the restart pended until the ramp finishes (`pendFlag` in engine.process).
  The family's reported restart-from-zero quirk is approximated by steal-kill, not by hard resets.

## Engine mechanics worth knowing before editing

- **Allocation**: POLY uses a rotor (round-robin) over idle voices, falling back to oldest-released,
  then steal-oldest; DUO rotates pairs (0,1)/(2,3); CHORD keeps a `chordMap` so legato re-pitches the
  same voices while fresh strikes rotate. `lastStartHz` seeds new-voice glide so portamento works
  across round-robin.
- **Non-destructive modulation layers**: motion-sequence values, joystick Y, and aftertouch all apply
  as override/offset layers on top of knob values — `effectiveParam(id)` is raw + layers; knob
  positions are never mutated. Motion overrides clear on transport stop and on lane clear/reassign
  (`releaseStaleMotion`). Joystick-Y and aftertouch each hold their own GATE TIME offset; the sum goes
  to `Sequencer.setGateTimeOffset`.
- **Mono modes + sustain pedal**: UNISON/CHORD defer releases while the damper is down
  (`monoSustained`), flushing on pedal-up with the current note last so pitch doesn't fall back.
- **MIDI**: 10-bit params arrive as CC#63 (low 3 bits) *before* the value CC. Engine-dependent CCs
  (54/104/103/96) decode to sentinel negative ids; `src/midi/resolve.ts` maps them to the active
  engine/FX param — its zone counts derive from PARAMS metadata so they can't drift. SYNC/RING receive
  inverted polarity (0–63 = ON). CC59 is deliberately unmapped.
- **Output safety**: post-reverb soft limiter (identity below ~0.7); `takePeak()` feeds nothing by
  default (the old `level` telemetry was removed).

## Verification infrastructure

- 561 vitest tests as of 2026-07-02; DSP tests render audio and assert spectra/timing, not just shapes.
- Browser debug hook `window.__xdDebug`: `rms()` (post-master analyser), `contextState()`, `powerOn()`,
  `noteOn/noteOff(note)`, `store`. Used by all automated in-browser checks.
- Scope trigger math: tap frames are 1280 samples with a fixed 512-sample centered view, so the
  center-trigger search span (~16 ms) guarantees a lock down to ~C2.
- Gotcha for automated verification: a hidden tab pauses `requestAnimationFrame`, so canvas-repaint
  assertions silently measure nothing — check `document.visibilityState` first (this produced two
  false test results during development).

## Known cosmetic quirks (deliberately unfixed)

- `Display`/`DebugPanel` never dispose store subscriptions (page-lifetime singletons).
- OLED soft-button `bindHold`: an aborted press can swallow one subsequent synthetic click (guarded
  for real pointers via window pointerup reset).
- SERVICE MODE 4V overlays show only the top color where traces coincide exactly (e.g. four in-phase
  free-running LFOs after power-on read as one line) — overlay semantics, not a bug.

## Out of scope (intentional)

Hardware SDK user slots (oscillator slots ship 4 built-ins; delay/reverb user slots omitted; mod FX
USER = Rotary/Trem), MIDI out/SysEx, CV IN, Poly Chain, global settings (master tune, velocity curves,
knob pickup modes), microtuning beyond the 11-entry subset, and the OLED shows our menu system rather
than pixel-cloning Korg's pages.
