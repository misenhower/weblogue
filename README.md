# minilogue xd — web

A feature-complete replica of the **Korg minilogue xd** hybrid synthesizer that runs entirely in the
browser. The whole signal path is modeled in TypeScript inside an AudioWorklet — no samples, no external
libraries.

**Play it now: <https://misenhower.github.io/weblogue/>**

## Quick start

```bash
npm install
npm run dev        # http://localhost:5199
```

Click **POWER ON** (browsers require a user gesture to start audio), then play:

- **Mouse/touch**: click the keys (vertical position sets velocity), drag knobs (Shift = fine,
  double-click = default), use the joystick for pitch bend / modulation.
- **Computer keyboard**: `a w s e d f t g y h u j k o l p ;` play notes, `z` / `x` shift octave.
- **MIDI**: plug in a controller — notes, pitch bend, sustain, and the minilogue xd's own CC map
  (including Korg's 10-bit CC#63 LSB scheme) are supported.
- **SERVICE MODE**: press `` ` `` (backtick) for a diagnostic drawer the hardware never had — live
  oscilloscopes at every signal-path stage (click any for a spectrum view), a 4-voice overlay mode,
  per-voice drift meters and tuning readouts, and modulator visualizers. See
  [docs/service-mode.md](docs/service-mode.md).

## What's modeled

| Section | Details |
|---|---|
| Voices | 4-voice polyphonic architecture (independent filter + EGs + LFO per voice), mono-summed pre-FX like the hardware |
| VCO 1/2 | PolyBLEP anti-aliased SQR/TRI/SAW with per-wave SHAPE morphing, BLEP-corrected hard sync, ring mod, audio-rate cross modulation, per-voice analog drift |
| Multi Engine | 4 noise modes (High/Low/Peak/Decim), all 16 VPM types with the 6 menu trim parameters, 4 built-in "user" oscillators (MORPH / SPRSAW / PWMCLS / ORGAN) |
| Filter | 2-pole zero-delay-feedback lowpass, tanh-in-the-loop resonance, 3-position drive at 2× oversampling, keytrack centered on C4 |
| Modulation | ADSR amp EG, AD mod EG (PITCH / PITCH 2 / CUTOFF targets), per-voice LFO (1-shot half-cycle / normal / BPM-sync with Korg's 16 divisions), joystick assigns |
| Effects | Mod FX (8 choruses, 3 ensembles, 8 phasers, 8 flangers + rotary/trem), 12 delay types, 10 reverb types (incl. octave-up Riser and octave-down Submarine), independent dry/wet per section |
| Voice modes | POLY (with DUO zone), UNISON detune, all 14 CHORD types, ARP with latch and all 13 pattern types |
| Sequencer | 16 steps, 8 notes/step, step + realtime recording, ties, active-step skipping, swing, and 4 motion lanes with the hardware's 5-points-per-step smoothing |
| Programs | 500 slots persisted in localStorage, 32 original factory-style presets, program write/browse |

Parameter behavior follows Korg's official documentation exactly where published — the piecewise VCO
pitch knob curve, the quadratic EG INT law, chord/arp knob zones, LFO BPM divisions, and the MIDI CC map
all come from the official minilogue xd MIDI implementation. The compiled hardware spec lives in
[docs/xd-spec.md](docs/xd-spec.md).

### Intentional departures from the hardware

- The user oscillator/FX slots load compiled ARM binaries via Korg's logue SDK, which can't run in a
  browser — the USR oscillator slots ship with built-in custom oscillators, the USER mod-FX slots with
  Rotary/Trem, and the delay/reverb USER slots are omitted.
- Microtuning is a subset (Ionian/Dorian/Aeolian and the AFX/DC/user scales are not included).
- Global settings (master tune, velocity curves, knob pickup modes) and MIDI output/SysEx are not
  implemented; MIDI is input-only.
- The sequencer's per-note trigger-switch bit is simplified: a tied note continues when the same note
  reappears in the next triggered step, and releases otherwise.

## Development

```bash
npm test           # vitest suite: DSP rendering, mapping tables, sequencer timing, UI, MIDI decode
npm run build      # typecheck + production bundle
npm run check      # app + calibration typechecks, then the full test suite
npm run preview    # serve the production build on http://localhost:4173
```

Architecture: `src/shared/` is the synth-agnostic framework (parameter metadata, program/sequence
data model, generic math helpers, and the UI↔engine message protocol); `src/dsp/` holds the generic
DSP modules (oscillator, filter, EGs, LFO, drift, multi engine, FX, step sequencer, arpeggiator);
`src/synths/xd/` is the minilogue xd definition (parameter table, hardware curves, voice graph,
engine wiring, worklet entry, panel layout, CC resolver, program serialization); `src/ui/` holds the
framework-free UI primitives; `src/state/` is the program store; `src/midi/` is Web MIDI input.
`src/dsp/` and `src/shared/` never import from `src/synths/` — new synth modes add a definition, not
engine forks. Five modes ship today: **minilogue xd**, **minilogue**, **monologue**, **prologue 8**,
and **prologue 16**; switch with the corner chips or `?synth=<id>`. Each synth family keeps its own
500-slot program bank. Deeper docs: [docs/xd-spec.md](docs/xd-spec.md) (hardware spec from Korg's official
documentation, including post-research findings), [docs/implementation-notes.md](docs/implementation-notes.md)
(design decisions, undocumented-hardware interpretations, engine mechanics), and
[docs/service-mode.md](docs/service-mode.md). Calibration operators should start with
[docs/calibration-operations.md](docs/calibration-operations.md).

## Disclaimer

Unofficial fan project for education and fun. Not affiliated with or endorsed by KORG Inc.
"minilogue" is a trademark of KORG Inc. All presets are original sound design.
