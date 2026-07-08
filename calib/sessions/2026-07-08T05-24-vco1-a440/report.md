# Calibration report: vco1-a440

Domain: `vco.pitch` — Vertical slice: VCO1 saw at A4 — pitch and first 8 harmonics, hardware vs replica
Session: `/Users/ike/Documents/minilogue/calib/sessions/2026-07-08T05-24-vco1-a440`

## base patch

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 440.56 Hz (+2.2¢) | 440.08 Hz (+0.3¢) | +1.9¢ |
| per strike (¢) | +3.8 / +1.4 / +3.0 / +0.5 | -1.1 / +1.6 / -1.0 / +2.2 | |
| voice spread | 3.3¢ | 3.3¢ | +0.1¢ |
| H2 | -6.6 dB | -7.1 dB | +0.5 dB |
| H3 | -10.4 dB | -10.8 dB | +0.4 dB |
| H4 | -13.0 dB | -13.4 dB | +0.4 dB |
| H5 | -14.9 dB | -15.4 dB | +0.5 dB |
| H6 | -16.4 dB | -17.1 dB | +0.7 dB |
| H7 | -17.6 dB | -18.6 dB | +1.0 dB |
| H8 | -18.8 dB | -19.9 dB | +1.1 dB |
| peak | -27.9 dBFS | -11.5 dBFS | (scales differ) |

Harmonics are dB relative to H1 within each world, so Δ is comparable;
peak levels are absolute per world (interface gain vs engine units).
