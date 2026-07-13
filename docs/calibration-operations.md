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

## Evidence lifecycle

All work under `calib/sessions/` is deliberately ignored. Most sessions are
exploratory and raw audio is large. A complete future calibration generation
uses this lifecycle:

1. Run fitting jobs. Repeat questionable domains and review their reports.
2. Freeze the candidate profile in `src/synths/xd/profiles.ts`, non-default,
   and declare the procedure that produced it (for example procedure R1).
   Predeclare its base and every predictable accepted-result path now—for
   example `calib/results/v5/eg-attack.json`. Lineage is part of the profile
   digest, so adding paths after verification would correctly invalidate it.
3. Promote the chosen fitting session with
   `calib evidence <session> --candidate-profile <id>`. This freezes the
   profile ID/content and procedure revision before validation data exists.
4. Run new verification jobs after that promotion, with raw values offset from the fitting grid.
   They must be new captures; where a model assumes pitch invariance, include
   another note or octave. Do not refit after seeing these results—if the model
   changes, retire the verification set and collect a fresh one.
5. Promote the verification session with `calib evidence`. Exploratory
   sessions remain ignored.
6. Run `calib verify`. The fitting and verification evidence directories must
   differ, coverage must be complete, the candidate must improve on the
   captured baseline, and its domain metric must meet the protocol threshold.
7. Run `calib accept --verification ...`, then review/commit the evidence,
   verification, and numeric result.
8. Run `calib validate-profile <id>`; it must pass before promotion.
9. Perform and archive the musical listening A/B before promoting the profile
   to the app default. This subjective promotion gate is deliberately manual;
   `calib accept` certifies measurement thresholds, not listening approval.

Current v1-v4 profiles are transitional dev-era rounds — measured while the
rig, extractor and models were still moving targets. They remain useful for
interactive A/B work but are not canonical evidence; the plan of record
(2026-07-12) is to re-run the full suite under procedure R1, land the results
as a fresh profile generation, then drop v1-v4.

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
