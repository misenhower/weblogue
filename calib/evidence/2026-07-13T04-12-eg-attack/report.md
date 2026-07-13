# Calibration report: eg-attack

Domain: `eg.amp` — D5: AMP EG attack staircase — 10-90% rise of the tone envelope per step; note held past the ~3 s hardware max attack (docs/xd-spec.md)
Session: `calib/evidence/2026-07-13T04-12-eg-attack`
Replica columns + "current" expressions: calibration profile `v0`

## ampAttack = 0

| metric | hardware | replica | Δ |
|---|---|---|---|
| attack 10-90% | 2.8 ms | 2.9 ms | -4.2% |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## ampAttack = 85

| metric | hardware | replica | Δ |
|---|---|---|---|
| attack 10-90% | 13.4 ms | 2.9 ms | +366.8% |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## ampAttack = 171

| metric | hardware | replica | Δ |
|---|---|---|---|
| attack 10-90% | 50.4 ms | 3.2 ms | +1467.8% |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## ampAttack = 256

| metric | hardware | replica | Δ |
|---|---|---|---|
| attack 10-90% | 111.0 ms | 4.6 ms | +2323.2% |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## ampAttack = 341

| metric | hardware | replica | Δ |
|---|---|---|---|
| attack 10-90% | 195.2 ms | 8.0 ms | +2325.8% |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## ampAttack = 426

| metric | hardware | replica | Δ |
|---|---|---|---|
| attack 10-90% | 304.0 ms | 15.8 ms | +1820.3% |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## ampAttack = 512

| metric | hardware | replica | Δ |
|---|---|---|---|
| attack 10-90% | 438.8 ms | 32.4 ms | +1254.6% |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## ampAttack = 597

| metric | hardware | replica | Δ |
|---|---|---|---|
| attack 10-90% | 593.3 ms | 66.1 ms | +797.1% |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## ampAttack = 682

| metric | hardware | replica | Δ |
|---|---|---|---|
| attack 10-90% | 775.8 ms | 132.4 ms | +485.8% |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## ampAttack = 767

| metric | hardware | replica | Δ |
|---|---|---|---|
| attack 10-90% | 986.2 ms | 267.5 ms | +268.6% |
| peak | -29.7 dBFS | -11.5 dBFS | (scales differ) |

## ampAttack = 853

| metric | hardware | replica | Δ |
|---|---|---|---|
| attack 10-90% | 1.22 s | 548.9 ms | +122.3% |
| peak | -29.7 dBFS | -11.5 dBFS | (scales differ) |

## ampAttack = 938

| metric | hardware | replica | Δ |
|---|---|---|---|
| attack 10-90% | 1.47 s | 1.12 s | +31.7% |
| peak | -29.7 dBFS | -11.5 dBFS | (scales differ) |

## ampAttack = 1023

| metric | hardware | replica | Δ |
|---|---|---|---|
| attack 10-90% | 1.75 s | 2.25 s | -22.4% |
| peak | -29.7 dBFS | -11.5 dBFS | (scales differ) |

Harmonics are dB relative to H1 within each world, so Δ is comparable;
peak levels are absolute per world (interface gain vs engine units).

## Proposals

### eg.amp attack — attackToSec (s)

- current: `expMap(raw, 0.0006, 3)`
- proposed: `monotone table (13 pts, log-PCHIP)`
- residual (log RMS): fit 1.31e-14%, held-out 0.738%
- provenance: MEASURED(2026-07-13)
- coverage: 13/13 planned points
- final table refit on all 13 points (held-out folded in after family selection)
- expMap rejected: residual 71.6% > 25% — curve is not exponential (best expMap was expMap(raw, 0.0158, 5.79))
- fit on 10 points, 3 held out (every 4th)

| raw | s |
|---|---|
| 0 | 0.0037537 |
| 85 | 0.017925 |
| 171 | 0.067246 |
| 256 | 0.14813 |
| 341 | 0.26055 |
| 426 | 0.40581 |
| 512 | 0.58563 |
| 597 | 0.79193 |
| 682 | 1.0355 |
| 767 | 1.3162 |
| 853 | 1.629 |
| 938 | 1.962 |
| 1023 | 2.3355 |
