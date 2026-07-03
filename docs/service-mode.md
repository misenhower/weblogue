# SERVICE MODE

A diagnostic drawer the real xd doesn't have: live oscilloscopes at every stage of the signal path,
per-voice state, and modulator visualizers. Named after the hardware's hidden service/test mode.

**Open/close**: the `` ` `` (backtick) key or the SERVICE chip in the corner. Drag it anywhere by its
header (position persists). Telemetry streams only while the drawer is open — closed, the whole system
costs one branch per sample.

## Views

- **DIAGRAM** (default): the signal path as a block diagram. Generators stack left — VCO 1 ⊕ VCO 2 ⊕
  MULTI — into MIX → VCF, then down through VCA → **Σ×4** → MOD FX → DELAY → OUTPUT. Wires are live:
  the MULTI wire reroutes when Multi Routing is Post VCF; SYNC/RING/X-MOD badges light from the
  program; EG→/LFO→ routing badges show current targets with wires whose brightness follows the
  intensity knobs. The Σ×4 badge marks where the xd mono-sums all four voices before the effects.
- **COMPACT**: the original six-scope strip (VCO 1 ⊕ VCO 2 ⊕ MULTI → MIX → VCF → OUTPUT). VCA and the
  FX-stage taps are diagram-only.
- Toggle top-right; choice persists in localStorage.

## Scopes

- **Click any scope** to toggle waveform ↔ spectrum (Hann FFT, log frequency 30 Hz–16 kHz, 0…−80 dB).
- **Center-triggered**: a rising zero crossing locks to the horizontal middle; frames are long enough
  (1280 samples, 512 shown) to guarantee a lock down to ~C2. Analog drift makes traces "breathe" —
  that's real.
- **Stereo cells** (MOD FX, DELAY, OUTPUT — the signal is stereo from the mod effects onward): L green
  over R blue with a corner L/R legend, sharing the L channel's trigger so inter-channel timing
  (ping-pong bounce, chorus width) is honest.
- **Glow fills**: each trace fills toward its zero line with a fixed canvas-space gradient (full color
  from ~80% amplitude outward, transparent at zero) — louder signals visibly reach the bright zone.
  Waveforms get the mirrored double gradient; FFT and unipolar sparklines a single bottom-anchored ramp.

## 1V / 4V

- **1V**: the voice-path scopes and the MOD row follow the most recently triggered voice (lane
  highlight shows which).
- **4V**: 4-channel-scope overlay — every voice drawn in its color (V1 green, V2 blue, V3 gold,
  V4 rose), each locked to its *own* trigger (voices sit at unrelated pitches; a shared trigger would
  scramble three traces). Silent voices are skipped entirely; the corner `1 2 3 4` legend dims idle
  voices. The last-triggered mechanism is fully disabled: fixed draw order, no lane highlight, MOD
  sparklines overlay all four voices. Note: exactly coincident traces show the top color only (four
  in-phase LFOs = one line).

## MOD row, lanes, health

- **MOD row**: rolling ~4 s sparklines of amp EG (green), mod EG (gold), LFO (blue) — control signals,
  complementing the VCA scope which shows their effect on audio. All voices record continuously, so
  switching voices shows genuine history.
- **Voice lanes**: LED (gate), note name, tuning readout (sounding Hz + total cents deviation from
  equal temperament — bend/microtuning/program tuning; drift shown separately), amp-EG bar, and dual
  drift needles (gold = VCO 1, blue = VCO 2 — independent, like the hardware; they wander even in
  silence because analog VCOs free-run).
- **Health strip**: audio-thread load (engine time vs realtime budget) and active voice count.

## Telemetry (for maintainers)

`{t:'debug', on, all}` arms the engine; frames arrive ~30/s as `{t:'dbg'}` with 12 transferred tap
buffers (6 mono voice taps for the tapped voice + 3 stereo FX pairs), plus 24 per-voice buffers in 4V,
per-voice modulator/tuning state, and load. Idle voices write zeros into their taps (their tick() is
skipped, so tap fields would otherwise freeze mid-waveform). See `src/ui/debugpanel.ts`,
`Engine.copyDebugTaps/copyDebugVoiceTaps`, and `XdProcessor.postDebug`.
