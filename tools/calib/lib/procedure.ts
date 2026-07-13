/**
 * Measurement-method version, independent from synth profile versions.
 * Profiles use vN; procedures use RN (for example: profile v5, procedure R1).
 * R1 is the first numbered procedure: the suite as it stands — canonical
 * evidence, independent off-grid verification, gated acceptance, structured
 * unit/session metadata. The dev-era rounds that produced profiles v1-v4
 * predate procedure numbering entirely and carry no tag.
 */
export const CALIBRATION_PROCEDURE = {
  id: 'xd-hardware-calibration',
  revision: 1,
} as const

export type CalibrationProcedure = typeof CALIBRATION_PROCEDURE
