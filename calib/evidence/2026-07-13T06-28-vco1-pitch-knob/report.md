# Calibration report: vco1-pitch-knob

Domain: `vco.pitch` — D1: PITCH knob curve at the documented MIDIimp breakpoints — verifies pitchToCents segments (DOCUMENTED-exact; flag >3¢, don't refit) Grid densified to every-32 raw + documented anchors (2026-07-13): the sparse zone-boundary grid left up to 75c of PCHIP interpolation error at off-grid knob positions (caught by R1 verification).
Session: `calib/evidence/2026-07-13T06-28-vco1-pitch-knob`
Replica columns + "current" expressions: calibration profile `v0`

## vco1Pitch = 0

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 220.24 Hz (-1198.1¢) | 220.04 Hz (-1199.7¢) | +1.6¢ |
| per strike (¢) | -1197.7 / -1197.4 / -1198.7 / -1198.5 | -1201.1 / -1198.4 / -1201.0 / -1197.8 | |
| voice spread | 1.3¢ | 3.3¢ | -2.0¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.7 dB | +0.9 dB |
| H4 | -12.4 dB | -13.3 dB | +0.9 dB |
| peak | -29.0 dBFS | -11.2 dBFS | (scales differ) |

## vco1Pitch = 4

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 220.16 Hz (-1198.7¢) | 220.04 Hz (-1199.7¢) | +1.0¢ |
| per strike (¢) | -1198.7 / -1198.7 / -1198.8 / -1198.7 | -1201.1 / -1198.4 / -1201.0 / -1197.8 | |
| voice spread | 0.1¢ | 3.3¢ | -3.2¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.7 dB | +0.9 dB |
| H4 | -12.4 dB | -13.3 dB | +0.9 dB |
| peak | -28.9 dBFS | -11.2 dBFS | (scales differ) |

## vco1Pitch = 32

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 231.76 Hz (-1109.9¢) | 229.79 Hz (-1124.6¢) | +14.7¢ |
| per strike (¢) | -1109.8 / -1110.5 / -1109.9 / -1109.8 | -1126.0 / -1123.3 / -1125.9 / -1122.7 | |
| voice spread | 0.7¢ | 3.4¢ | -2.7¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.3 dB | +0.9 dB |
| peak | -29.0 dBFS | -11.3 dBFS | (scales differ) |

## vco1Pitch = 64

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 245.44 Hz (-1010.6¢) | 241.47 Hz (-1038.8¢) | +28.2¢ |
| per strike (¢) | -1011.0 / -1009.2 / -1010.9 / -1010.3 | -1040.2 / -1037.5 / -1040.1 / -1036.9 | |
| voice spread | 1.8¢ | 3.3¢ | -1.5¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.3 dB | +0.9 dB |
| peak | -29.3 dBFS | -11.3 dBFS | (scales differ) |

## vco1Pitch = 96

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 260.04 Hz (-910.5¢) | 253.74 Hz (-953.0¢) | +42.5¢ |
| per strike (¢) | -911.5 / -909.5 / -911.6 / -909.3 | -954.3 / -951.7 / -954.3 / -951.1 | |
| voice spread | 2.3¢ | 3.3¢ | -1.0¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.3 dB | +0.9 dB |
| peak | -29.3 dBFS | -11.3 dBFS | (scales differ) |

## vco1Pitch = 100

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 261.98 Hz (-897.7¢) | 255.32 Hz (-942.2¢) | +44.6¢ |
| per strike (¢) | -898.6 / -896.7 / -898.5 / -896.9 | -943.6 / -940.9 / -943.6 / -940.3 | |
| voice spread | 1.8¢ | 3.3¢ | -1.5¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.3 dB | +0.9 dB |
| peak | -29.4 dBFS | -11.3 dBFS | (scales differ) |

## vco1Pitch = 128

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 275.33 Hz (-811.6¢) | 266.64 Hz (-867.2¢) | +55.5¢ |
| per strike (¢) | -812.3 / -811.1 / -812.2 / -811.0 | -868.6 / -865.8 / -868.5 / -865.2 | |
| voice spread | 1.3¢ | 3.3¢ | -2.0¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.3 dB | +0.9 dB |
| peak | -29.4 dBFS | -11.3 dBFS | (scales differ) |

## vco1Pitch = 160

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 291.92 Hz (-710.3¢) | 280.19 Hz (-781.3¢) | +71.1¢ |
| per strike (¢) | -710.4 / -710.2 / -710.4 / -710.1 | -782.7 / -780.0 / -782.7 / -779.4 | |
| voice spread | 0.3¢ | 3.3¢ | -3.0¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.3 dB | +0.9 dB |
| peak | -29.5 dBFS | -11.3 dBFS | (scales differ) |

## vco1Pitch = 192

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 309.09 Hz (-611.4¢) | 294.43 Hz (-695.5¢) | +84.2¢ |
| per strike (¢) | -611.1 / -611.6 / -611.1 / -611.7 | -696.9 / -694.2 / -696.8 / -693.6 | |
| voice spread | 0.6¢ | 3.3¢ | -2.6¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.3 dB | +0.9 dB |
| peak | -29.6 dBFS | -11.3 dBFS | (scales differ) |

## vco1Pitch = 224

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 327.47 Hz (-511.3¢) | 309.39 Hz (-609.7¢) | +98.4¢ |
| per strike (¢) | -511.9 / -510.7 / -512.0 / -510.8 | -611.1 / -608.4 / -611.0 / -607.8 | |
| voice spread | 1.3¢ | 3.3¢ | -2.0¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.3 dB | +0.9 dB |
| peak | -29.7 dBFS | -11.4 dBFS | (scales differ) |

## vco1Pitch = 256

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 347.03 Hz (-410.9¢) | 325.11 Hz (-523.9¢) | +113.0¢ |
| per strike (¢) | -411.1 / -409.9 / -411.6 / -410.7 | -525.3 / -522.6 / -525.2 / -522.0 | |
| voice spread | 1.6¢ | 3.3¢ | -1.7¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.3 dB | +0.9 dB |
| peak | -29.4 dBFS | -11.4 dBFS | (scales differ) |

## vco1Pitch = 288

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 367.60 Hz (-311.2¢) | 341.63 Hz (-438.1¢) | +126.8¢ |
| per strike (¢) | -310.8 / -311.7 / -310.7 / -311.7 | -439.4 / -436.8 / -439.4 / -436.1 | |
| voice spread | 1.0¢ | 3.3¢ | -2.3¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.4 dB | +0.9 dB |
| peak | -29.4 dBFS | -11.4 dBFS | (scales differ) |

## vco1Pitch = 320

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 389.71 Hz (-210.1¢) | 358.99 Hz (-352.2¢) | +142.1¢ |
| per strike (¢) | -210.2 / -210.1 / -210.1 / -210.0 | -353.6 / -350.9 / -353.6 / -350.3 | |
| voice spread | 0.1¢ | 3.3¢ | -3.2¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.4 dB | +0.9 dB |
| peak | -29.4 dBFS | -11.4 dBFS | (scales differ) |

## vco1Pitch = 352

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 412.81 Hz (-110.4¢) | 377.24 Hz (-266.4¢) | +156.0¢ |
| per strike (¢) | -110.8 / -110.1 / -110.9 / -110.1 | -267.8 / -265.1 / -267.7 / -264.5 | |
| voice spread | 0.8¢ | 3.3¢ | -2.4¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.4 dB | +0.9 dB |
| peak | -29.2 dBFS | -11.4 dBFS | (scales differ) |

## vco1Pitch = 356

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 415.86 Hz (-97.7¢) | 379.58 Hz (-255.7¢) | +158.0¢ |
| per strike (¢) | -98.2 / -97.2 / -98.1 / -97.2 | -257.1 / -254.4 / -257.0 / -253.8 | |
| voice spread | 1.0¢ | 3.3¢ | -2.3¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.4 dB | +0.9 dB |
| peak | -29.4 dBFS | -11.4 dBFS | (scales differ) |

## vco1Pitch = 384

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 420.79 Hz (-77.3¢) | 392.06 Hz (-199.7¢) | +122.4¢ |
| per strike (¢) | -77.9 / -76.7 / -78.0 / -76.5 | -201.1 / -198.4 / -201.0 / -197.8 | |
| voice spread | 1.4¢ | 3.3¢ | -1.8¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.4 dB | +0.9 dB |
| peak | -29.3 dBFS | -11.4 dBFS | (scales differ) |

## vco1Pitch = 400

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 423.90 Hz (-64.5¢) | 399.38 Hz (-167.7¢) | +103.2¢ |
| per strike (¢) | -65.2 / -63.8 / -65.3 / -63.8 | -169.1 / -166.4 / -169.0 / -165.8 | |
| voice spread | 1.5¢ | 3.3¢ | -1.8¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.4 dB | +0.9 dB |
| peak | -29.3 dBFS | -11.4 dBFS | (scales differ) |

## vco1Pitch = 416

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 427.07 Hz (-51.7¢) | 406.83 Hz (-135.7¢) | +84.0¢ |
| per strike (¢) | -52.6 / -50.6 / -52.5 / -50.8 | -137.1 / -134.4 / -137.0 / -133.8 | |
| voice spread | 2.0¢ | 3.3¢ | -1.3¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.4 dB | +0.9 dB |
| peak | -29.4 dBFS | -11.5 dBFS | (scales differ) |

## vco1Pitch = 448

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 433.40 Hz (-26.2¢) | 422.15 Hz (-71.7¢) | +45.6¢ |
| per strike (¢) | -27.0 / -25.3 / -27.0 / -25.1 | -73.1 / -70.4 / -73.0 / -69.8 | |
| voice spread | 1.9¢ | 3.3¢ | -1.4¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.4 dB | +1.0 dB |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## vco1Pitch = 476

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 438.87 Hz (-4.4¢) | 436.03 Hz (-15.7¢) | +11.3¢ |
| per strike (¢) | -4.2 / -4.7 / -4.2 / -4.9 | -17.1 / -14.4 / -17.0 / -13.8 | |
| voice spread | 0.7¢ | 3.3¢ | -2.6¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.4 dB | +1.0 dB |
| peak | -29.4 dBFS | -11.5 dBFS | (scales differ) |

## vco1Pitch = 480

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 439.20 Hz (-3.2¢) | 437.03 Hz (-11.7¢) | +8.5¢ |
| per strike (¢) | -4.2 / -1.9 / -4.2 / -2.1 | -13.1 / -10.4 / -13.0 / -9.8 | |
| voice spread | 2.3¢ | 3.3¢ | -1.0¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.4 dB | +1.0 dB |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## vco1Pitch = 492

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 440.48 Hz (+1.9¢) | 440.08 Hz (+0.3¢) | +1.6¢ |
| per strike (¢) | +0.8 / +3.0 / +0.6 / +3.1 | -1.1 / +1.6 / -1.0 / +2.2 | |
| voice spread | 2.4¢ | 3.3¢ | -0.8¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.4 dB | +1.0 dB |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## vco1Pitch = 512

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 440.50 Hz (+1.9¢) | 440.08 Hz (+0.3¢) | +1.7¢ |
| per strike (¢) | +0.6 / +3.2 / +0.7 / +3.5 | -1.1 / +1.6 / -1.0 / +2.2 | |
| voice spread | 2.8¢ | 3.3¢ | -0.4¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.4 dB | +1.0 dB |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## vco1Pitch = 532

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 440.55 Hz (+2.2¢) | 440.08 Hz (+0.3¢) | +1.9¢ |
| per strike (¢) | +0.9 / +3.7 / +0.8 / +3.5 | -1.1 / +1.6 / -1.0 / +2.2 | |
| voice spread | 2.9¢ | 3.3¢ | -0.3¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.4 dB | +1.0 dB |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## vco1Pitch = 544

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 441.52 Hz (+6.0¢) | 443.14 Hz (+12.3¢) | -6.3¢ |
| per strike (¢) | +6.0 / +5.7 / +6.0 / +5.9 | +10.9 / +13.6 / +11.0 / +14.2 | |
| voice spread | 0.3¢ | 3.3¢ | -3.0¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.4 dB | +1.0 dB |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## vco1Pitch = 548

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 441.83 Hz (+7.2¢) | 444.16 Hz (+16.3¢) | -9.1¢ |
| per strike (¢) | +6.0 / +8.5 / +5.9 / +8.4 | +14.9 / +17.6 / +15.0 / +18.2 | |
| voice spread | 2.6¢ | 3.3¢ | -0.6¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.4 dB | +1.0 dB |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## vco1Pitch = 576

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 447.36 Hz (+28.7¢) | 458.76 Hz (+72.3¢) | -43.6¢ |
| per strike (¢) | +28.8 / +28.7 / +28.7 / +28.9 | +70.9 / +73.6 / +71.0 / +74.2 | |
| voice spread | 0.3¢ | 3.3¢ | -3.0¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.4 dB | +1.0 dB |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## vco1Pitch = 608

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 454.02 Hz (+54.3¢) | 476.04 Hz (+136.3¢) | -82.0¢ |
| per strike (¢) | +54.1 / +54.5 / +54.0 / +54.6 | +134.9 / +137.6 / +135.0 / +138.2 | |
| voice spread | 0.6¢ | 3.3¢ | -2.7¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.4 dB | -13.4 dB | +1.0 dB |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## vco1Pitch = 640

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 460.73 Hz (+79.7¢) | 493.97 Hz (+200.3¢) | -120.6¢ |
| per strike (¢) | +79.4 / +80.0 / +79.5 / +80.1 | +198.9 / +201.6 / +199.0 / +202.2 | |
| voice spread | 0.6¢ | 3.3¢ | -2.6¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.5 dB | -13.4 dB | +1.0 dB |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## vco1Pitch = 668

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 466.88 Hz (+102.6¢) | 510.21 Hz (+256.3¢) | -153.7¢ |
| per strike (¢) | +102.3 / +103.0 / +102.3 / +103.2 | +254.9 / +257.6 / +255.0 / +258.2 | |
| voice spread | 0.8¢ | 3.3¢ | -2.5¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.5 dB | -13.5 dB | +1.0 dB |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## vco1Pitch = 672

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 469.68 Hz (+113.0¢) | 513.38 Hz (+267.0¢) | -154.0¢ |
| per strike (¢) | +112.7 / +113.4 / +112.7 / +113.5 | +265.7 / +268.3 / +265.7 / +268.9 | |
| voice spread | 0.8¢ | 3.3¢ | -2.5¢ |
| H2 | -6.3 dB | -7.1 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.5 dB | -13.5 dB | +1.0 dB |
| peak | -29.3 dBFS | -11.5 dBFS | (scales differ) |

## vco1Pitch = 704

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 497.92 Hz (+214.1¢) | 539.47 Hz (+352.8¢) | -138.7¢ |
| per strike (¢) | +214.3 / +213.9 / +214.4 / +213.4 | +351.5 / +354.1 / +351.5 / +354.8 | |
| voice spread | 0.9¢ | 3.3¢ | -2.3¢ |
| H2 | -6.3 dB | -7.2 dB | +0.8 dB |
| H3 | -9.9 dB | -10.8 dB | +0.9 dB |
| H4 | -12.5 dB | -13.5 dB | +1.0 dB |
| peak | -29.2 dBFS | -11.6 dBFS | (scales differ) |

## vco1Pitch = 736

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 527.35 Hz (+313.5¢) | 566.88 Hz (+438.7¢) | -125.2¢ |
| per strike (¢) | +313.5 / +313.4 / +313.5 / +313.6 | +437.3 / +440.0 / +437.3 / +440.6 | |
| voice spread | 0.1¢ | 3.3¢ | -3.1¢ |
| H2 | -6.3 dB | -7.2 dB | +0.8 dB |
| H3 | -9.9 dB | -10.9 dB | +0.9 dB |
| H4 | -12.5 dB | -13.5 dB | +1.0 dB |
| peak | -29.2 dBFS | -11.6 dBFS | (scales differ) |

## vco1Pitch = 768

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 558.54 Hz (+413.0¢) | 595.69 Hz (+524.5¢) | -111.5¢ |
| per strike (¢) | +412.7 / +413.6 / +412.7 / +413.3 | +523.1 / +525.8 / +523.2 / +526.4 | |
| voice spread | 0.9¢ | 3.3¢ | -2.3¢ |
| H2 | -6.3 dB | -7.2 dB | +0.8 dB |
| H3 | -9.9 dB | -10.9 dB | +0.9 dB |
| H4 | -12.5 dB | -13.5 dB | +1.0 dB |
| peak | -29.3 dBFS | -11.6 dBFS | (scales differ) |

## vco1Pitch = 800

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 591.50 Hz (+512.2¢) | 625.96 Hz (+610.3¢) | -98.0¢ |
| per strike (¢) | +511.6 / +512.9 / +511.6 / +513.0 | +608.9 / +611.6 / +609.0 / +612.2 | |
| voice spread | 1.4¢ | 3.3¢ | -1.9¢ |
| H2 | -6.3 dB | -7.2 dB | +0.8 dB |
| H3 | -9.9 dB | -10.9 dB | +1.0 dB |
| H4 | -12.5 dB | -13.5 dB | +1.0 dB |
| peak | -29.3 dBFS | -11.6 dBFS | (scales differ) |

## vco1Pitch = 832

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 626.92 Hz (+612.9¢) | 657.78 Hz (+696.1¢) | -83.2¢ |
| per strike (¢) | +613.0 / +612.6 / +613.0 / +612.8 | +694.7 / +697.4 / +694.8 / +698.0 | |
| voice spread | 0.5¢ | 3.3¢ | -2.8¢ |
| H2 | -6.3 dB | -7.2 dB | +0.8 dB |
| H3 | -9.9 dB | -10.9 dB | +1.0 dB |
| H4 | -12.5 dB | -13.6 dB | +1.0 dB |
| peak | -29.3 dBFS | -11.6 dBFS | (scales differ) |

## vco1Pitch = 864

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 663.83 Hz (+712.0¢) | 691.20 Hz (+781.9¢) | -70.0¢ |
| per strike (¢) | +711.8 / +712.5 / +711.8 / +712.2 | +780.6 / +783.2 / +780.6 / +783.8 | |
| voice spread | 0.7¢ | 3.3¢ | -2.6¢ |
| H2 | -6.3 dB | -7.2 dB | +0.8 dB |
| H3 | -10.0 dB | -10.9 dB | +1.0 dB |
| H4 | -12.6 dB | -13.6 dB | +1.0 dB |
| peak | -29.3 dBFS | -11.6 dBFS | (scales differ) |

## vco1Pitch = 896

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 703.95 Hz (+813.6¢) | 726.33 Hz (+867.8¢) | -54.2¢ |
| per strike (¢) | +813.0 / +814.2 / +815.2 / +812.9 | +866.4 / +869.1 / +866.4 / +869.7 | |
| voice spread | 2.3¢ | 3.3¢ | -1.0¢ |
| H2 | -6.3 dB | -7.2 dB | +0.8 dB |
| H3 | -10.0 dB | -10.9 dB | +1.0 dB |
| H4 | -12.6 dB | -13.6 dB | +1.0 dB |
| peak | -29.3 dBFS | -11.6 dBFS | (scales differ) |

## vco1Pitch = 928

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 745.12 Hz (+912.0¢) | 763.24 Hz (+953.6¢) | -41.6¢ |
| per strike (¢) | +912.4 / +911.4 / +912.5 / +911.5 | +952.2 / +954.9 / +952.3 / +955.5 | |
| voice spread | 1.1¢ | 3.3¢ | -2.2¢ |
| H2 | -6.3 dB | -7.2 dB | +0.9 dB |
| H3 | -10.0 dB | -11.0 dB | +1.0 dB |
| H4 | -12.6 dB | -13.7 dB | +1.1 dB |
| peak | -29.3 dBFS | -11.7 dBFS | (scales differ) |

## vco1Pitch = 960

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 789.77 Hz (+1012.7¢) | 802.03 Hz (+1039.4¢) | -26.7¢ |
| per strike (¢) | +1012.5 / +1013.5 / +1012.5 / +1012.9 | +1038.0 / +1040.7 / +1038.1 / +1041.3 | |
| voice spread | 1.0¢ | 3.3¢ | -2.2¢ |
| H2 | -6.3 dB | -7.2 dB | +0.9 dB |
| H3 | -10.0 dB | -11.0 dB | +1.0 dB |
| H4 | -12.6 dB | -13.7 dB | +1.1 dB |
| peak | -29.4 dBFS | -11.7 dBFS | (scales differ) |

## vco1Pitch = 992

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 836.61 Hz (+1112.5¢) | 842.79 Hz (+1125.2¢) | -12.7¢ |
| per strike (¢) | +1112.4 / +1112.6 / +1112.4 / +1112.5 | +1123.8 / +1126.5 / +1123.9 / +1127.1 | |
| voice spread | 0.2¢ | 3.3¢ | -3.1¢ |
| H2 | -6.3 dB | -7.2 dB | +0.9 dB |
| H3 | -10.0 dB | -11.0 dB | +1.0 dB |
| H4 | -12.7 dB | -13.8 dB | +1.1 dB |
| peak | -29.5 dBFS | -11.7 dBFS | (scales differ) |

## vco1Pitch = 1020

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 880.93 Hz (+1201.8¢) | 880.15 Hz (+1200.3¢) | +1.5¢ |
| per strike (¢) | +1201.7 / +1201.9 / +1201.8 / +1202.0 | +1198.9 / +1201.6 / +1199.0 / +1202.2 | |
| voice spread | 0.3¢ | 3.3¢ | -3.0¢ |
| H2 | -6.3 dB | -7.2 dB | +0.9 dB |
| H3 | -10.0 dB | -11.0 dB | +1.0 dB |
| H4 | -12.7 dB | -13.8 dB | +1.1 dB |
| peak | -29.5 dBFS | -11.7 dBFS | (scales differ) |

## vco1Pitch = 1023

| metric | hardware | replica | Δ |
|---|---|---|---|
| f0 (median) | 880.94 Hz (+1201.9¢) | 880.15 Hz (+1200.3¢) | +1.6¢ |
| per strike (¢) | +1201.7 / +1202.0 / +1201.8 / +1201.9 | +1198.9 / +1201.6 / +1199.0 / +1202.2 | |
| voice spread | 0.3¢ | 3.3¢ | -3.0¢ |
| H2 | -6.3 dB | -7.2 dB | +0.9 dB |
| H3 | -10.0 dB | -11.0 dB | +1.0 dB |
| H4 | -12.7 dB | -13.8 dB | +1.1 dB |
| peak | -29.5 dBFS | -11.7 dBFS | (scales differ) |

Harmonics are dB relative to H1 within each world, so Δ is comparable;
peak levels are absolute per world (interface gain vs engine units).

## Proposals

### pitch (cents)

- current: `pitchToCents(raw) (documented table)`
- proposed: `monotone table (43 pts)`
- residual (log RMS): fit 0.00433%, held-out 0.104%
- provenance: MEASURED(2026-07-13)
- coverage: 43/43 planned points
- raw 32: Δ+15.0¢ vs documented pitchToCents
- raw 64: Δ+28.5¢ vs documented pitchToCents
- raw 96: Δ+42.8¢ vs documented pitchToCents
- raw 100: Δ+44.9¢ vs documented pitchToCents
- raw 128: Δ+55.8¢ vs documented pitchToCents
- raw 160: Δ+71.3¢ vs documented pitchToCents
- raw 192: Δ+84.5¢ vs documented pitchToCents
- raw 224: Δ+98.7¢ vs documented pitchToCents
- raw 256: Δ+113.3¢ vs documented pitchToCents
- raw 288: Δ+127.1¢ vs documented pitchToCents
- raw 320: Δ+142.4¢ vs documented pitchToCents
- raw 352: Δ+156.3¢ vs documented pitchToCents
- raw 356: Δ+158.3¢ vs documented pitchToCents
- raw 384: Δ+122.7¢ vs documented pitchToCents
- raw 400: Δ+103.5¢ vs documented pitchToCents
- raw 416: Δ+84.3¢ vs documented pitchToCents
- raw 448: Δ+45.8¢ vs documented pitchToCents
- raw 476: Δ+11.6¢ vs documented pitchToCents
- raw 480: Δ+8.8¢ vs documented pitchToCents
- raw 544: Δ-6.0¢ vs documented pitchToCents
- raw 548: Δ-8.8¢ vs documented pitchToCents
- raw 576: Δ-43.3¢ vs documented pitchToCents
- raw 608: Δ-81.7¢ vs documented pitchToCents
- raw 640: Δ-120.3¢ vs documented pitchToCents
- raw 668: Δ-153.4¢ vs documented pitchToCents
- raw 672: Δ-153.7¢ vs documented pitchToCents
- raw 704: Δ-138.4¢ vs documented pitchToCents
- raw 736: Δ-124.9¢ vs documented pitchToCents
- raw 768: Δ-111.2¢ vs documented pitchToCents
- raw 800: Δ-97.8¢ vs documented pitchToCents
- raw 832: Δ-82.9¢ vs documented pitchToCents
- raw 864: Δ-69.7¢ vs documented pitchToCents
- raw 896: Δ-53.9¢ vs documented pitchToCents
- raw 928: Δ-41.3¢ vs documented pitchToCents
- raw 960: Δ-26.4¢ vs documented pitchToCents
- raw 992: Δ-12.4¢ vs documented pitchToCents
- 36/43 points deviate > 3¢ — proposing a monotone replacement table
- final table refit on all 43 points (held-out folded in after family selection)
- pitch residual: fit 0.07¢ RMS, held-out 1.80¢ RMS

| raw | cents |
|---|---|
| 0 | -1198.4 |
| 4 | -1198.4 |
| 32 | -1109.9 |
| 64 | -1010.6 |
| 96 | -910.49 |
| 100 | -897.67 |
| 128 | -811.63 |
| 160 | -710.29 |
| 192 | -611.36 |
| 224 | -511.35 |
| 256 | -410.91 |
| 288 | -311.24 |
| 320 | -210.11 |
| 352 | -110.45 |
| 356 | -97.678 |
| 384 | -77.271 |
| 400 | -64.541 |
| 416 | -51.656 |
| 448 | -26.151 |
| 476 | -4.4492 |
| 480 | -3.1627 |
| 492 | 1.8831 |
| 512 | 1.9497 |
| 532 | 2.1773 |
| 544 | 5.9524 |
| 548 | 7.191 |
| 576 | 28.725 |
| 608 | 54.302 |
| 640 | 79.719 |
| 668 | 102.64 |
| 672 | 113.02 |
| 704 | 214.11 |
| 736 | 313.5 |
| 768 | 412.98 |
| 800 | 512.25 |
| 832 | 612.92 |
| 864 | 711.97 |
| 896 | 813.56 |
| 928 | 911.96 |
| 960 | 1012.7 |
| 992 | 1112.5 |
| 1020 | 1201.8 |
| 1023 | 1201.9 |
