# Hardware calibration plan

Status: **planned, hardware not yet set up** (written 2026-07-02, ahead of the rig, so that
other work — new synth modes, refactors — leaves the right seams). Ground-truth policy:
**hardware measurement > official docs > current replica behavior.** Guessed values are
flagged UNCONFIRMED in [xd-spec.md](xd-spec.md) and [implementation-notes.md](implementation-notes.md);
calibration replaces guesses with measurements and is not required to preserve current
replica behavior.

## How parameters flow (and where measurements land)

```
UI knob / MIDI CC in
  → Store                      raw 0..1023 (hardware knob domain)
  → 'param' {id, v} message    shared/messages.ts
  → Engine.applyParam          the per-synth binding switch (engine.ts)
  → shared/maps.ts curve       raw → physical (cutoffToHz, attackToSec, egIntToPercent, …)
  → module setter              physical units only (Hz, seconds, cents, gain)
```

Modules never see raw values or param ids (push model), so every calibration finding lands
in exactly one of three tiers:

1. **Constants** — the common case: mod-depth scalings, EG time ranges, filter span,
   resonance taper, drive gains, drift magnitude. These live as literals in maps.ts and in
   module config tables (the `DELAY_CFG` / `REVERB_CFG` / `VPM_TABLE` pattern). Action:
   replace the number, re-pin the affected tests.
2. **Curve shapes** — SHAPE morph transfer functions (TRI wavefolder, SAW morph), the EG
   segment shape, resonance/cutoff interaction. Keep these as small pure functions or
   lookup tables so a measured curve can replace an analytic guess without touching call
   sites. When multiple synth modes exist, these become per-synth config feeding shared
   modules — a measured xd triangle and a differently-voiced monologue triangle should be
   two table entries, not two forks of osc.ts.
3. **Structure** — rare: routing or behavior contrary to the spec (e.g., drive placement,
   EG retrigger semantics). Action: update xd-spec.md first, then change the engine.

## Provenance convention

When calibration starts, tag each tuned constant/table at its definition site:
`MEASURED(YYYY-MM-DD)` / `DOCUMENTED(source)` / `INFERRED`. The spec already uses
UNCONFIRMED; carrying provenance into the code tells future sessions which values are safe
to re-derive and which are hardware facts.

## The rig (sketch)

- **Control**: MIDI out to the xd using the CC map in xd-spec.md §13 (10-bit params send
  CC63 low-3-bits *before* the value CC). SysEx program dump/load for full-patch
  determinism if per-CC setup proves fiddly.
- **Capture**: audio interface line-in from the xd, FX off unless FX are the target.
- **Harness**: a Node (or vitest-adjacent) script that, per parameter: sets a value over
  CC → plays a test note → records → extracts features (harmonic levels via FFT/Goertzel,
  envelope timing, sweep response) → renders the identical event stream offline through
  `Engine` (headless-constructible; the DSP tests already do this) → compares, fits, and
  updates the tier-1/2 data → re-runs the test suite.
- **Sweep shape**: staircase over the raw domain (e.g., 17 points across 0..1023), one
  sustained note per point; repeat per octave where keytracking matters.

## Measurement checklist (from the spec's UNCONFIRMED items)

- VCO SHAPE character: TRI fold transfer (3rd/5th emphasis), SAW morph blend, SQR PW endpoints
- NOISE Peak center frequency + keytrack (currently modeled as 4× note frequency)
- Filter: cutoff span and taper, resonance taper, resonance/bass interaction, DRIVE 50/100% gain and character
- EGs: A/D/S/R time curves and maxima, mod-EG decay-after-release, retrigger (from current level vs zero)
- Mod depth scalings (all currently guessed): EG→pitch ±4800¢, EG→cutoff ±10 oct, LFO→pitch ±1200¢, LFO→cutoff ±7 oct, LFO→shape
- LFO Voice Sync semantics (replica models it as a continuous block-rate phase share; manuals only say
  "phase shared across voices"): with Voice Sync ON + Key Sync ON, does a staggered second note's LFO
  re-lock to the already-sounding voices, or keep its key-synced phase? Also: with both syncs OFF, do
  idle voices' LFOs actually free-run in lockstep, and does a RATE change apply to voices between notes?
  (Method: LFO→pitch at high INT, slow rate, record two staggered notes, compare wobble alignment.)
- Drift: magnitude/spectrum per VCO, reported VCO2-runs-fast bias
- Portamento curve and timing (Auto vs On)
- Arp variant behaviors (MANUAL/RISE/FALL 1 vs 2, POLY 1/2, RANDOM 3)
- VPM per-type ratio/feedback voicings (Goertzel per type at the neutral detent)
- FX ranges (delay time/feedback max, reverb decays, mod-fx rates) — lower priority, partly subjective

## What this means for the other synth modes

Only the xd can be measured — it's the hardware owned. minilogue OG / monologue / prologue
modes are built from manuals and community sources regardless, so **they are not blocked on
the rig**. Build them now with DOCUMENTED/INFERRED values, keeping tier-2 curve shapes as
per-synth data; later xd measurements then refine shared circuits (the family's VCO shape
behavior, drive, EG shapes) where Korg is known to have shared designs, without rework in
the synth definitions themselves.
