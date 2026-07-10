# Calibration findings log

Dated, evidence-backed findings from the hardware-calibration rig — both about the
minilogue xd itself and about the rig. Companion to
[hardware-calibration.md](hardware-calibration.md) (architecture/policy) and
[calibration-protocol.md](calibration-protocol.md) (methods). Findings about the xd feed
xd-spec.md + engine changes after review; findings about the rig are permanent operating
lessons.

## Hardware findings (minilogue xd, unit: Matt's, all pending review before code changes)

### 2026-07-08 · SQR SHAPE reaches silence at maximum

At `vco1Shape = 1023` the square's output is silent (confirmed 4× across sessions): the
pulse width narrows all the way to 0%. The replica floors at 5% (`osc.ts`). Tier-1 constant
change after review. The PW curve over the rest of the range is measurable and clean
(SHAPE 256–896 captured at ±0.8¢).

### 2026-07-08 · SAW SHAPE period-doubles (structural, tier-3)

The hardware SAW morph produces **alternating tall/short teeth** — consecutive cycles
alternate peak amplitude exactly (measured 0.040/0.023 per-cycle peaks), putting a true
sub-octave fundamental (f0/2) under the note. The replica's morph (subtract a half-period-
shifted second saw) keeps a single period — structurally different. Requires an xd-spec.md
model decision, then an osc.ts redesign; SHAPE fits are parked until then. Mid-morph points
also confuse harmonic-tracking measurement (expected until remodeled).

### 2026-07-08 · VCO PITCH knob: Korg's documented table is not the analog response

`raw 356` sounds at ≈ −100¢, not the documented −256¢ — confirmed through BOTH the SysEx
dump path and the CC path (rules out harness encode bugs). Endpoints (±1200¢) match the
docs; the mid-range is ~0.39× shallower. Full 15-point measured table captured 2026-07-10
at ±0.1–0.4¢ per point. Open design question: engine uses the measured curve, display
keeps Korg's official numbers (what the hardware OLED itself presumably shows).

### 2026-07-10 · EG time curves are segmented, far from the guessed expMaps

Measured on the clean capture backend (see rig findings):

- Attack at knob-noon ≈ 420 ms rise vs the replica's 32 ms — over 10× slower; max ≈ 1.6 s
  rise (≈ 2.2 s displayed).
- Decay/release grow sub-exponentially through the range then explode over the last ~15%
  of knob travel (1.9 s → 5.9 s → 15.5 s over two steps).
- None of the three curves fit an expMap (fit residuals ~40–70%); all three land as
  tier-2 monotone tables. Attack's table validates at 0.8% held-out residual.

### 2026-07-10 · Filter cutoff span ≈ 25 Hz – 17 kHz

`expMap(raw, 24.7, 16900)` vs the guessed `expMap(raw, 16, 21000)`; held-out residual
13%, so mild taper deviation remains — acceptable as expMap, revisit if the residual
matters downstream.

### 2026-07-08 · Voice tuning spread is tighter than modeled

4-voice round-robin strikes spread ~1.3¢ on hardware vs ~3.3¢ in the replica — the drift
model's per-note offset (±1.5¢) is likely overdone. Full drift decomposition is protocol
D8.

## Rig findings (permanent operating lessons)

### 2026-07-10 · ffmpeg's avfoundation input silently drops audio chunks — never capture through it

The big one. Symptoms accumulated for days under different disguises: "48 kHz USB
corruption", "analog jitter" false-positive storms, visible glitches in the live scope on
a *digital* source. Root cause: ffmpeg's avfoundation capture drops small chunks of the
stream (measured up to ~7 losses/s; the rate varies with system conditions, which is what
made it look device- and rate-dependent on different days).

Proof chain (the method matters as much as the result):

1. **Quartz reference**: the xd's digital VPM Sin1 is crystal-clocked — any pitch wander
   or phase jump in its capture is rig corruption by definition. (The rig had no
   ground-truth source until this; median-pitch checks are blind to splices.)
2. **Dual-clock capture**: the same tone recorded simultaneously via the ProFX (ffmpeg)
   and the MacBook mic showed 440.00 Hz stable acoustically while the ffmpeg capture
   smeared — exonerating the synth.
3. **Backend A/B**: AVAudioEngine (CoreAudio-native) on the same device, cable, and
   moment: pitch sd 0.007¢, zero phase jumps, zero curvature spikes. ffmpeg in the same
   conditions: 40+ discontinuities with sample-level waveform teleports.

Fix: `tools/calib/native/calib-rec.swift` (AVAudioEngine tap + AVAudioConverter SRC,
compiled on demand) behind unchanged `capture.ts` APIs. `calib check` step 8 ("quartz
integrity": Sin1 capture must show ≤2 phase jumps, <0.3¢ sd) makes this failure class a
one-line diagnosis forever.

Corollaries: the earlier "ProFX must stay at 44.1 kHz" rule was diagnosing ffmpeg, not the
device — retested through the clean backend the same day: **48 kHz native is byte-clean**
(quartz sd 0.006¢, zero jumps, three consecutive check runs), so the rig now runs 48 kHz
with no conversion step. The phase-jump detector was correct every time it fired; the
2026-07-10 afternoon's "analog jitter" reinterpretation (and the loosened gate that came
with it) was wrong.

**Measurement generations**: only trust measurements from capture generation 2 (the
CoreAudio helper, 2026-07-10 onward). Generation-1 (ffmpeg) sessions were deleted; the
three early hardware findings above were re-confirmed on generation 2 (SQR silence and the
SAW 165 Hz locks reproduce in the clean suite; the pitch table was re-measured at
±0.1–0.4¢ per point).

### 2026-07-10 · Two transient failure modes, both retried automatically now

- CoreAudio occasionally under-delivers a fresh capture (seen right after device rate
  changes): the helper counts frames and reports "short capture"; recordWav retries once.
- The xd occasionally ignores a SysEx dump request (~1 in 10 under rapid traffic):
  requestDump retries once before failing.

### 2026-07-10 · Failed sweep points must be findings, not gaps (Matt's catch)

Points that failed both in-run attempts used to exist only as scrolled-past console lines
and red monitor rows: features.json and report.md recorded successes only, so a failed
point silently thinned the downstream fit — nobody reviewing a proposal could tell 15
planned points from 13 survivors. Matt noticed the failures before the operator did.
Fixed structurally, so missing data is as loud as bad data:

- **End-of-run recovery pass**: failed points get one more full attempt (fresh patch push,
  capture to a `-retry` WAV — the failed capture is kept for forensics) after the sweep
  finishes, since transient corruption often clears; skipped when every point failed
  (systemic, not transient).
- **features.json** records `planned` and `pointFailures` (label, raw, error) permanently;
  the monitor's history view renders them red and flags the session in its list.
- **report.md** opens with a `⚠ FAILED POINTS` section above everything else.
- **Every proposal** carries a `coverage: N/M planned points — MISSING …` note, so a
  thinned fit can't pass review unnoticed.
- **`run all`** ends with a per-job suite summary; any failed point fails the job line.

### 2026-07-10 · SAW morph sessions look broken but aren't — job disabled until the D2 remodel

Batch-2 SAW sessions confused everyone (including the operator): mid-morph points fail the
phase-jump gate (the alternating-teeth structure reads as phase steps — false corruption
flags), upper points measure f0 = 55.00 Hz ±0.3¢ (the true period-doubled fundamental,
reported as "−1200¢ vs replica"), and the waveform thumbnails render misleadingly because
the zero-cross-centered trigger has multiple crossings per doubled cycle to choose from.
None of that is rig failure and none of it is fittable against the current replica model —
the comparison is apples-to-oranges by construction until the tier-3 SAW remodel lands, so
the job is `disabled` with a pointer here. The captured data (locked 55 Hz fundamental,
per-point ladders) is exactly the evidence the remodel needs. Lesson: a measurement whose
reference model is known-wrong produces reports that look like malfunctions — park the job,
don't keep re-running it.

- **Validate detectors against a reference source, not just replica renders.** The
  phase-jump detector was tuned on synthetic signals and replica audio; when real captures
  disagreed with expectations, the temptation was to distrust the detector. The quartz
  source settled who was right.
- **Robust statistics hide corruption.** Median pitch over strikes survived heavy splice
  damage, which let a corrupt rig pass every early health check. Integrity checks must be
  phase/continuity-sensitive, not just value-accurate.
- **Fit-quality numbers are alarms, not formalities.** The 196% cutoff residual (one
  railed corner poisoning a least-squares fit) and the 68% EG residuals (wrong curve
  family) both pointed at real problems before any human noticed.
