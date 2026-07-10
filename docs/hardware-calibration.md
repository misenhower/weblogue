# Hardware calibration plan

Status: **rig designed, harness not yet built** (rewritten 2026-07-06 after the design round; the
2026-07-02 sketch grew into this plan plus [calibration-protocol.md](calibration-protocol.md), the
per-domain measurement protocol). Ground-truth policy: **hardware measurement > official docs >
current replica behavior.** Guessed values are flagged UNCONFIRMED in [xd-spec.md](xd-spec.md) and
[implementation-notes.md](implementation-notes.md); calibration replaces guesses with measurements
and is not required to preserve current replica behavior.

Scope decisions (2026-07-06): capture is USB-audio-interface line-in (the xd has stereo
OUTPUT L/MONO + R); drift is calibrated **steady-state only** this round (warmed-up synth, no
cold-start thermal modeling); priority order is oscillators → SHAPE → filter → effects → drift;
fits land in a **reviewed report, never auto-applied** to code; work pauses at each milestone gate.

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

Tag each tuned constant/table at its definition site:
`MEASURED(YYYY-MM-DD)` / `DOCUMENTED(source)` / `INFERRED`. The spec already uses
UNCONFIRMED; carrying provenance into the code tells future sessions which values are safe
to re-derive and which are hardware facts. A fit only earns MEASURED after the review +
verify loop below; the accepted fit is archived in `calib/results/<domain>.json`.

## The rig

**Control** — the xd on USB-MIDI. Full patch state is pushed as a SysEx CURRENT PROGRAM DATA
DUMP (func 40): `Program` → `encodeProgBin()` (synths/xd/progbin.ts, the same 1024-byte blob as
the librarian format) → Korg 7-bit encode → func 40 frame. After every push the harness requests
the edit buffer back (func 10), decodes, and diffs param-by-param — no capture happens on an
unverified patch. The *swept* parameter then steps via CC (10-bit params send CC63 with the low
3 bits *before* the value CC; CC map in xd-spec.md §13; CC80/81 have inverted receive polarity).
Note timing is plain in-process scheduling — millisecond jitter is irrelevant because analysis
timing derives from audio onsets, never from clock sync.

> Erratum: minilogue_xd_MIDIImp.txt line ~736 states the func-40 payload is "384Bytes (7bit) →
> 336Bytes (8bit)", contradicting its own TABLE 2 (offsets through 1023) and the librarian blob
> size. Treat it as a doc bug: derive payload length from the 7↔8-bit grouping and verify
> empirically at milestone M1.

**Capture** — xd OUTPUT L/R → interface line-in → the CoreAudio-native helper
(`tools/calib/native/calib-rec.swift`: AVAudioEngine tap + AVAudioConverter SRC, compiled on
demand by capture.ts) writing float WAV at 48 kHz, one file per sweep point. **Never capture
through ffmpeg's avfoundation input** — it silently drops stream chunks at a condition-dependent
rate and masqueraded as several different hardware problems before the 2026-07-10 diagnosis (full
story + proof chain in [calibration-findings.md](calibration-findings.md)). Devices are stored by
*name* in `calib/rig.json` and resolved to HAL ids at runtime. Rig hygiene: gain (harness warns
outside −40..−1 dBFS peak), keep the interface out of aggregate devices and never the system
default in/out. Capture integrity is enforced, not assumed: `calib check` step 8 captures the
xd's crystal-clocked VPM Sin1 and requires ≤2 phase jumps and <0.3¢ pitch sd; per-point run
validation gates on silence floor, strike spread ≤8¢, and the phase-jump detector (>2 events
fails). Each capture starts with ~300 ms of pre-roll
that measures the noise floor; the onset (first RMS crossing above it) is t=0 for every feature
window, which cancels all I/O latency.

**Comparison** — the same job replays through the replica offline: `new Engine(48000)` →
`loadProgram` → `setParam(id, raw)` per point → block render (the tests/helpers/audio.ts
pattern). Hardware WAV and replica render feed the **identical** feature-extraction code, so
extractor bias cancels and only real differences remain. Fits are closed-form TS (log-linear
least squares for `expMap` endpoints, log-log for power tapers, monotone Fritsch–Carlson tables
for non-analytic shapes, analysis-by-synthesis coordinate descent for tier-2 curve questions).

**Review gate** — a run ends in `report.md` per domain: `sweep raw | hardware | replica current
| proposed fit | error`, plus an explicit proposal block (e.g. `cutoffToHz: expMap(raw, 16, 21000)
→ expMap(raw, 22.4, 18700), residual 8¢ RMS — tag MEASURED(2026-07-06)`). Values are applied to
curves.ts by hand after review; `calib compare` then re-renders the replica against the stored
hardware features to confirm residuals collapsed, and `calib accept` archives the fit.

## Harness layout (to be built at M1)

Node CLI at `tools/calib/cli.ts`, run via `tsx` (`npm run calib -- <cmd>`), importing engine
sources directly; its own tsconfig (node types, no DOM) so the root build is untouched. Pure
pieces — feature extraction, fits, CC/SysEx codecs — are plain modules covered by vitest.

```
tools/calib/
  cli.ts                # subcommands: devices, check, run <job> [--dry], render, compare, accept
  lib/midi.ts           # @julusian/midi: port-by-name, CC/note/SysEx send, awaitSysEx(pred, timeout)
  lib/ccmap.ts          # param key → CC encoder; unit-tested as a round-trip through synths/xd/cc.ts decodeCc
  lib/sysex7.ts         # Korg 7↔8-bit codec + func 40/10 framing (length derived, see erratum)
  lib/capture.ts        # ffmpeg avfoundation wrapper; device resolve-by-name; peak-dBFS checks
  lib/wav.ts  lib/onset.ts
  lib/features.ts       # the ONE extractor for both worlds: complex-Goertzel phase tracker (~±0.05¢),
                        #   STFT ridge track, harmonic ladder, Welch PSD transfer, tone envelope, RT60
  lib/render.ts         # offline replica replay of a job
  lib/job.ts            # JSON job specs: base-patch overrides by param KEY + sweep + note plan
  lib/session.ts  lib/fit.ts  lib/report.ts
  jobs/*.json           # committed, reviewable measurement specs
calib/
  rig.json              # committed rig identity (device/port names, channel, gain notes)
  sessions/<ts>-<job>/  # frozen job + meta.json (firmware, git rev) + features.json + report.md
                        #   committed; raw/*.wav gitignored
  results/<domain>.json # accepted fits — the provenance record
```

New devDeps: `tsx`, `@julusian/midi`, `@types/node`. Everything else is stdlib + ffmpeg.

## Visibility and fail-fast

Long unattended runs must never end in silently unusable data:

- **`calib check`** — the rig smoke test, run at the start of every session: (1) MIDI port
  found → (2) note audibly plays → (3) dump push/read-back round-trip → (4) audio device found →
  (5) 3 s test capture with live peak meter → (6) one test note: onset detected, pitch printed.
  Each failing step names its likely fix ("no signal: check line-in gain / input source").
- **Live per-point status** during runs: `point 7/17 CUTOFF=448 | peak −11.3 dBFS | onset 302 ms
  | hw −3dB 1.42 kHz vs replica 1.61 kHz` — anomalies (clipping, missing onset, silent capture,
  extraction failure) surface immediately.
- **Per-point validation with retry**: every capture is checked the moment it lands (peak in
  range, onset found, features extractable); one automatic retry, then the run pauses and asks
  instead of collecting garbage.
- **Eyeball artifacts**: each session emits self-contained SVG plots (sweep curves hardware vs
  replica, spectra, envelopes) next to report.md; raw WAVs stay on disk for listening.
- **`--dry` mode**: prints the full MIDI/capture schedule and estimated wall-clock without
  touching hardware.

## Milestones (gate = pause + review before continuing)

- **M0 — Documentation** (this commit): this plan + [calibration-protocol.md](calibration-protocol.md).
- **M1 — Build + hello hardware**: harness skeleton incl. `calib check`; unit tests green with no
  hardware (ccmap↔decodeCc round-trip, sysex7 round-trip of a full progbin blob, features on
  synthetic signals, fit recovery from noisy synthetic sweeps). Then, xd on USB — `check` steps
  1–3 pass (settles the func-40 erratum). *No audio interface required yet.*
- **M2 — Vertical slice**: one trivial job (VCO1 saw, A440) through capture → features → replica
  render → comparison report. First look at the report format.
- **M3 — First fitted domain (filter cutoff)**: sweep → fit → proposal → hand-apply → `compare`
  confirms residuals collapse. Validates the whole loop once, end to end.
  *Software half landed 2026-07-09 (hardware session pending)*: job kinds tonal/noise/envelope
  (`measure-noise` PSD-transfer + `fitLpMag` corners, `measure-env` EG segment times with the
  0.7492 attack-rise shape factor, `phasejump` replacing the slope corruption scan), the
  proposal pipeline with held-out validation (`## Proposals` in report.md), `compare`/`accept`
  commands, and eg-attack/decay/release + cutoff-sweep jobs. Pipeline proven by replica
  self-calibration tests: the render→measure→fit loop recovers the replica's own curves.
- **M4 — Core voice domains**: VCO pitch/portamento, SHAPE, remaining filter, EGs, mod depths + LFO.
- **M5 — Breadth**: MULTI voicings, LFO-sync semantics, drift, FX, arp variants; checklist sweep;
  propagation notes for the other synth modes.

## Measurement checklist → protocol domains

The full method per domain (base patch, stimulus, features, fit, pitfalls, time budget) is in
[calibration-protocol.md](calibration-protocol.md). Mapping from the original checklist:

| Checklist item (UNCONFIRMED source) | Domain |
|---|---|
| VCO SHAPE character: TRI fold, SAW morph, SQR PW endpoints | D2 |
| NOISE Peak center frequency + keytrack (modeled 4× note) | D3 |
| Filter: cutoff span/taper, resonance taper, bass interaction, DRIVE gains/character | D4 |
| EG A/D/S/R curves + maxima, mod-EG decay-after-release, retrigger from zero vs current | D5 |
| Mod depths: EG→pitch ±4800¢, EG→cutoff ±10 oct, LFO→pitch/cutoff/shape | D6 |
| LFO Voice Sync semantics (staggered-note re-lock? idle lockstep? idle RATE change?) | D7 |
| Drift magnitude/spectrum per VCO, VCO2-runs-fast bias | D8 |
| Portamento curve and timing (Auto vs On), VCO pitch knob + octaves | D1 |
| Arp variant behaviors (MANUAL/RISE/FALL 1 vs 2, POLY 1/2, RANDOM 3) | D10 |
| Sequencer TIE trigger-bit semantics; realtime-rec gate precision | D10 |
| VPM per-type ratio/feedback voicings | D3 |
| FX ranges (delay time/feedback, reverb decays, mod-fx rates) — partly subjective | D9 |

## What this means for the other synth modes

Only the xd can be measured — it's the hardware owned. minilogue OG / monologue / prologue
modes are built from manuals and community sources regardless, so **they are not blocked on
the rig**. Their tier-2 curve shapes stay per-synth data; xd measurements then refine shared
circuits (the family's VCO shape behavior, drive, EG shapes) where Korg is known to have shared
designs, without rework in the synth definitions themselves. Each calibration report ends with
an "applies to" note listing which findings plausibly transfer (e.g. the 2-pole SVF voicing →
prologue's LP; EG segment law → whole family) and which are xd-only (MULTI, xd FX voicings).
