# Calibration report: eg-release

Domain: `eg.amp` — D5: AMP EG release staircase — from the S=1023 plateau, dB-slope extrapolation on the post-note-off tail (3*tau displayed-time)
Session: `calib/evidence/2026-07-13T04-44-eg-release`
Replica columns + "current" expressions: calibration profile `v0`

## ampRelease = 0

| metric | hardware | replica | Δ |
|---|---|---|---|
| release (displayed) | 3.0 ms | n/a |  |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## ampRelease = 85

| metric | hardware | replica | Δ |
|---|---|---|---|
| release (displayed) | 16.0 ms | 4.3 ms | +273.5% |
| peak | -29.4 dBFS | -11.5 dBFS | (scales differ) |

## ampRelease = 171

| metric | hardware | replica | Δ |
|---|---|---|---|
| release (displayed) | 78.6 ms | 8.9 ms | +782.3% |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## ampRelease = 256

| metric | hardware | replica | Δ |
|---|---|---|---|
| release (displayed) | 184.1 ms | 18.7 ms | +885.8% |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## ampRelease = 341

| metric | hardware | replica | Δ |
|---|---|---|---|
| release (displayed) | 326.3 ms | 39.2 ms | +733.0% |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## ampRelease = 426

| metric | hardware | replica | Δ |
|---|---|---|---|
| release (displayed) | 510.1 ms | 82.2 ms | +520.7% |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## ampRelease = 512

| metric | hardware | replica | Δ |
|---|---|---|---|
| release (displayed) | 740.3 ms | 174.0 ms | +325.5% |
| peak | -29.2 dBFS | -11.5 dBFS | (scales differ) |

## ampRelease = 597

| metric | hardware | replica | Δ |
|---|---|---|---|
| release (displayed) | 1.02 s | 365.1 ms | +179.2% |
| peak | -29.7 dBFS | -11.5 dBFS | (scales differ) |

## ampRelease = 682

| metric | hardware | replica | Δ |
|---|---|---|---|
| release (displayed) | 1.33 s | 766.3 ms | +73.4% |
| peak | -29.5 dBFS | -11.5 dBFS | (scales differ) |

## ampRelease = 767

| metric | hardware | replica | Δ |
|---|---|---|---|
| release (displayed) | 1.67 s | 1.61 s | +3.5% |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## ampRelease = 853

| metric | hardware | replica | Δ |
|---|---|---|---|
| release (displayed) | 2.06 s | 3.41 s | -39.4% |
| peak | -29.2 dBFS | -11.5 dBFS | (scales differ) |

## ampRelease = 896

| metric | hardware | replica | Δ |
|---|---|---|---|
| release (displayed) | 2.30 s | 4.95 s | -53.6% |
| peak | -29.6 dBFS | -11.5 dBFS | (scales differ) |

## ampRelease = 938

| metric | hardware | replica | Δ |
|---|---|---|---|
| release (displayed) | 4.65 s | 7.15 s | -34.9% |
| peak | -29.6 dBFS | -11.5 dBFS | (scales differ) |

## ampRelease = 980

| metric | hardware | replica | Δ |
|---|---|---|---|
| release (displayed) | 7.74 s | 10.31 s | -24.9% |
| peak | -29.4 dBFS | -11.5 dBFS | (scales differ) |

## ampRelease = 1023

| metric | hardware | replica | Δ |
|---|---|---|---|
| release (displayed) | 11.80 s | 15.00 s | -21.3% |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

Harmonics are dB relative to H1 within each world, so Δ is comparable;
peak levels are absolute per world (interface gain vs engine units).

## Proposals

### eg.amp release — releaseToSec (s)

- current: `expMap(raw, 0.002, 15)`
- proposed: `monotone table (15 pts, log-PCHIP)`
- residual (log RMS): fit 8.48e-15%, held-out 13.3%
- provenance: MEASURED(2026-07-13)
- coverage: 15/15 planned points
- table values are time-to-zero T of the cubic fall (egFallPower = 3, linear phase cubed; measured p = 3.00 across the range, 0.2 dB RMS); this result also authorizes egFallPower
- final table refit on all 15 points (held-out folded in after family selection)
- expMap rejected: residual 60.4% > 25% — curve is not exponential (best expMap was expMap(raw, 0.03, 19.9))
- fit on 12 points, 3 held out (every 4th)

| raw | s |
|---|---|
| 0 | 0.0074267 |
| 85 | 0.042817 |
| 171 | 0.15599 |
| 256 | 0.35006 |
| 341 | 0.60359 |
| 426 | 0.93853 |
| 512 | 1.3534 |
| 597 | 1.8616 |
| 682 | 2.4265 |
| 767 | 3.0289 |
| 853 | 3.7452 |
| 896 | 4.1831 |
| 938 | 8.4503 |
| 980 | 14.025 |
| 1023 | 21.371 |
