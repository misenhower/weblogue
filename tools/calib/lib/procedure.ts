/**
 * Measurement-method version, independent from synth profile versions.
 * Profiles use vN; procedures use RN (for example: profile v5, procedure R2).
 */
export const CALIBRATION_PROCEDURE = {
  id: 'xd-hardware-calibration',
  revision: 2,
} as const

export type CalibrationProcedure = typeof CALIBRATION_PROCEDURE
