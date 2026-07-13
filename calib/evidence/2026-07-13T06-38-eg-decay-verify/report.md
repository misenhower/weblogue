# Calibration report: eg-decay-verify

Domain: `eg.amp` — R1 verification for eg-decay: off-grid interior raw values
Session: `calib/evidence/2026-07-13T06-38-eg-decay-verify`
Replica columns + "current" expressions: calibration profile `v0`

## ampDecay = 128

| metric | hardware | replica | Δ |
|---|---|---|---|
| decay (displayed) | 41.8 ms | 6.0 ms | +597.3% |
| peak | -30.4 dBFS | -14.8 dBFS | (scales differ) |

## ampDecay = 300

| metric | hardware | replica | Δ |
|---|---|---|---|
| decay (displayed) | 253.4 ms | 25.7 ms | +887.9% |
| peak | -30.0 dBFS | -13.3 dBFS | (scales differ) |

## ampDecay = 469

| metric | hardware | replica | Δ |
|---|---|---|---|
| decay (displayed) | 626.4 ms | 107.9 ms | +480.4% |
| peak | -29.7 dBFS | -12.0 dBFS | (scales differ) |

## ampDecay = 640

| metric | hardware | replica | Δ |
|---|---|---|---|
| decay (displayed) | 1.17 s | 462.0 ms | +153.9% |
| peak | -30.0 dBFS | -11.7 dBFS | (scales differ) |

## ampDecay = 810

| metric | hardware | replica | Δ |
|---|---|---|---|
| decay (displayed) | 1.88 s | 1.96 s | -4.0% |
| peak | -29.8 dBFS | -11.6 dBFS | (scales differ) |

## ampDecay = 1000

| metric | hardware | replica | Δ |
|---|---|---|---|
| decay (displayed) | 9.66 s | 9.87 s | -2.1% |
| peak | -29.9 dBFS | -11.6 dBFS | (scales differ) |

Harmonics are dB relative to H1 within each world, so Δ is comparable;
peak levels are absolute per world (interface gain vs engine units).

## Proposals

### eg.amp decay — decayToSec (s)

- current: `expMap(raw, 0.002, 12)`
- proposed: `monotone table (6 pts, log-PCHIP)`
- residual (log RMS): fit 6.41e-15%, held-out n/a
- provenance: MEASURED(2026-07-13)
- coverage: 6/6 planned points
- table values are time-to-zero T of the cubic fall (egFallPower = 3, linear phase cubed; measured p = 3.00 across the range, 0.2 dB RMS)
- final table refit on all 6 points (held-out folded in after family selection)
- expMap rejected: residual 31.5% > 25% — curve is not exponential (best expMap was expMap(raw, 0.065, 17.1))
- only 6 points (< 8): fit on all points, no held-out validation

| raw | s |
|---|---|
| 128 | 0.088908 |
| 300 | 0.47358 |
| 469 | 1.1507 |
| 640 | 2.1434 |
| 810 | 3.4277 |
| 1000 | 17.524 |
