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
**Superseded 2026-07-11 by the full decode below.**

### 2026-07-11 · SAW SHAPE decoded: alternate teeth progressively run BACKWARD

Mean-cycle analysis at the true doubled period (40-cycle coherent averages, capture
AC-coupling inverted per harmonic; session 2026-07-10T08-03) shows the whole morph:
**every other tooth stays a pristine saw at every SHAPE value**; in the alternate tooth a
growing time-slice reverses direction — the ramp runs DOWNWARD at the same rate (with a
brief dwell at the entry), starting mid-tooth and expanding with SHAPE until the entire
alternate tooth is a falling saw. At SHAPE max the wave is exactly up-tooth/down-tooth:
measured half-wave antisymmetry — the 110/220 Hz lines vanish to literal zero while the
55 Hz odd series (55/165/275) carries everything, 165 Hz strongest. This is why pitch
reads an octave down at high SHAPE, and why NO same-period two-saw model (including the
replica's `saw(t) − g·saw(t+off)`) can reproduce it: mid-morph the wave simultaneously
shows fold-surviving double resets AND growing half-wave-antisymmetric content — only the
reversal explains both. Physical story: alternate-period current-steering into the ramp
integrator (the divider flips the charge direction over a SHAPE-set window). Proposed
replica model (tier-3, awaiting review): one saw core; on alternate periods reverse the
phase direction over a SHAPE-controlled window — osc.ts already has band-limited
backward-phase machinery from FM. Evidence page: the 2026-07-11 SHAPE artifact (all three
waves, gallery + fits).

### 2026-07-11 · TRI SHAPE is a SINGLE fold ending at an exact ×3 (tier-3)

New 17-point shape-tri session (2026-07-11T05-35). The triangle folds ONCE at each peak
(Matt's observation, confirmed): one shape parameter explains the sweep — fold drive g′
rises smoothly 1.0 → 3.0, the folded tip descends as tip = 2 − g′, crosses zero near
SHAPE 768, and at max touches the opposite fold level, where the waveform becomes a
perfect TRIPLE-frequency triangle: the SHAPE-1023 hardware capture is a pure 330 Hz tone
(note × 3; the harness's 29¢-spread point failure there was the tracker fighting nominal
110 — model-informed, not rig failure). Hard-reflection fits: 3–4% residual below
SHAPE 600, drifting to ~22% at high drive — the analog fold knee is SOFT; remodel as a
single fold with rounded knee. Output level at the fold ceiling tapers ~45% across the
sweep (part of the model — no loudness compensation in hardware). The replica's sine
folder (gain 1..8, multiple wraps) is structurally wrong.

### 2026-07-11 · SQR SHAPE: plain PWM at CONSTANT swing — no normalization, real DC

Duty measured by fitting constant-swing pulses (capture HPF in the loop) on the 08-06
session: 50.8/44.5/38.5/32.3/26.3/20.3/14.0/8.0% at the 9 sweep points — nearly the
replica's linear 0.5→0 guess, a couple of points wide mid-sweep (fit as a tier-2 table).
The structural finding is amplitude: the hardware pulse keeps a constant ±swing all the
way down (measured level ratio 1.00→0.91 across the sweep) where the replica
peak-normalizes (predicts 0.54 by SHAPE 896) AND subtracts the pulse DC analytically.
The real signal carries its DC (mean = (2d−1)·swing) through the VCF — biasing the
filter drive nonlinearity — and only loses it at the AC-coupled FX/output boundary that
dcblock.ts now models. Proposed change (tier-2, profile-gated so v0–v3 stay
bit-identical): drop peak normalization and analytic DC removal; land the measured duty
table.

### 2026-07-11 · Rig note: the capture chain's LF corner fits at ~40 Hz (1-pole equivalent)

Fitting the known plain-triangle bow gives a ~40 Hz single-pole equivalent for the
xd-output + ProFX coupling chain — higher than expected, likely two-plus real poles at
lower corners masquerading as one. It only matters when interpreting slow intra-cycle
slopes (mean-cycle "bowing"); steps, duty ratios, fold drives, and reset positions are
robust to it. All SHAPE model fits above ran with this HPF inside the loop, and displayed
traces invert it per harmonic (exact for periodic means). Full policy — how the corner
is fitted, why the sim must not replicate it, the monitor's de-bow toggle, and the
interface-change checklist — lives in hardware-calibration.md ("Capture-chain coupling").

### 2026-07-08 · VCO PITCH knob: Korg's documented table is not the analog response

`raw 356` sounds at ≈ −100¢, not the documented −256¢ — confirmed through BOTH the SysEx
dump path and the CC path (rules out harness encode bugs). Endpoints (±1200¢) match the
docs; the mid-range is ~0.39× shallower. Full 15-point measured table captured 2026-07-10
at ±0.1–0.4¢ per point; batch 2 re-measured with all-4-voice medians and the deltas repeat
within 0.2¢. DECIDED (2026-07-10, via calibration profiles): `pitchToCents` stays the
documented table for DISPLAY (what the hardware OLED shows), `vcoPitchCents` feeds the
ENGINE from the active profile. Measured tables are recentered so the dead-zone detent is
exactly 0 — the raw sweeps carry the unit's floating tuning offset (see drift entry below).

### 2026-07-10 · EG time curves are segmented, far from the guessed expMaps

Measured on the clean capture backend (see rig findings):

- Attack at knob-noon ≈ 420 ms rise vs the replica's 32 ms — over 10× slower; max ≈ 1.6 s
  rise (≈ 2.2 s displayed).
- Decay/release grow sub-exponentially through the range then explode over the last ~15%
  of knob travel (1.9 s → 5.9 s → 15.5 s over two steps).
- None of the three curves fit an expMap (fit residuals ~40–70%); all three land as
  tier-2 monotone tables. Attack's table validates at 0.8% held-out residual.

### 2026-07-10 · Filter cutoff is a TABLE, not an expMap (span ≈ 25 Hz – ~23 kHz)

Three independent sessions converge; held-out residual stayed 10–13% under every expMap
fit — a SYSTEMATIC taper deviation the family cannot express. DECIDED (Matt, 2026-07-10):
cutoff is a monotone table, like the EGs. Profile v3 carries the 4-strike session's
per-point corners, bias-corrected through the replica inversion (see the rig finding
below — raw measured corners must NOT be transplanted directly). The corrected taper is
S-shaped around the best expMap: low-mid corners sit below it, upper-mid above. Verified:
`compare --profile v3` collapses the fit session to 0.7% RMS (every point ≤ 2%) and the
two independent single-voice sessions to 5.4/6.1% — i.e. at the measured per-voice VCF
spread, which is the floor for single-voice captures. The raw-1023 corner is extrapolated
(~23 kHz, "wide open"): the max-raw point is the PSD-transfer reference and has no
transfer of its own.

### 2026-07-08 · Voice tuning spread is tighter than modeled

4-voice round-robin strikes spread ~1.3¢ on hardware vs ~3.3¢ in the replica — the drift
model's per-note offset (±1.5¢) is likely overdone. Full drift decomposition is protocol
D8.

### 2026-07-10 · Drift data gathered in passing (feeds D8 + the realism modes)

- **The whole-unit tuning offset floats**: with PITCH at the dead-zone detent the unit
  read +2.8¢ (morning session), +2.3¢, +2.2¢ (batch 2), +1.7¢ (late check) across one
  evening — warm-up / auto-tune state, riding on every voice equally. Belongs to the
  planned FULL drift-realism mode, never to a knob curve.
- **Per-voice VCF spread ≈ 3–6% mid-band**: first measurement, from batch 2's per-strike
  cutoff transfers (corners above ~370 Hz spread 2.2–6.1% across the four filters;
  low-raw spreads read higher but are inflated by LF fit noise). A per-voice filter
  offset is a real, measurable character component for the realism modes.

### 2026-07-10 · Batch 2: the rig's numbers repeat

Second full suite, independent captures hours apart: EG time tables agree with the first
round within a few % (attack held-out 0.38%), the pitch-law deltas within 0.2¢, cutoff
endpoints within ~7%. Session-to-session repeatability is now demonstrated at or below
each domain's fit residual — the residuals reflect the hardware and the curve family, not
capture noise.

### 2026-07-10 · The voice bus is AC-coupled into the FX board (INFERRED)

Found via the "Replicant xd" bug: RING of two hard-synced same-pitch saws is essentially
saw² — mean ≈ +⅓, real DC that the hardware's ring product carries too. On the real xd
that preset plays fine with reverb; in the replica the DC reached the reverb, whose FDN
loop amplified it ~5× (the damping filter is a lowpass — DC circulates; the Hadamard has a
+1 eigenvalue), and the output limiter flattened the mix to a rail. Conclusion: the
hardware must block DC between the analog voice bus and the digital FX — standard
capacitor coupling into the FX ADC. Replica now models it (src/dsp/dcblock.ts, 5 Hz corner
INFERRED — measurable someday via an LF sweep if it ever matters).

**Family audit (same date).** The other three synths share the vulnerability class
wherever an analog voice bus meets digital FX; all real hardware in the family AC-couples
that boundary, so each fix is faithful, not defensive:

- **og** — SYNC+RING saws parked ~+0.34 of DC on the output. The delay loop's own HPF
  (≥ 10 Hz) keeps the loop from running away, but the dry bus carried the pedestal
  straight toward the limiter knee. Fixed: DcBlock pair at the top of its processFx
  (tests/og-dcblock.test.ts).
- **prologue** — same-pitch RING (the exclusive switch has no sync, but both VCOs start
  in phase and drift apart only ~0.15 Hz at C2) railed the shared reverb exactly like the
  xd. The FX input here is the pair of per-timbre MAIN/SUB stereo buses composed inside
  processFx, so the coupling is one DcBlock per bus channel — four in all
  (tests/prologue-dcblock.test.ts).
- **monologue** — has the DC source (RING) but NO digital FX at all; DRIVE is analog and
  in-voice on hardware, so DC biasing it is faithful. No FX-ADC boundary exists → no
  DcBlock; the ring DC legitimately reaches the output (bounded, ~+0.16, well inside the
  limiter's linear region), as it rides the hardware's analog bus to the output jack.
  Audit pinned by tests/mono-dcblock.test.ts.

### 2026-07-11 · v4: the SHAPE models implemented, fitted, and verified

The three approved models landed in osc.ts behind profile v4 (legacy paths proven
byte-identical vs HEAD for og/mono/prologue and xd v0–v3, including sync/reset/reverse-FM).
The D2 pipeline (tools/calib/lib/measure-shape.ts) extracts 2-period mean cycles as
features for `vco.shape` jobs and fits model parameters with the capture coupling in the
loop; proposals emit the parameter tables directly. Fitted v4 tables from the existing
sessions; verification (replica-v4 vs hardware mean cycles, per point):

- **Round-trip**: replica-v4 renders re-measured by the pipeline recover the v4 tables
  essentially exactly (duty ±0.005, g′ ±0.01, m/phi ±0.01) — implementation ≡ measurement.
- **SQR**: hw-vs-replica waveform residual 10–13% across the sweep (v3 legacy: 13–38%);
  that floor is grid + edge-slew, i.e. converged.
- **TRI**: 6–21% (v3: up to 100%). Knee fitted at r = 0.30 but weakly identified
  (flat basin 0.3–0.4); the residual growth toward high drive (~20%) is fold fine
  structure the single-soft-fold doesn't carry — second-order, open.
- **SAW**: 18–25% at high shape and exact structural endpoints (v3: 90–100%, i.e.
  uncorrelated); mid-morph 50–70% — the chopper reproduces the period-doubling and
  polarity structure but not the entry dwell / reversed-slope detail. THE open D2 item;
  candidates: a denser shape-saw sweep + a reversal-window generator variant.

Jobs: shape-saw re-enabled (the reference model finally matches reality), and shape jobs
gained `features.nominalRatios` — the pitch gate accepts the morphs' legitimate
fundamental moves (SAW ×½, TRI ×3), so the old "mid-morph false failures" class is gone.
v4 is NOT the default pending Matt's listening A/B.

### 2026-07-11 · SYNC/RING polarity: the spec's "inverted" claims are ERRATA (Matt's catch)

Matt: "you have the ring switch inverted — init program shows ring on." Hardware truth
table (encoder-free byte-probe: Korg's own Init Program blob from his dump as the
container, single-byte edits, FFT-peak readout; VCO2 solo detuned so ring's inharmonic
sidebands at f1±f2 are unmistakable):

- byte 34 = SYNC, **0 = OFF / 1 = ON** (TABLE 2's "0,1=SYNC ON, SYNC OFF" legend is a doc
  erratum, like the 336-byte payload line); byte 35 = RING, same normal polarity.
- CC80/81 are ALSO normal polarity — spec §15's "inverted receive" is equally wrong
  (CC81=127 rings, CC81=0 doesn't).
- VCO2 PITCH (bytes 30/31 LE) and OCTAVE (29) map correctly — earlier probe anomalies
  were entirely the panel-impossible (sync,ring)=(1,1)-bytes state our inverted encoder
  had been pushing (harmless historically: every calibration job muted VCO2). That state
  makes the hardware produce strange 55 Hz-odd content — firmware behavior for a combo
  the panel can't express; never push it.

Fixed in progbin.ts (decode+encode), cc.ts, and calib ccmap.ts; test pins updated.
**Consequences:** every imported preset stored as (0,0) — most of the bank, including
"Replicant xd" — had been playing with ring+sync wrongly ENGAGED in the replica.
Replicant is actually a plain detuned two-saw pad. The replica-side DC chain in the
Replicant bug (ring product → reverb FDN → limiter rail) was real, but the preset never
asked for ring — so "hardware plays this RING patch fine ⇒ hardware AC-couples the FX
input" loses its evidence. The DcBlocks stay (they cure a real failure mode whenever
ring IS engaged, and coupling remains physically plausible) but their provenance drops
to INFERRED-defensive; the D9 behavioral A/B is now the only path to establishing the
hardware's actual coupling. This also closes the last of Matt's "VCO2 looks weird"
report: every preset was ringing/syncing when it shouldn't.

### 2026-07-11 · SAW morph SOLVED: the reversal-mirror model (1 parameter)

Dense 33-point sweep (2026-07-11T07-09) + model search: the SAW SHAPE morph is a
TIME-MIRROR — in doubled-period phase the wave is saw(Φ) except saw(2−Φ) inside a window
±w·T centered on the alternate tooth boundary (the ramp retraces itself through the
suppressed reset). w(shape) ≈ shape/2, linear within ±0.011, saturating at 0.5 by
raw ≈ 992. w=0 is exactly the plain saw; w=0.5 is the measured half-wave-antisymmetric
octave-down endpoint (the earlier chopper's two exact endpoints, now with the middle
right too). Mid-morph waveform residuals: 17–24% analytic / 16–29% through the engine
(chopper was 47–70%); the remainder is the rig's edge-smear floor (~8–10%, same as the
converged SQR fits). Corrections to the earlier decode entry: the window is CENTERED on
the tooth boundary (not "starting mid-tooth"), and the entry drop + dwell are emergent
from the mirror, not separate features. v4's sawChopDepth/Phase replaced by the fitted
33-knot sawMirrorW table; osc.ts sawMirrorSample (wrap + interior edges polyBLEP'd,
step math taken from the naive form so w→0 degrades exactly into the plain saw);
raw-544's capture was weak — re-measure that knot someday.

### 2026-07-12 · EG release/decay tails are FASTER-than-exponential — long windows required (Matt's catch)

Matt watched the scope during the R1 eg-release run and suspected the captures were
cutting the tails off. A 40 s single-point probe (raw 1023, session
2026-07-13T04-33-eg-release-tail-probe) settled it: the tail's local slope steadily
ACCELERATES — ≈−1.2 dB/s just after note-off, −2.1 dB/s at 10 s, −5.8 dB/s at 18 s,
reaching the rig floor (−54.5 dB re held) at ~20 s. That is not a one-pole exponential
(constant dB/s); the xd's envelope reaches true silence in finite time. Consequence:
a 12 s capture sees only the shallow early slope (−19 dB at window end) and the
exponential extrapolation OVER-estimates long releases — 16.3 s fitted in the 12 s
window vs 11.8 s with the full fall in view. July's v1/v2 EG tables carry the same
bias class at their top knots. Fix: eg-decay holds the note 22 s and eg-release
captures 22 s, so every point's fall reaches the −40 dB fit floor inside the window;
R1 tables come from those. Open item (future EG-shape work): the replica's EG segment
law is exponential — matching the measured accelerating-slope curve is a model change,
tier-3, and the extractor's single-τ value is only comparable across worlds when both
are measured through the same full-fall window.

### 2026-07-12 · R1 re-baseline session: two systematic point outcomes (retry-confirmed)

Both reproduced identically across two independent captures, so they are properties of
the measurement, not transients: (a) cutoff=960 measures but yields no usable corner
(top-end extraction limitation; the R1 cutoff table spans 0–896 plus the usable 1023
knot); (b) shape-sqr raw 1023 finds NO onset — the SQR duty genuinely reaches silence
(the 2026-07-08 finding, now visible at onset level; the July "success" at this point
was an onset fluke on the noise floor). The silent capture IS the duty-0 evidence; the
R1 sqrDuty table pins [1023, 0] with this note.

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

### 2026-07-12 · Capture windows are frame-counted, not wall-clock — device startup latency varies per plug session

The R1 session opened with every job failing its 1 s silence pre-check while `calib
check` passed: calib-rec timed the recording as a wall-clock window from engine start,
and this ProFX plug session has ~105 ms of startup latency before the first buffer, so
1 s captures deterministically delivered 42,947/48,000 frames — just under the 90%
length gate — while 3 s captures absorbed it. Device HAL IDs and startup latency both
change across replug sessions (a days-old orphaned `calib-rec stream` was also found
holding the pre-replug device ID; kill such orphans). The helper now records until the
requested FRAME COUNT arrives (wall-clock cap only as a wedge guard), making capture
length latency-proof. Corollary: after replugging the interface, expect a different
HAL ID (resolve by name, never cache the number) and re-run `calib check` first.

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

### 2026-07-10 · Measured values must be inverted through the replica before landing in a profile

Found while building the v3 cutoff table. The corner extractor has a large, smooth,
value-dependent bias: rendering the replica at a KNOWN 16 Hz corner measures 27 Hz
(+70%); a known 1.4 kHz corner measures 1.26 kHz (−12%) — reference-rolloff division,
critically-damped shape, and LF fit inflation. Because hardware and replica share the
extractor, the bias cancels in every COMPARISON — but transplanting hardware-measured
values into a profile bakes the bias in: a table through the raw measured corners
"passed through every point" yet left `compare` at ~12% RMS with point-dependent sign.
Fix: analysis-by-synthesis inversion (`domains.ts biasCorrectCorners`) — the replica
renders of the same session sample the bias curve (known true law vs measured), and
evaluating it at each hardware-measured value recovers the true hardware value. Cutoff
collapsed 13% → 0.7% RMS. Corollary: some share of the EG tables' ~11% held-out
residuals may be the same effect (the envelope follower has its own floor and shape
bias) — v1/v2 EG knots are raw measured values. Candidate v4: re-derive the EG tables
from the existing session data with the same inversion. Lesson: a shared extractor
makes comparisons unbiased, not measurements.

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
