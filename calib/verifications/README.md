# Calibration verification artifacts

`npm run calib -- verify ...` writes reviewable before/after metrics here.
They are separate from immutable measurement evidence and are recomputed by
`calib accept` before an accepted result can be written.
The command publishes them atomically and refuses to replace an existing
candidate/verification pair; collect or name new evidence for another run.
