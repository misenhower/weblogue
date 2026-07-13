# Calibration operations

This is the short operator guide. The measurement design and scientific
rationale live in [calibration-protocol.md](calibration-protocol.md); findings
belong in [calibration-findings.md](calibration-findings.md).

## Command map

| Command | Purpose |
|---|---|
| `npm run typecheck:calib` | Typecheck the Node calibration harness only; no hardware is touched. `check:calib` remains as a compatibility alias. |
| `npm run calib -- devices --save` | Discover MIDI/audio devices and update ignored local routing in `calib/rig.local.json`; committed unit metadata is untouched. |
| `npm run calib -- check` | Exercise the physical rig: MIDI, patch round-trip, capture level, onset/pitch, and quartz integrity. |
| `npm run calib -- run <job> --dry` | Print a job's patch/note/capture schedule without touching hardware. |
| `npm run calib -- run <job> [--profile <id>]` | Capture one exploratory session. Add `--temperature <C> --warmup <minutes> --tuning <description>` for provenance. |
| `npm run calib -- remeasure <session>` | Rebuild derived features/report from retained raw WAVs after extractor changes. |
| `npm run calib -- compare <session> --profile <id>` | Diagnostic comparison only. It cannot authorize acceptance. |
| `npm run calib -- evidence <session> [--candidate-profile <id>]` | Promote four derived artifacts into a small, trackable evidence bundle. Bind fitting evidence to the frozen profile ID/content with `--candidate-profile`; raw WAVs stay local. |
| `npm run calib -- verify <candidate-evidence> --session <verification-evidence> --profile <id>` | Re-render a candidate against a separate promoted capture set and persist the threshold decision. |
| `npm run calib -- accept <candidate-evidence> --verification <artifact>` | Recheck evidence hashes, profile identity, procedure revision, design, and metrics before writing an accepted result. |
| `npm run calib -- validate-profile <id>` | Require every field changed by a procedure-declaring profile to name a matching accepted result. Run before making it the default. |
| `npm run calib -- monitor` / `scope` | Inspect live or historical captures. |
| `npm run calib -- restore` | Restore a saved edit-buffer backup. |

`npm run check` is the repository-wide software check: app typecheck,
calibration typecheck, and the full test suite.

## The loop: capture → analyze → verify → record

All work under `calib/sessions/` is deliberately ignored: most sessions are
exploratory and raw audio is large. A calibration generation runs this loop.
The checks along the way are practical, not ceremonial — they exist to catch
stale copies and human/agent slip-ups in a repo where raw data never enters
git, not to defend against adversaries.

**Capture** — run fitting jobs; repeat questionable domains and review their
reports (`calib monitor`).

**Analyze** — turn the data into a synth config plus the record of the data
behind it. Two actions, one step:

1. Freeze the candidate profile in `src/synths/xd/profiles.ts`, non-default,
   declaring the procedure that produced it (for example procedure R1) and
   its lineage: base profile + one result path per changed field, e.g.
   `calib/results/v1/eg-attack.json`. Lineage is part of the profile digest,
   so adding paths after verification would correctly invalidate it.
2. Promote the fitting sessions with
   `calib evidence <session> --candidate-profile <id>`: the four derived
   artifacts are copied into committed `calib/evidence/`, content-bound to
   the session state and profile they came from — sessions stay local and
   mutable (`remeasure` rewrites them freely), so this binding is what makes
   a later silent divergence loud instead of invisible.

**Verify** — prove the model against captures it has never seen:

3. Run the verification jobs AFTER that promotion, with raw values offset
   from the fitting grid; where a model assumes pitch invariance, include
   another note or octave. Do not refit after seeing these results — if the
   model changes, retire the verification set and capture a fresh one.
4. Promote the verification sessions with `calib evidence`.
5. Run `calib verify`: fitting and verification evidence must differ,
   coverage must be complete, the candidate must improve on the captured
   baseline, and its domain metric must meet the protocol threshold.

**Record** — write the durable result:

6. Run `calib accept --verification ...` — it recomputes the metrics from
   the evidence rather than trusting the artifact JSON, so an accidentally
   edited artifact is inert — then commit evidence, verification, and result.
7. Run `calib validate-profile <id>`: every field changed from the base must
   trace to a recorded result.
8. The musical listening A/B before promoting the profile to the app default
   stays deliberately manual; `calib accept` certifies numbers, not sound.

The plan of record completed 2026-07-13: the suite ran under procedure R1,
the results landed as the new v1 (verified at unseen points, 7 of 8 domains
accepted; the TRI fold ships measured-but-deferred pending a frequency-aware
core model), v1 was promoted to the app default after the listening review,
and the transitional dev-era v1-v4 were dropped (git history keeps them).
Two profiles remain: v0, the pre-calibration snapshot and lineage base, and
v1, the R1 re-baseline.

Profile versions use `vN`; measurement procedures use `RN`. Evidence and
verification must agree on the procedure ID/revision, and the candidate profile
is content-hashed so changing it requires a fresh verification artifact.
Every fitting job that can alter the emulation declares exact `profileFields`.
The candidate profile declares `lineage.baseProfile` plus one accepted-result
path per changed field; `validate-profile` compares the actual structural diff
and rejects missing, surplus, wrong-profile, or wrong-procedure provenance.

## Unit and session identity

Ignored `calib/rig.local.json` selects machine-specific MIDI/audio routing and
a unit alias; copy `calib/rig.local.example.json` to start. The committed
`calib/rigs/<unit-id>.json` gives that physical unit stable capture provenance.
A serial number is unnecessary; use one only if the owner is comfortable
publishing it. Fill in firmware when known. Each serious run should also record:

- warm-up minutes;
- room temperature;
- whether the synth's tuning routine was run, and when;
- changes to cables, interface, sample rate, gain, or firmware.

One owned xd can establish strong facts about structure and this unit's
behavior. It cannot establish manufacturing-population statistics. Reports
must therefore distinguish `observed on xd-unit-1` from `likely invariant`.
Future contributors can promote compatible evidence from other units; aggregate
profiles should retain between-unit and between-voice spread rather than only
pooling medians.

## Capture-chain checks and uncertainty

An interface line-output-to-line-input loopback measures that interface's
combined DAC + ADC path. It is useful for detecting sample corruption, latency,
and gross frequency-response problems, but it does **not** isolate the xd's
output DAC or justify subtracting an assumed interface response from the synth.

The practical order of confidence is:

1. Forward-model plausible capture responses and report how fitted synth
   parameters move across those models.
2. Capture the same xd output simultaneously or successively through two
   interfaces. The synth output cancels in their ratio, revealing the relative
   input-chain response without asking either interface DAC to be ground truth.
3. Use a calibrated external signal generator when absolute ADC response is
   important. An interface loopback is a weaker fallback and must be labeled as
   combined DAC+ADC evidence.

The xd output stage is part of the audible instrument. When it cannot be
separated from the input chain, preserve that ambiguity and attach uncertainty;
do not silently “correct” it away. The current 40 Hz one-pole equivalent is a
useful cycle-scale model, not proof that the physical chain contains one pole.
