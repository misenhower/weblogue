# Calibration report: cutoff-verify

Domain: `filter.cutoff` — R1 verification for cutoff-sweep: interior raw values offset +32 from the multiple-of-64 fitting grid; 992 omitted — corners above ~10 kHz are unmeasurable by construction (PSD reference region)
Session: `calib/evidence/2026-07-13T06-36-cutoff-verify`
Replica columns + "current" expressions: calibration profile `v0`

## cutoff = 96

| metric | hardware | replica | Δ |
|---|---|---|---|
| rms | -65.3 dBFS | -50.6 dBFS | (scales differ) |
| peak | -53.9 dBFS | -40.7 dBFS | (scales differ) |

## cutoff = 224

| metric | hardware | replica | Δ |
|---|---|---|---|
| rms | -59.4 dBFS | -44.9 dBFS | (scales differ) |
| peak | -48.6 dBFS | -33.5 dBFS | (scales differ) |

## cutoff = 352

| metric | hardware | replica | Δ |
|---|---|---|---|
| rms | -54.0 dBFS | -40.4 dBFS | (scales differ) |
| peak | -42.9 dBFS | -28.6 dBFS | (scales differ) |

## cutoff = 480

| metric | hardware | replica | Δ |
|---|---|---|---|
| rms | -49.5 dBFS | -36.2 dBFS | (scales differ) |
| peak | -38.5 dBFS | -24.6 dBFS | (scales differ) |

## cutoff = 608

| metric | hardware | replica | Δ |
|---|---|---|---|
| rms | -45.4 dBFS | -32.1 dBFS | (scales differ) |
| peak | -33.0 dBFS | -20.0 dBFS | (scales differ) |

## cutoff = 736

| metric | hardware | replica | Δ |
|---|---|---|---|
| rms | -41.6 dBFS | -28.2 dBFS | (scales differ) |
| peak | -30.1 dBFS | -16.5 dBFS | (scales differ) |

## cutoff = 864

| metric | hardware | replica | Δ |
|---|---|---|---|
| rms | -38.2 dBFS | -24.5 dBFS | (scales differ) |
| peak | -27.4 dBFS | -14.4 dBFS | (scales differ) |

Harmonics are dB relative to H1 within each world, so Δ is comparable;
peak levels are absolute per world (interface gain vs engine units).

## Proposals

### filter.cutoff — cutoffToHz (Hz)

- current: `expMap(raw, 16, 21000)`
- proposed: `monotone table (6 pts, log-PCHIP)`
- residual (log RMS): fit 0%, held-out n/a
- provenance: MEASURED(2026-07-13)
- coverage: 7/7 planned points
- final table refit on all 6 points (held-out folded in after family selection)
- table by standing decision: cutoff is a table, not an expMap (Matt, 2026-07-10); corners are bias-corrected through the replica inversion (see domains.ts biasCorrectCorners) (best expMap was expMap(raw, 19.5, 20600), residual 0.9%)
- only 6 points (< 8): fit on all points, no held-out validation

| raw | Hz |
|---|---|
| 96 | 37.686 |
| 224 | 88.727 |
| 352 | 213.52 |
| 480 | 517.51 |
| 608 | 1205.5 |
| 736 | 2934.4 |
