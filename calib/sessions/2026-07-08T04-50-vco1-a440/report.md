# Calibration report: vco1-a440

Domain: `vco.pitch` — Vertical slice: VCO1 saw at A4 — pitch and first 8 harmonics, hardware vs replica
Session: `/Users/ike/Documents/minilogue/calib/sessions/2026-07-08T04-50-vco1-a440`

## base patch

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 440.41 Hz (+1.6¢) | 440.08 Hz (+0.3¢) | +1.3¢ |
| per strike (¢) | +1.4 / +1.7 / +1.5 / +2.7 | -1.1 / +1.6 / -1.0 / +2.2 | |
| voice spread | 1.3¢ | 3.3¢ | -2.0¢ |
| H2 | -6.7 dB | -7.1 dB | +0.4 dB |
| H3 | -10.5 dB | -10.8 dB | +0.3 dB |
| H4 | -13.1 dB | -13.4 dB | +0.3 dB |
| H5 | -15.1 dB | -15.4 dB | +0.4 dB |
| H6 | -16.7 dB | -17.1 dB | +0.4 dB |
| H7 | -17.9 dB | -18.6 dB | +0.7 dB |
| H8 | -18.8 dB | -19.9 dB | +1.1 dB |
| peak | -28.4 dBFS | -11.5 dBFS | (scales differ) |

Harmonics are dB relative to H1 within each world, so Δ is comparable;
peak levels are absolute per world (interface gain vs engine units).
