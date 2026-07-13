# Calibration report: cutoff-sweep

Domain: `filter.cutoff` — D4/M3: cutoff taper via NOISE High through the VCF — per-strike PSD transfer vs the raw-1023 reference (4 strikes = all analog VCFs; the digital noise source is voice-identical), median fitLpMag corner per point, expMap fit
Session: `calib/evidence/2026-07-13T04-26-cutoff-sweep`
Replica columns + "current" expressions: calibration profile `v0`

## cutoff = 0

| metric | hardware | replica | Δ |
|---|---|---|---|
| rms | -71.0 dBFS | -55.9 dBFS | (scales differ) |
| peak | -60.7 dBFS | -45.9 dBFS | (scales differ) |

## cutoff = 64

| metric | hardware | replica | Δ |
|---|---|---|---|
| rms | -67.0 dBFS | -52.2 dBFS | (scales differ) |
| peak | -55.5 dBFS | -43.2 dBFS | (scales differ) |

## cutoff = 128

| metric | hardware | replica | Δ |
|---|---|---|---|
| rms | -62.9 dBFS | -49.0 dBFS | (scales differ) |
| peak | -49.4 dBFS | -38.5 dBFS | (scales differ) |

## cutoff = 192

| metric | hardware | replica | Δ |
|---|---|---|---|
| rms | -60.2 dBFS | -46.2 dBFS | (scales differ) |
| peak | -48.2 dBFS | -34.7 dBFS | (scales differ) |

## cutoff = 256

| metric | hardware | replica | Δ |
|---|---|---|---|
| rms | -57.6 dBFS | -43.7 dBFS | (scales differ) |
| peak | -46.1 dBFS | -32.1 dBFS | (scales differ) |

## cutoff = 320

| metric | hardware | replica | Δ |
|---|---|---|---|
| rms | -55.2 dBFS | -41.4 dBFS | (scales differ) |
| peak | -42.6 dBFS | -29.8 dBFS | (scales differ) |

## cutoff = 384

| metric | hardware | replica | Δ |
|---|---|---|---|
| rms | -52.8 dBFS | -39.3 dBFS | (scales differ) |
| peak | -40.0 dBFS | -27.1 dBFS | (scales differ) |

## cutoff = 448

| metric | hardware | replica | Δ |
|---|---|---|---|
| rms | -50.6 dBFS | -37.2 dBFS | (scales differ) |
| peak | -39.0 dBFS | -25.3 dBFS | (scales differ) |

## cutoff = 512

| metric | hardware | replica | Δ |
|---|---|---|---|
| rms | -48.5 dBFS | -35.2 dBFS | (scales differ) |
| peak | -36.4 dBFS | -23.3 dBFS | (scales differ) |

## cutoff = 576

| metric | hardware | replica | Δ |
|---|---|---|---|
| rms | -46.4 dBFS | -33.2 dBFS | (scales differ) |
| peak | -34.2 dBFS | -20.9 dBFS | (scales differ) |

## cutoff = 640

| metric | hardware | replica | Δ |
|---|---|---|---|
| rms | -44.5 dBFS | -31.1 dBFS | (scales differ) |
| peak | -32.3 dBFS | -18.8 dBFS | (scales differ) |

## cutoff = 704

| metric | hardware | replica | Δ |
|---|---|---|---|
| rms | -42.6 dBFS | -29.2 dBFS | (scales differ) |
| peak | -30.5 dBFS | -17.2 dBFS | (scales differ) |

## cutoff = 768

| metric | hardware | replica | Δ |
|---|---|---|---|
| rms | -40.7 dBFS | -27.2 dBFS | (scales differ) |
| peak | -29.2 dBFS | -15.7 dBFS | (scales differ) |

## cutoff = 832

| metric | hardware | replica | Δ |
|---|---|---|---|
| rms | -39.0 dBFS | -25.4 dBFS | (scales differ) |
| peak | -28.2 dBFS | -14.8 dBFS | (scales differ) |

## cutoff = 896

| metric | hardware | replica | Δ |
|---|---|---|---|
| rms | -37.5 dBFS | -23.7 dBFS | (scales differ) |
| peak | -26.3 dBFS | -14.1 dBFS | (scales differ) |

## cutoff = 960

| metric | hardware | replica | Δ |
|---|---|---|---|
| rms | -36.3 dBFS | -22.2 dBFS | (scales differ) |
| peak | -25.9 dBFS | -13.5 dBFS | (scales differ) |

## cutoff = 1023

| metric | hardware | replica | Δ |
|---|---|---|---|
| rms | -35.3 dBFS | -21.0 dBFS | (scales differ) |
| peak | -25.2 dBFS | -13.2 dBFS | (scales differ) |

Harmonics are dB relative to H1 within each world, so Δ is comparable;
peak levels are absolute per world (interface gain vs engine units).

## Proposals

### filter.cutoff — cutoffToHz (Hz)

- current: `expMap(raw, 16, 21000)`
- proposed: `monotone table (15 pts, log-PCHIP)`
- residual (log RMS): fit 0%, held-out 2.75%
- provenance: MEASURED(2026-07-13)
- coverage: 17/17 planned points — NO USABLE VALUE at cutoff=960
- final table refit on all 15 points (held-out folded in after family selection)
- table by standing decision: cutoff is a table, not an expMap (Matt, 2026-07-10); corners are bias-corrected through the replica inversion (see domains.ts biasCorrectCorners) (best expMap was expMap(raw, 16.7, 24200), residual 3.8%)
- fit on 12 points, 3 held out (every 4th)

| raw | Hz |
|---|---|
| 0 | 15.538 |
| 64 | 25.692 |
| 128 | 41.329 |
| 192 | 69.893 |
| 256 | 107.9 |
| 320 | 172.13 |
| 384 | 273.79 |
| 448 | 416.44 |
| 512 | 636.31 |
| 576 | 1022.4 |
| 640 | 1557.3 |
| 704 | 2481.6 |
| 768 | 3872.1 |
| 832 | 6189.7 |
| 896 | 9474.9 |
