# Calibration report: eg-attack-verify

Domain: `eg.amp` — R1 verification for eg-attack: off-grid interior raw values
Session: `calib/evidence/2026-07-13T06-38-eg-attack-verify`
Replica columns + "current" expressions: calibration profile `v0`

## ampAttack = 128

| metric | hardware | replica | Δ |
|---|---|---|---|
| attack 10-90% | 28.7 ms | 2.8 ms | +906.8% |
| peak | -29.4 dBFS | -11.5 dBFS | (scales differ) |

## ampAttack = 300

| metric | hardware | replica | Δ |
|---|---|---|---|
| attack 10-90% | 151.8 ms | 5.9 ms | +2472.4% |
| peak | -29.4 dBFS | -11.5 dBFS | (scales differ) |

## ampAttack = 469

| metric | hardware | replica | Δ |
|---|---|---|---|
| attack 10-90% | 367.4 ms | 22.7 ms | +1519.9% |
| peak | -29.4 dBFS | -11.5 dBFS | (scales differ) |

## ampAttack = 640

| metric | hardware | replica | Δ |
|---|---|---|---|
| attack 10-90% | 685.9 ms | 93.9 ms | +630.2% |
| peak | -29.4 dBFS | -11.5 dBFS | (scales differ) |

## ampAttack = 810

| metric | hardware | replica | Δ |
|---|---|---|---|
| attack 10-90% | 1.11 s | 384.0 ms | +188.1% |
| peak | -29.5 dBFS | -11.5 dBFS | (scales differ) |

## ampAttack = 980

| metric | hardware | replica | Δ |
|---|---|---|---|
| attack 10-90% | 1.62 s | 1.58 s | +2.3% |
| peak | -29.5 dBFS | -11.5 dBFS | (scales differ) |

Harmonics are dB relative to H1 within each world, so Δ is comparable;
peak levels are absolute per world (interface gain vs engine units).

## Proposals

### eg.amp attack — attackToSec (s)

- current: `expMap(raw, 0.0006, 3)`
- proposed: `monotone table (6 pts, log-PCHIP)`
- residual (log RMS): fit 4.53e-15%, held-out n/a
- provenance: MEASURED(2026-07-13)
- coverage: 6/6 planned points
- final table refit on all 6 points (held-out folded in after family selection)
- expMap rejected: residual 37.7% > 25% — curve is not exponential (best expMap was expMap(raw, 0.0392, 3.87))
- only 6 points (< 8): fit on all points, no held-out validation

| raw | s |
|---|---|
| 128 | 0.038273 |
| 300 | 0.20264 |
| 469 | 0.49039 |
| 640 | 0.91548 |
| 810 | 1.4768 |
| 980 | 2.1597 |
