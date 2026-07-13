# Calibration measurement protocol

Procedure: `xd-hardware-calibration R1` (revision 1). Profile versions and
procedure revisions are separate timelines: a future synth profile should say,
for example, “profile vN, produced with procedure R1.” R1 is the first numbered
procedure — the suite as it stands: canonical evidence, independent off-grid
verification, explicit acceptance gates, and structured unit/session metadata.
The dev-era rounds that produced profiles v1–v4 predate procedure numbering and
carry no tag; the plan of record (2026-07-12) is to re-run the full suite under
R1, land the results as a fresh profile generation, then drop v1–v4.

The per-domain measurement methodology behind [hardware-calibration.md](hardware-calibration.md)
(read that first: parameter tiers, provenance, rig architecture, milestones). Each domain below
maps to one or more harness job specs (`tools/calib/jobs/*.json`). Written 2026-07-06, before the
harness exists; expect the harness to refine dwell times and thresholds against reality, and this
doc to be updated when it does.

Ground rules assumed throughout:

- Every domain starts from a **full patch pushed over SysEx** and verified by read-back — never
  panel state. Only the swept parameter then moves, via CC staircase.
- 48 kHz stereo line-in capture; all timing is onset-relative (no clock sync).
- The **identical feature-extraction code** runs on the hardware capture and on an offline
  replica render of the same event stream. Extractor quirks bias both sides equally; only real
  differences survive.
- Fits are plain TS: linear least squares in a transformed domain (log for `expMap` endpoints,
  log-log for power tapers), analysis-by-synthesis coordinate descent for curve shapes, monotone
  (Fritsch–Carlson) tables when a parametric fit's residual is too large to trust.
- Sweep values are chosen at **zone/step centers**, never zone edges.

## Shared primitives (built once, every domain reuses them)

1. **Phase tracker** — the pitch primitive. Complex Goertzel (extend `goertzel()` to return the
   complex correlate) at a known nominal frequency, Hann 46 ms frames, 5 ms hop; instantaneous
   frequency = f_nom + Δφ_unwrapped/(2π·hop). Precision at SNR ≥ 50 dB: well under ±0.05 cents.
   Track a *harmonic* (4×–8× f0) when resolution matters — cents are invariant, phase precision
   scales with frequency. Coarse-lock first via FFT peak + quadratic interpolation when the true
   frequency may sit > ±30 cents from nominal.
2. **Sweep tracker** — for glides and large pitch modulations the single bin can't follow: STFT
   ridge track (2048-pt FFT, hop 256, parabolic peak interpolation around the strongest expected
   partial). ~±2 cents, tracks anything.
3. **Harmonic ladder** — measure f̂0 with the phase tracker, then Hann-windowed Goertzel at k·f̂0,
   k = 1..min(32, ⌊20 kHz/f0⌋), five 100 ms windows averaged, output in dB relative to k=1.
   Re-estimating f̂0 per capture is mandatory: 3 cents of drift at k=32 is a whole bin.
4. **PSD transfer** — Welch PSD (8192-pt Hann, 50 % overlap) of a filtered-noise capture divided
   by a reference capture of the same noise unfiltered → |H(f)|².
5. **Tone envelope** — complex-Goertzel magnitude at f̂0, 5 ms window / 1 ms hop: a tone-locked
   amplitude envelope immune to broadband noise. Plus plain 2 ms RMS frames for broadband stimuli.
6. **Energy decay curve** — Schroeder backward integration of x², line fit on −5..−35 dB
   (T30 → RT60).
7. **Analysis-by-synthesis fitter** — render the replica module offline over a parameter grid,
   compute the identical feature, coordinate-descent to the least-squares minimum. The fit engine
   for every tier-2 curve-shape question; automatically accounts for replica-side coloration
   (VCO edge softness, filter oversampling) because the replica render passes through the same
   feature code.
8. **Drift-resistant pitch protocol** — (a) prefer **held-note CC staircases**: one note held on
   one voice while the swept CC steps, so the ±1.5¢ per-note offset is drawn once and round-robin
   voice cycling (xd-spec §16) can't mix four VCOs into one curve; (b) return the knob to a
   reference detent every 4 steps and de-trend against the reference re-measurements (cancels the
   ±2.5¢ walk); (c) 3 passes, each a fresh note (fresh voice + offset), per-step medians.

## Pre-flight (once per session, ~15 min, overlaps warm-up)

Runs after `calib check` (the rig smoke test — see hardware-calibration.md).

- Power the xd, warm ≥ 10 min (steady-state-only policy). Run onboard auto-tune once after
  warm-up, then never again mid-session.
- **Loopback**: interface out → in, chirp; confirms flat response, noise floor, and the constant
  absolute I/O latency used by predelay/echo timing.
- **Headroom linearity**: one note at Program Level −18/−12/−6/0 dB; captured RMS must step
  exactly 6 dB. Establishes whether the xd's output stage limits (the replica has a soft limiter;
  the hardware may not). Set master volume so peaks sit ≈ −12 dBFS and stay in the verified-linear
  region for everything except deliberate drive tests.
- **CC settle time**: step CUTOFF hard while noise sounds; measure how long the response takes to
  settle (hardware smoothing). Sets the staircase dwell (assume 150 ms until measured).
- **Sin1 purity check**: MULTI VPM Sin1, SHAPE 0, SHIFT+SHAPE center — harmonic ladder must show
  a pure sine (k ≥ 2 below −50 dB). Domains 4, 5, 6, 9 use this as their clean stimulus.
- **FX-off leakage**: staccato note, all FX off; assert no tail energy after the dry decay.

---

## D1 — VCO pitch: knob curve, octaves, portamento (~25 min)

**Base patch**: VCO1 SAW SHAPE 0 only (VCO2 + MULTI levels 0); SYNC/RING/CROSS off; cutoff 1023,
res 0, drive 0, keytrack 0; EG INT centered (492–532); LFO INT 512; AMP A=0 S=1023 R short;
portamento 0; POLY; FX off; Program Level 0 dB.

**Stimulus & features**

- *Tuning reference / note map*: A2, A3, A4 each struck 4× (one per round-robin voice), 1.5 s;
  phase tracker on harmonic 4, median of the middle 1 s. Median across voices = the session
  reference (per-voice offsets feed D8). All later measurements are **relative to this reference**
  — absolute error vs 440 conflates master tune and ADC clock ppm (~0.03¢, constant).
- *PITCH knob curve*: hold A3; CC34 staircase over 21 points clustered at the documented MIDIimp
  breakpoints {0, 4, 8, 100, 200, 356, 400, 476, 484, 492, 512, 532, 540, 548, 600, 668, 800,
  900, 1000, 1020, 1023}; 150 ms settle + 500 ms measure per step; re-zero to 512 every 4 steps;
  3 passes; FFT coarse + phase-tracker fine (`pitchToCents` seeds the search).
- *Octave switches*: VCO OCTAVE 0..3 and master OCTAVE ±2 at one note; expect exact powers of 2.
- *Portamento*: PORTAMENTO ∈ {1, 16, 32, 64, 96, 127}; legato A2→A3 ×3; A2→A4 at 64
  (constant-time vs constant-rate discriminator); detached A2,A3 at 64 in Auto mode (expect no
  glide) and in On mode; one run with Portamento BPM on at two tempi. Feature: STFT ridge; glide
  time = 10 %→90 % of the cents span; shape classified by comparing linear-in-cents vs
  exponential-in-Hz trajectory fits.

**Fit**: the pitch table is DOCUMENTED-exact — *verify*, flag any segment off > 3¢ rather than
refit. Portamento: least squares on log(time) vs raw against `portamentoToSec`'s exp form; the
interval test decides seconds (constant-time) vs cents/sec (constant-rate); trajectory shape is
tier-2.

**Pitfalls**: round-robin voice cycling (held-note staircase + 4-strike repeats); drift walk
(re-zero de-trending); trust ratios, not absolute cents; glides break the single-bin tracker
(use the ridge); Auto-mode "no glide when detached" is correct behavior, not a broken measurement.

## D2 — VCO SHAPE transfer per wave (~15 min)

**Base patch**: as D1; one wave at a time; note A2 (110 Hz → ≥32 clean harmonics in band).

**Stimulus**: hold A2; SHAPE (CC36) staircase, 17 points on the 64-step grid, 600 ms per step,
3 passes per wave. One extra single pass at A4 (pitch-invariance of the shaper).

**Features**: harmonic ladder per step; broadband RMS per step (the replica RMS-normalizes the
SAW morph — the hardware may not; level-vs-SHAPE matters for mix balance).

**Fit** (per wave, tier-2):

- *SQR*: pulse duty d from the |sin(πkd)| harmonic pattern, least squares over k on log
  magnitudes. Deliverable: d(raw) — specifically d(0) (exactly 50 %?) and d(1023) (replica
  guesses 5 %). Replace the `pw = 0.5 − 0.45·shape` constants or emit a table.
- *SAW*: model ladder a_k ∝ (1/k)·|1 − g·e^(−i2πk·off)|; fit (g, off) per step by
  analysis-by-synthesis against the replica osc. Deliverables: g(raw), off(raw). If median
  residual > ~2 dB the hardware morph is a different topology → emit the normalized ladder table
  per step and flag structural (tier-3 review).
- *TRI*: fit (blend m, foldGain) of the sine-folder by analysis-by-synthesis on the odd-harmonic
  ladder; report any even-harmonic content (asymmetric fold ⇒ structural).

**Pitfalls**: f̂0 re-estimation per capture is non-negotiable (harmonic-k drift scaling); analog
hardware doesn't alias but cap the ladder below ~20 kHz where the interface and VCO edge-softness
roll off; ladders must be compared through replica renders so the replica's top-end LP is inside
the loop, not a bias.

## D3 — MULTI: NOISE Peak + VPM voicings (~35 min)

**Base patch**: MULTI only (VCO levels 0), Multi Routing Pre VCF, cutoff 1023, res 0, FX off.

**NOISE Peak** (~10 min): notes C1..C7, 3 s each, SHAPE 0 (110 Hz bandwidth → sharpest peak);
C4 repeated at SHAPE {512, 1023} for the bandwidth law; 3 SHIFT+SHAPE values at C4 (function on
Peak is undocumented — pure discovery). Feature: Welch PSD; fit a 2nd-order bandpass magnitude in
log-log around the peak → (center, bandwidth) jointly (far stabler than peak-picking). Fit:
log(center) vs log(note Hz) → keytrack slope + ratio (replica guess: 4×). Bandwidth vs SHAPE:
verify documented 110–880 Hz + taper (5 points). Also 5-point −3 dB spot checks of NOISE
High/Low cutoff spans via PSD transfer against a High/SHAPE 0 reference.

**VPM** (~25 min): A3, 2.5 s per capture. Per type (16): SHAPE {0, 1023} at the neutral
SHIFT+SHAPE detent; SHIFT+SHAPE at its 5 zone centers for 3 representative types (checks the
replica's ×¼..×4 zone reading); SHAPE 5-point sweeps for Sin1/Saw1/Fat1/Decay1 (mod-index
range). Features: FFT peak table (all peaks ≥ floor + 20 dB; frequency by parabolic
interpolation) → sideband spacing gives the modulator ratio directly; Goertzel at the
replica-predicted sideband set scores the hypothesis. Decay1/2: STFT sideband-energy-vs-time →
exp fit → internal mod-EG decay constant. Fit: per type, analysis-by-synthesis over (ratio
multiplier, index scale, feedback) against the replica `multiengine`, matched on the top-20 peak
set. Ratio and index are well-identified; feedback shows mostly as spectral skirt — accept a
coarse estimate. **Creep/Throat (atonal, evolving) and Air character: report-only** (archived
spectrograms).

**Pitfalls**: noise stimuli need ≥ 3 s of averaging; VPM sidebands can alias in the *replica*
render (not the hardware) — compare only below 20 kHz; SHIFT+SHAPE zone edges may not match the
replica's table (record zone centers; probe edges only on the 3 representative types).

## D4 — Filter (~20 min)

**Broadband source**: MULTI NOISE **High, SHAPE 0** (10 Hz HPF ≈ full-band white), Pre VCF —
the robust in-instrument broadband stimulus; the VCO comb is too sparse for corner-finding.
Reference capture at cutoff 1023 / res 0 is the PSD-transfer denominator (also divides out the
noise generator's own spectrum — re-verified each session).

**Base patch**: MULTI High SHAPE 0 only; res 0; drive 0; keytrack 0; EG INT centered; AMP organ
(A0, S max); FX off; Program Level −6 dB (resonance headroom).

1. *Cutoff taper*: 17-point staircase, 3 s noise per point (5 s + 16384-pt FFT below raw 300 for
   LF resolution). Feature: PSD transfer → −3 dB point interpolated in log-f; fitted 2-pole
   magnitude confirms the 12 dB/oct slope. Top 1–2 points with corners beyond ~20 kHz: fit the
   2-pole shape to the visible rolloff, report lower-bounded. Fit: least squares on log(fc) vs
   raw → `expMap` endpoints (replica: 16..21000); residual > ~5 % anywhere → monotone table.
2. *Self-oscillation probe*: res 1023, all source levels 0, note held (VCA open). If a sine
   appears, its frequency is a cents-accurate cutoff readout → run a fast secondary cutoff
   staircase on the self-osc tone (phase tracker) to cross-check the noise-derived taper. If not:
   ping (5 ms noise burst via fast AD) → ring frequency + Q from the complex-Goertzel ring-down.
3. *Resonance taper*: cutoff ≈ raw 600, res staircase 17 × 3 s noise. Feature: fitted resonant
   2-pole magnitude → Q per step → damping k = 1/Q. Fit the composed map raw→k against
   `resonanceTo01` (pow 1.1) + `kMin/kMax/resCurve`, kMax pinned by the res 0 measurement;
   monotone table fallback.
4. *Bass interaction*: from the same captures, 40–200 Hz band level vs res → `bassComp`
   (and verifies `resLoss = 0` on the xd).
5. *DRIVE*: source VPM Sin1, A2, cutoff max, res 0. Drive {0, 50, 100} × MULTI level
   {341, 682, 1023}: harmonic ladder k = 1..15. Fit: analysis-by-synthesis against the replica
   tanh stage jointly across levels → `driveGains`; output RMS ratios → `driveMakeups`. One
   extra capture (drive 100, res high, noise) → hump compression vs drive 0 — confirms
   pre-filter placement (structural check only).
6. *Keytrack*: keytrack {50 %, 100 %}, cutoff mid, notes C2/C4/C6, noise source → −3 dB per note
   → oct-per-oct slope + center.

**Pitfalls**: at high res the hump dominates — fit the parametric magnitude, don't read −3 dB
naively; low-cutoff points collide with the interface LF corner (bounded in loopback); resonance
distortion can hit the output stage (hence −6 dB program level).

## D5 — Envelopes (~25 min)

**Base patch**: VCO1 SAW A3, filter open, res 0, EG INT centered, LFO INT 512, FX off, fixed
velocity 100, Amp/EG Velocity 0 in the patch.

- *Attack*: S=1023, D≈0; A staircase 17 points; note per step, capture to plateau + 0.3 s.
  Feature: tone envelope; attack = 10 %→90 %; segment law classified linear-in-amplitude vs
  exponential on the normalized rise (spec says digital EGs, near-linear — confirm; `dsp/eg.ts`
  segment shape must match).
- *Decay*: A=0, S=0; D staircase 17 points. If the law is linear-in-dB (exponential), fit the dB
  slope on the first 2–3 s and extrapolate — no 12 s waits; verify raw 1023 once with a full
  ~15 s capture (tests the "10+ s UNCONFIRMED" maximum).
- *Sustain*: 9 points, plateau RMS ratio to S=1023 → level taper.
- *Release*: from S=1023 plateau, note-off; 17 points, same slope-extrapolation trick.
- *Mod EG (A/D)*: EG TARGET PITCH, INT ≈ +200¢ (small, trackable), source VPM Sin1; A and D
  staircases 9 points via STFT ridge on the pitch trajectory. *Decay-after-release*: 100 ms note,
  D = 2 s — trajectory must keep decaying past note-off (confirm + measure).
- *Retrigger (the decisive experiment)*: UNISON, EG Legato OFF, AMP A ≈ 1 s, S=1023. Hold A;
  300 ms in (~30 % risen), strike B legato. Feature: 2 ms RMS envelope at the B onset —
  restart-from-zero shows a dip toward silence; restart-from-current continues monotonically.
  Repeat with EG Legato ON (expect no retrigger); repeat watching the *mod* EG via small
  EG→pitch INT (pitch snaps to attack start vs continues). 3 trials each. Resolves xd-spec §8's
  UNCONFIRMED "restarts from zero" against the replica's restart-from-current — tier-3 if they
  disagree.

**Fit**: `attackToSec`/`decayToSec`/`releaseToSec` expMap endpoints (log-linear); segment law and
retrigger semantics are tier-2/3 report items.

**Pitfalls**: release tails bleeding into the next step (gap until −80 dB); millisecond-scale
minimum times are limited by envelope-follower resolution — 1 ms-hop tone envelope minus the
loopback-measured system rise.

## D6 — Mod depths + LFO rate curve (~30 min)

**Base patch**: source VPM Sin1 (every trajectory is one clean ridge), filter open unless cutoff
is the target, FX off. Keep LFO INT at exactly 512 in every *other* domain — a 1-count offset is
an audible wobble at these depth scales. 1-SHOT off.

- *EG→pitch max*: EG TARGET PITCH, mod-EG A 100 ms, D 1 s; INT ∈ {+100 %, raws 700/900/300 for
  the quadratic-law spot check}; note A4 for +, A5 for −. STFT ridge → peak deviation at attack
  end. Fit: `EG_MAX_PITCH_CENTS` = deviation/percent (median of 3); verify documented
  `egIntToPercent` on the intermediate points. (+4800¢ at A4 → 7040 Hz: in band.)
- *EG→cutoff max*: unmeasurable at full INT (10 guessed octaves exits the audio band).
  **Small-signal slope method**: res high (sharp hump), low-level noise added, cutoff ≈ raw 400;
  INT at raws {550, 600, 700, 800} (≈ +0.4..+8 %); STFT hump-ridge → octave shift per capture;
  fit octaves-per-percent through zero; extrapolate → `EG_MAX_CUTOFF_OCTAVES`.
- *LFO→pitch max*: LFO TRI 0.5 Hz, target PITCH, INT 1023 then 0 (= −511): ridge, half
  peak-to-peak cents → `LFO_MAX_PITCH_CENTS`.
- *LFO→cutoff max*: same hump-tracking slope method, INT stepped near center →
  `LFO_MAX_CUTOFF_OCTAVES`.
- *LFO→shape*: source VCO1 SQR (SHAPE mid), target SHAPE, slow rate: sliding harmonic ladder →
  PW(t) via the |sin(πkd)| inversion (D2) → PW swing per INT step → `LFO_MAX_SHAPE` in knob units.
- *LFO rate curve*: LFO→pitch small depth on the sine; RATE staircase 17 points. Ridge → pitch
  trajectory; rate = dominant frequency of the trajectory (5 ms hop → 200 Hz trajectory rate,
  fine up to 28 Hz). Lowest 2 points: half-period between extrema over 45 s. Fit: expMap
  endpoints (replica 0.05..28).
- *BPM divisions*: 120 BPM; measure 4 zone centers ({32, 480, 736, 992} → 4, 1/2, 1/8, 1/36);
  full 16-zone pass only if any disagree with the documented table.

**Pitfalls**: drift is negligible against ≥ 100¢ deviations, and the hump tracker measures
cutoff, not pitch, so VCO drift can't contaminate the small-signal slopes; PITCH targets
VCO1+2+MULTI per spec §8 — confirm the MULTI actually receives it in the first capture before
trusting the series.

## D7 — LFO voice-sync semantics (~15 min)

**Base patch**: VPM Sin1 source, LFO TRI ≈ 0.3 Hz, target PITCH, INT ≈ +150¢, POLY, FX off.
Two-note stimuli use A2 + A4 so the two ±150¢ ridges can never collide.

- *Experiment A — staggered two-note*: Key Sync ON + Voice Sync ON. Hold A2; after 1.30 s
  (0.39 cycles — deliberately non-degenerate), strike and hold A4; hold both 6 s. Two ridge
  tracks → per-voice wobble; fit each track's LFO phase by correlation against a triangle
  template. B in phase with A → Voice Sync re-locks to the sounding voice (the replica's
  continuous-share model); B zero-phased at its own onset → Key Sync wins per voice. Repeat at
  staggers 0.83 s and 2.0 s, 3 trials each — three consistent phase offsets are unambiguous.
- *Experiment B — idle free-run lockstep*: both syncs OFF. After 30 s silence, strike
  C3/E3/G3/C4 50 ms apart (round-robin → 4 distinct voices), hold. Four wobble phases: aligned →
  idle LFOs free-run in lockstep (replica model); scattered → independent.
- *Experiment C — RATE while idle*: both syncs OFF; play a note, release; change RATE raw
  300→700 during 5 s silence; strike and measure the first second's wobble rate.
- *1-SHOT check*: SQR LFO, one note: verify half-cycle stop and settle level (square ends low;
  tri/saw end at zero).

**Pitfalls**: phase estimation needs ≥ 1.5 LFO cycles of overlap — hold long; stagger times must
not be multiples of the LFO period or the hypotheses become indistinguishable.

## D8 — Steady-state drift (~30 min wall clock, mostly unattended; run last, maximally warm)

**Method** for ±0.1¢ resolution: single-bin **complex-Goertzel phase-difference tracking on a
harmonic** (the phase-vocoder method specialized to one known bin; a magnitude-peak approach
can't reach 0.1¢ with practical windows). Config: harmonic 4 of A3 (880 Hz), 46 ms Hann, 5 ms
hop → 200 Hz trajectory rate (covers the 30 Hz jitter band), noise-limited precision ≈ ±0.02¢.

**Base patch**: VCO1 SAW only (analog path only — the MULTI is digital and must stay silent),
filter open, FX off, LFO INT 512, EG INT centered. Notes are *held by MIDI* (no note-off) — no
pedal or taped keys needed.

1. *Long hold*: one A3 held 15 min (~50 independent walk-timescale segments). De-meaned cents
   trajectory:
   - **Walk** (< 3 Hz component): analysis-by-synthesis — run the replica `Drift` class over a
     grid of (WALK_CENTS, retarget interval range, slew τ), match Welch PSDs (60 s segments) in
     log-log over 0.02–5 Hz. Sanity stats: LP-trajectory variance → amplitude; turning-point
     rate → retarget interval.
   - **Jitter** (> 5 Hz residue): RMS + one-pole-LP PSD corner fit → JITTER_CUTOFF, effective
     amplitude, clamp plausibility.
2. *Per-note offset*: same key struck 100× (1 s note, 0.5 s gap ≈ 2.5 min). Round-robin means
   strike 4k+i lands on voice i: group by voice, de-trend each voice's series against its own
   slow component, then variance-decompose — within-note (walk+jitter) vs across-note-within-voice
   (the per-note offset; replica ±1.5¢) vs across-voice means (**static per-voice tuning spread —
   a datum the replica doesn't model yet**).
3. *VCO2 vs VCO1 bias*: 5 min hold + 40 strikes with VCO2 only → signed mean offset per voice per
   VCO → the reported "VCO2 runs fast" bias in cents. Validation: both VCOs on, 60 s — the
   amplitude-envelope beat rate (autocorrelation of the RMS envelope) equals |Δf| and must match
   the signed measurements.

**Pitfalls**: room temperature steady (log it; abort if HVAC cycles); don't touch the synth
during the hold; ADC-vs-VCO clock offset is constant and vanishes under de-meaning; the 15 min
hold occupies one voice — the strike series covers the other three.

## D9 — FX (~50 min; capped subtypes as noted)

**Dry stimuli**: tonal ping = VCO1 SQR B5, AMP A0/D ≈ 30 ms (delay); broadband burst = NOISE
High, 50 ms AD (reverb); steady sine = VPM Sin1 A4 (mod FX). Capture **stereo**, features per
channel. Gap between captures ≥ the tail length just measured.

**Delay** (~15 min): STEREO subtype, DRYWET 0.5, DEPTH 512: TIME staircase 17 points, ping + 4 s
capture. Features: Goertzel-magnitude envelope at ping f0 → echo peak times/amplitudes; delay
time = median inter-echo spacing; feedback = median successive-echo dB ratio; wet = echo1/dry.
Fit: log(time) vs raw against the 1..1400 ms exp map; DEPTH staircase (9 points, fixed TIME) →
feedback law vs `min(0.9, 0.85·depth)` + wet law. Other subtypes at 3 TIME points each: MONO
(mono check), PING PONG (L/R energy alternation), loop damping for all types via per-echo ladder
tilt → LP/HP corner fits (9 kHz / 600 Hz guesses), TAPE (per-echo phase-tracker pitch →
wow/flutter rate + depth; further character report-only), DOUBLING (3 points across the slap
range), one BPM subtype at 120 BPM (4 zone centers). Stereo spread: L/R echo-time ratio on
STEREO.

**Reverb** (~20 min): HALL TIME staircase 9 points, burst + capture until tail < −60 dB (up to
~15 s). Feature: Schroeder EDC → RT60 (T30×2), broadband + two band-limited EDCs (200–800 Hz,
2–8 kHz) for damping character. Fit: log(RT60) vs raw. Other subtypes at TIME raw
{200, 600, 1000} only; EARLY REF: echo-pattern spread vs TIME instead of RT60. Predelay per
subtype: wet onset − dry onset − loopback latency (±2 ms), at DRYWET 0.5. DEPTH 5 points on
HALL → wet law. **Report-only**: RISER/SUBMARINE shimmer (spectrogram each), HORROR wobble,
tail-modulation smoothness, stereo image.

**Mod FX** (~15 min): per main type (CHORUS/ENSEMBLE/PHASER/FLANGER, STEREO subtype): TIME
staircase 9 points on the steady sine. Feature: phase tracker at 440 (20 ms window, 2 ms hop) →
instantaneous frequency + amplitude = the FX LFO signal directly; rate = autocorrelation period;
depth = cents pk-pk (chorus/flanger doppler) or dB pk-pk (phaser/ensemble AM). Fit: rate map per
type; DEPTH 5 points → depth law + DEPTH=0 identity check. Remaining subtypes: one capture each
at mid TIME/DEPTH; **voicing character (Orange/Black/Formant, ensemble bloom) report-only**.

**Pitfalls**: verify DRYWET keeps the dry level invariant from 0→0.5 before trusting wet/dry
ratios; never mono-sum stereo FX before extraction; near-unity TAPE feedback can saturate the
loop — measure feedback at DEPTH ≤ 700; wet paths may have latency (predelay needs the loopback
offset).

## D10 — Arpeggiator + sequencer semantics (~15 min)

**Base patch**: VCO1 SAW, fast AMP envelope (A0, D short, S 0), FX off, arp ON, 120 BPM, rate
16th, latch on.

**Stimulus**: hold C3+E3+G3 (and a 4-note chord C3 E3 G3 B3 for POLY variants); 8 s capture per
arp type (all 13: MANUAL/RISE/FALL/RISE-FALL 1+2, POLY 1+2, RANDOM 1–3); RANDOM types ×3
captures.

**Features**: onset segmentation of the RMS envelope → note event list; STFT ridge per event →
MIDI note per step. Deliverable per type: the emitted note/octave sequence vs the replica's
interpretation (1 = one octave, 2 = two octaves; POLY 1 chord-per-step, POLY 2 alternating
octaves; RANDOM 3 octave displacement + velocity variation — velocity read from per-event RMS).
Timing: inter-onset intervals verify the rate table + gate time.

**Fit**: none (semantics, tier-2/3): a behavior table per variant for the report; disagreements
update `dsp/arp.ts`'s community-consensus readings.

**Sequencer semantics extras** (~5 min, from implementation-notes.md "Interpretations"):

- *TIE continuation*: the hardware stores a per-note trigger-switch bit (gate bit 7); the replica
  simplified to same-note continuation. Push programs (the SysEx dump includes the sequencer)
  crafted with trigger=0 across *changing* notes, play, and listen: does the envelope retrigger
  or does the pitch glide/jump without retrigger? Tone-envelope feature at step boundaries.
- *Realtime-rec gate precision* (MIDI-only, no audio needed): while the hardware records in
  realtime-rec mode, send notes with known held durations; dump the program back (func 10) and
  read the captured gate values — measures the hardware's gate quantization directly.

**Pitfalls**: RANDOM variants need multiple captures to characterize the distribution, not one
sequence; latch keeps the chord held without a sustained MIDI gate interfering with onsets.

---

## Cross-cutting protocol

- **Sweep density**: 17 points (64-step grid) for every 2-parameter exp map (8× overdetermined,
  detects taper deviations). Exceptions: PITCH 21 breakpoint-clustered; sustain + FX DEPTH laws
  9; VPM/subtype surveys 3–5. **Every 4th point is held out of all fits** (validation set).
- **Repeats**: pitch staircases ×3 passes (drift); noise PSDs self-average (single 3 s capture);
  envelope extremes ×2, mid ×1; FX pings ×2; semantics experiments ×3 trials.
- **Shared captures**: the resonance staircase serves Q-taper and bass-comp; the Sin1 patch is
  shared by D4 drive / D5 mod-EG / D6 / D9 mod-FX; D8's strike series doubles as D1 reference
  data. One SysEx base patch per domain group; only the swept CC moves.
- **Session budget** (excluding shared warm-up): D1 25, D2 15, D3 35, D4 20, D5 25, D6 30,
  D7 15, D8 30 (unattended-heavy), D9 50, D10 15 ≈ **4 h 30 m + slack → two sessions ≈ 2.5 h**.
  - *Session A* (VCO-centric): warm-up + pre-flight, D1, D2, D3, then D8 unattended at the end
    (peak warm-up).
  - *Session B*: warm-up + short pre-flight, D4, D5, D6, D7, D10, D9.

## Validation — proving the replica got closer

1. **Model-selection holdout**: every 4th fitting-staircase point never enters the initial fit.
   This tests the proposed curve family. A final table may incorporate these points only after
   the family is frozen; they then cease to be independent validation data.
2. **Independent verification session**: after the candidate profile is frozen, make a new
   capture with raw values offset from the fitting grid and no failed/unusable points. Include
   another note wherever frequency invariance is assumed. Do not tune the candidate against this
   set; a model change requires fresh verification captures.
3. **Feature distance before vs after**, on the independent verification session: pitch (cents RMS),
   ladders (median |ΔdB| over k), corners/times/rates (RMS log-ratio), RT60 (log-ratio), Q
   (log-ratio), drift (PSD log-distance + component amplitudes). One table per domain:
   hardware | replica-before | replica-after | distance-before | distance-after.
4. **Acceptance thresholds**: pitch ≤ 2¢; cutoff/times/rates ≤ 5 % (log); ladders ≤ 1.5 dB
   median; RT60 ≤ 10 %; no held-out point regressed beyond its measurement noise (estimated from
   repeat spreads). Until a domain carries an explicit repeat-noise estimate, the automated gate
   conservatively rejects a point whose error grows by more than 25% of that domain's threshold.
5. **Report, then code**: all fits land in the reviewed report (proposed diffs against curves.ts
   / config tables, MEASURED(date) tags, tier-3 structural findings flagged for xd-spec.md
   first). No auto-apply; test re-pinning ships with the reviewed change.
6. **Manual default-promotion gate**: per domain, paired hardware/replica-after captures of 2–3
   *musical* spot checks (not sweep points) are archived for listening; subjective FX/VPM items
   live here. This is intentionally not enforced by `calib accept`, which certifies numeric
   evidence. Listening approval is required by the separate change that promotes a profile to
   the app default.
