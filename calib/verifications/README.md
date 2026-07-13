# Calibration verification artifacts

`npm run calib -- verify ...` writes reviewable before/after metrics here.
They are separate from immutable measurement evidence and are recomputed by
`calib accept` before an accepted result can be written.
The command publishes them atomically. A FAILed artifact may be re-run in
place; a passing candidate/verification pair is immutable — collect or name
new evidence for another run.
