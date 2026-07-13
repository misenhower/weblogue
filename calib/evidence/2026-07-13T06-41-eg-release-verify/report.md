# Calibration report: eg-release-verify

Domain: `eg.amp` — R1 verification for eg-release: off-grid interior raw values
Session: `calib/evidence/2026-07-13T06-41-eg-release-verify`
Replica columns + "current" expressions: calibration profile `v0`

## ampRelease = 128

| metric | hardware | replica | Δ |
|---|---|---|---|
| release (displayed) | 41.7 ms | 6.2 ms | +576.3% |
| peak | -29.4 dBFS | -11.5 dBFS | (scales differ) |

## ampRelease = 300

| metric | hardware | replica | Δ |
|---|---|---|---|
| release (displayed) | 255.2 ms | 27.4 ms | +830.9% |
| peak | -29.7 dBFS | -11.5 dBFS | (scales differ) |

## ampRelease = 469

| metric | hardware | replica | Δ |
|---|---|---|---|
| release (displayed) | 628.7 ms | 119.6 ms | +425.8% |
| peak | -29.8 dBFS | -11.5 dBFS | (scales differ) |

## ampRelease = 640

| metric | hardware | replica | Δ |
|---|---|---|---|
| release (displayed) | 1.17 s | 531.3 ms | +120.9% |
| peak | -29.7 dBFS | -11.5 dBFS | (scales differ) |

## ampRelease = 810

| metric | hardware | replica | Δ |
|---|---|---|---|
| release (displayed) | 1.86 s | 2.34 s | -20.4% |
| peak | -29.4 dBFS | -11.5 dBFS | (scales differ) |

## ampRelease = 1000

| metric | hardware | replica | Δ |
|---|---|---|---|
| release (displayed) | 9.55 s | 12.27 s | -22.2% |
| peak | -29.4 dBFS | -11.5 dBFS | (scales differ) |

Harmonics are dB relative to H1 within each world, so Δ is comparable;
peak levels are absolute per world (interface gain vs engine units).

## Proposals

### eg.amp release — releaseToSec (s)

- current: `expMap(raw, 0.002, 15)`
- proposed: `monotone table (6 pts, log-PCHIP)`
- residual (log RMS): fit 6.41e-15%, held-out n/a
- provenance: MEASURED(2026-07-13)
- coverage: 6/6 planned points
- table values are time-to-zero T of the cubic fall (egFallPower = 3, linear phase cubed; measured p = 3.00 across the range, 0.2 dB RMS); this result also authorizes egFallPower
- final table refit on all 6 points (held-out folded in after family selection)
- expMap rejected: residual 31.5% > 25% — curve is not exponential (best expMap was expMap(raw, 0.0662, 16.9))
- only 6 points (< 8): fit on all points, no held-out validation

| raw | s |
|---|---|
| 128 | 0.090376 |
| 300 | 0.47663 |
| 469 | 1.1553 |
| 640 | 2.1455 |
| 810 | 3.3922 |
| 1000 | 17.329 |
