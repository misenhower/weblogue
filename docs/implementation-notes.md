# Implementation notes

Decisions, interpretations, and quirks a maintainer needs but the code can't fully explain in place.
Hardware ground truth lives in [xd-spec.md](xd-spec.md); user-facing departures are summarized in the
README. This file is the engineering detail behind both.

## Architecture in one paragraph

The whole synth runs in a single AudioWorkletProcessor (`src/synths/xd/processor.ts`, a thin message
shell around `Engine`). The UI owns the Program — `Store` (src/state) is the source of truth, forwarding
param changes and sequence edits to the engine over the `ToEngine` protocol (src/shared/messages.ts); the
engine keeps a playback copy. All raw↔physical mapping goes through `src/synths/xd/curves.ts`, which
reproduces Korg's official piecewise tables exactly (VCO pitch, EG INT quadratic, chord/arp knob zones,
LFO BPM divisions); ids in `src/synths/xd/params.ts` are append-only.

## Synth-definition split (2026-07-02)

Preparation for multiple 'logue-family modes (base minilogue, monologue, prologue): the codebase is cut
into a synth-agnostic core and a per-synth definition. Rules and residue a maintainer needs:

- **Layout.** `src/shared/` = framework (paramdef.ts metadata/factories, program.ts data model +
  gate/step-resolution semantics, maps.ts generic math/format helpers, messages.ts protocol).
  `src/dsp/` = generic DSP modules, including the step sequencer (`stepseq.ts`, motion-target
  predicates injected as `MotionTargetMeta`) and arpeggiator (`arp.ts`, rate injected as
  beats-per-step; the 13 xd type behaviors are the family superset). `src/synths/xd/` = the xd:
  params table, curves, voice graph, engine (binding switch + voice modes + FX chain order),
  worklet entry, panel, CC resolver, program init/serialization.
- **Direction rule.** `src/dsp/` and `src/shared/` never import from `src/synths/` — a new synth mode
  is a new definition directory, never a fork of a core module. Hardware-calibration findings land as
  per-synth data in curves/config tables (docs/hardware-calibration.md).
- **Program format.** v2 adds `synthId` ('xd'); v1 files (no synthId) load as xd. The xd deserializer
  refuses other synths' programs (returns null) rather than loading them as xd defaults.
- **Second synth landed (2026-07-02): the original minilogue** (`src/synths/og/`, spec in
  docs/og-spec.md). The deferred allocator extraction became `dsp/voicebank.ts` (VoiceBank +
  NoteStack); the OG engine builds its 8 voice modes on those primitives plus its own echo queue
  (DELAY mode) and duck envelopes (SIDE CHAIN). Its UNCONFIRMED voicings (filter resLoss, delay
  wet level, arp rate, mono sub curve, invert semantics, EG-MOD rate depth) are marked in
  synths/og/curves.ts + engine.ts as calibration targets. The OG SERVICE MODE drawer shipped:
  `ui/debugpanel.ts` takes an injected `DebugDef` (synths/<id>/debug-def.ts) so stage labels,
  routing badges and modulator lanes are per-synth data (the OG's FX scopes render mono). The
  OLED menu set is the minimal correct og-spec §11 list.
- **Shared seams (extracted once both synths existed):** `dsp/procshell.ts` (the AudioWorklet
  message shell — a synth's processor.ts is one `registerSynthProcessor` call around its Engine),
  `synths/app-common.ts` (main-thread app shell: Store/Display/SERVICE MODE/MIDI plumbing behind
  a `SynthAppConfig`), `ui/parambinder.ts` (panel param-id -> control bindings + silent resync),
  and `makeProgramCodec` in `shared/program.ts` (defensive program init/serialization bound to a
  param table; each synths/<id>/program.ts is a ~15-line binding).
- **Engine base extracted (2026-07-04):** `dsp/enginebase.ts` (`EngineBase`) owns the family engine
  skeleton — param store + layered model (motion overlay + registered offset layers), the shared
  noteOn/noteOff machinery over VoiceBank/NoteStack (poly/duo/chord start helpers), StepSeq +
  optional Arp transport, and the process() skeleton (voice sum, per-synth `processFx`, soft
  limiter, SERVICE MODE taps). A synth engine is now: an `EngineBaseConfig` (param table, ids,
  portamento curve, voice factory, arp wiring), the `applyParam` switch, offset-layer resolvers,
  voice-mode semantics (`modeNoteOn`/`modeNoteOff`/`monoStart`/`startVoice`) and per-synth hooks
  (`preProcess`, `onAllNotesOff`, `onTimingChanged`, `lfoVoiceSyncOn`, `syncArp`). The monologue
  omits the arp config and gets sequencer SLIDE via the `hookNoteOn(note, vel, slide)` override.
- **Known residue in generic dirs, acceptable for now:** the CC1/CC2 joyY handlers in
  `src/midi/midi.ts` (the xd's joystick Y+/Y-; the og stubs them out), the xd-shaped
  `DbgVoice` telemetry frame in `src/shared/messages.ts`, the family voice/motion dimensions
  (`NUM_STEPS`, `NOTES_PER_STEP`, …) in `src/shared/program.ts`, and the `xd-` CSS-class and
  localStorage prefix, which both synths share as a de-facto framework namespace.

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
- **LFO Voice Sync** = continuous phase share: every process block, voices 1-3 adopt voice 0's
  free-running LFO phase (both synths; the xd skips it in 1-SHOT mode where per-voice half-cycle
  freezes are the point). The manuals only say "phase shared across voices"; a copy-at-note-start
  approximation proved too weak once the OG's per-voice EG-MOD=RATE could sweep rates apart.
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

- The full vitest suite (`npm test`) is the behavioral contract — several hundred tests across both
  synths; DSP tests render audio and assert spectra/timing, not just shapes.
- Browser debug hook `window.__synthDebug` (with `window.__xdDebug` kept as a legacy alias):
  `rms()` (post-master analyser), `contextState()`, `powerOn()`, `noteOn/noteOff(note)`,
  `synthId`, `store`. Used by all automated in-browser checks.
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
