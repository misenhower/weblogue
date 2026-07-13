# Calibration report: eg-decay

Domain: `eg.amp` — D5: AMP EG decay staircase — dB-slope extrapolation on the held region (3*tau displayed-time; no 12+ s waits for the top steps)
Session: `calib/evidence/2026-07-13T04-37-eg-decay`
Replica columns + "current" expressions: calibration profile `v0`

## ampDecay = 0

| metric | hardware | replica | Δ |
|---|---|---|---|
| decay (displayed) | 4.0 ms | n/a |  |
| peak | -35.2 dBFS | -14.8 dBFS | (scales differ) |

## ampDecay = 85

| metric | hardware | replica | Δ |
|---|---|---|---|
| decay (displayed) | 15.0 ms | 4.2 ms | +258.1% |
| peak | -30.6 dBFS | -14.8 dBFS | (scales differ) |

## ampDecay = 171

| metric | hardware | replica | Δ |
|---|---|---|---|
| decay (displayed) | 77.5 ms | 8.6 ms | +800.6% |
| peak | -29.6 dBFS | -14.8 dBFS | (scales differ) |

## ampDecay = 256

| metric | hardware | replica | Δ |
|---|---|---|---|
| decay (displayed) | 179.2 ms | 17.6 ms | +917.6% |
| peak | -29.8 dBFS | -14.0 dBFS | (scales differ) |

## ampDecay = 341

| metric | hardware | replica | Δ |
|---|---|---|---|
| decay (displayed) | 323.4 ms | 36.3 ms | +789.8% |
| peak | -29.5 dBFS | -12.8 dBFS | (scales differ) |

## ampDecay = 426

| metric | hardware | replica | Δ |
|---|---|---|---|
| decay (displayed) | 507.6 ms | 74.9 ms | +577.9% |
| peak | -29.3 dBFS | -12.2 dBFS | (scales differ) |

## ampDecay = 512

| metric | hardware | replica | Δ |
|---|---|---|---|
| decay (displayed) | 737.0 ms | 155.6 ms | +373.7% |
| peak | -29.5 dBFS | -11.9 dBFS | (scales differ) |

## ampDecay = 597

| metric | hardware | replica | Δ |
|---|---|---|---|
| decay (displayed) | 1.02 s | 320.5 ms | +217.1% |
| peak | -29.5 dBFS | -11.7 dBFS | (scales differ) |

## ampDecay = 682

| metric | hardware | replica | Δ |
|---|---|---|---|
| decay (displayed) | 1.33 s | 660.4 ms | +100.8% |
| peak | -29.7 dBFS | -11.7 dBFS | (scales differ) |

## ampDecay = 767

| metric | hardware | replica | Δ |
|---|---|---|---|
| decay (displayed) | 1.68 s | 1.36 s | +23.7% |
| peak | -29.6 dBFS | -11.6 dBFS | (scales differ) |

## ampDecay = 853

| metric | hardware | replica | Δ |
|---|---|---|---|
| decay (displayed) | 2.08 s | 2.83 s | -26.4% |
| peak | -29.9 dBFS | -11.6 dBFS | (scales differ) |

## ampDecay = 896

| metric | hardware | replica | Δ |
|---|---|---|---|
| decay (displayed) | 2.30 s | 4.08 s | -43.6% |
| peak | -29.5 dBFS | -11.6 dBFS | (scales differ) |

## ampDecay = 938

| metric | hardware | replica | Δ |
|---|---|---|---|
| decay (displayed) | 4.65 s | 5.82 s | -20.1% |
| peak | -29.9 dBFS | -11.6 dBFS | (scales differ) |

## ampDecay = 980

| metric | hardware | replica | Δ |
|---|---|---|---|
| decay (displayed) | 7.82 s | 8.32 s | -6.0% |
| peak | -29.7 dBFS | -11.6 dBFS | (scales differ) |

## ampDecay = 1023

| metric | hardware | replica | Δ |
|---|---|---|---|
| decay (displayed) | 11.94 s | 12.00 s | -0.5% |
| peak | -29.8 dBFS | -11.6 dBFS | (scales differ) |

Harmonics are dB relative to H1 within each world, so Δ is comparable;
peak levels are absolute per world (interface gain vs engine units).

## Proposals

### eg.amp decay — decayToSec (s)

- current: `expMap(raw, 0.002, 12)`
- proposed: `monotone table (15 pts, log-PCHIP)`
- residual (log RMS): fit 1.6e-14%, held-out 13.6%
- provenance: MEASURED(2026-07-13)
- coverage: 15/15 planned points
- table values are time-to-zero T of the cubic fall (egFallPower = 3, linear phase cubed; measured p = 3.00 across the range, 0.2 dB RMS)
- final table refit on all 15 points (held-out folded in after family selection)
- expMap rejected: residual 63.6% > 25% — curve is not exponential (best expMap was expMap(raw, 0.0278, 20.5))
- fit on 12 points, 3 held out (every 4th)

| raw | s |
|---|---|
| 0 | 0.0062094 |
| 85 | 0.040949 |
| 171 | 0.15351 |
| 256 | 0.33931 |
| 341 | 0.60056 |
| 426 | 0.93263 |
| 512 | 1.3493 |
| 597 | 1.8548 |
| 682 | 2.4185 |
| 767 | 3.0602 |
| 853 | 3.7891 |
| 896 | 4.176 |
| 938 | 8.4415 |
| 980 | 14.19 |
| 1023 | 21.612 |
