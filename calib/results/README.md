# Accepted calibration results

`npm run calib -- accept <candidate-evidence> --verification <artifact>` writes small provenance records
under `<profile>/<job-id>.json`, preserving each profile generation without
colliding when several jobs cover one domain. Acceptance requires a verification artifact produced from a separate,
promoted verification session and refuses incomplete coverage, unsupported
domain metrics, regressions, changed evidence/profile content, procedure
mismatches, reused fitting-grid values, or results above the threshold.

Results are write-once. Procedure-R2+ records list the exact `profileFields`
they authorize; `calib validate-profile <id>` requires every field changed
from the profile's declared base to reference one of these records.
