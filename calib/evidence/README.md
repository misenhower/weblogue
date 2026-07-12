# Canonical calibration evidence

Exploratory sessions and every raw WAV remain local under `calib/sessions/`.
When a fitting or independent verification session is worth preserving, run:

```bash
npm run calib -- evidence <session-name>
npm run calib -- evidence <fit-session> --candidate-profile v5
```

That command copies only `job.json`, `meta.json`, `features.json`, and
`report.md` here, adds SHA-256 checksums and the procedure revision, and removes
machine-specific absolute paths from the report. Fitting evidence is also bound
to the candidate profile ID and content digest. Measurement payloads are
immutable; verification artifacts live separately in `calib/verifications/`.
Promotion is transactional: the bundle is checksummed and validated in a
temporary directory, then atomically renamed into place.
Delete and deliberately re-promote evidence if the extractor changes and the
session is remeasured.

Do not manually copy raw audio into this directory. Large raw archives belong
in local or external storage; their optional archive checksum can be recorded
in the evidence notes without committing the audio itself.
