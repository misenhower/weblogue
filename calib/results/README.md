# Accepted calibration results

`npm run calib -- accept <candidate-evidence> --verification <artifact>` writes small provenance records
under `<profile>/<domain>.json`, preserving each profile generation. Acceptance requires a verification artifact produced from a separate,
promoted verification session and refuses incomplete coverage, unsupported
domain metrics, regressions, changed evidence/profile content, procedure
mismatches, reused fitting-grid values, or results above the threshold.
