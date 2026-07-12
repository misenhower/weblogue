/* Hardware-independent orchestration for calibration capture retries/restoration. */

export type CapturePhase = 'initial' | 'recovery'

export interface CalibrationSweepAdapter<T> {
  pointCount: number
  prepare(index: number, phase: CapturePhase): Promise<void>
  capture(index: number, phase: CapturePhase, attempt: number): Promise<T>
  /** Successful post-processing is deliberately outside the retry catch;
   * software/render errors must abort rather than masquerade as bad audio. */
  commit?(index: number, value: T, phase: CapturePhase): void | Promise<void>
  isInfrastructureError(error: unknown): boolean
  onFailure?(index: number, error: unknown, willRetry: boolean, phase: CapturePhase): void
}

export interface CalibrationSweepResult<T> {
  values: (T | null)[]
  recovered: number[]
  errors: (unknown | null)[]
}

/** Two immediate attempts per point, then one end-of-sweep recovery attempt
 * when at least one other point proved the rig is functioning. */
export async function runCalibrationSweep<T>(
  adapter: CalibrationSweepAdapter<T>,
): Promise<CalibrationSweepResult<T>> {
  const values: (T | null)[] = Array.from({ length: adapter.pointCount }, () => null)
  const errors: (unknown | null)[] = Array.from({ length: adapter.pointCount }, () => null)
  const recovered: number[] = []

  for (let index = 0; index < adapter.pointCount; index++) {
    await adapter.prepare(index, 'initial')
    for (let attempt = 1; attempt <= 2 && values[index] === null; attempt++) {
      let captured: { value: T } | null = null
      try {
        captured = { value: await adapter.capture(index, 'initial', attempt) }
      } catch (error) {
        if (adapter.isInfrastructureError(error)) throw error
        errors[index] = error
        adapter.onFailure?.(index, error, attempt < 2, 'initial')
      }
      if (captured) {
        await adapter.commit?.(index, captured.value, 'initial')
        values[index] = captured.value
      }
    }
  }

  const failed = values.map((value, index) => (value === null ? index : -1)).filter((index) => index >= 0)
  if (failed.length > 0 && failed.length < values.length) {
    for (const index of failed) {
      await adapter.prepare(index, 'recovery')
      let captured: { value: T } | null = null
      try {
        captured = { value: await adapter.capture(index, 'recovery', 1) }
      } catch (error) {
        if (adapter.isInfrastructureError(error)) throw error
        errors[index] = error
        adapter.onFailure?.(index, error, false, 'recovery')
      }
      if (captured) {
        await adapter.commit?.(index, captured.value, 'recovery')
        values[index] = captured.value
        errors[index] = null
        recovered.push(index)
      }
    }
  }
  return { values, recovered, errors }
}

/** Make state restoration an invariant of a hardware operation. */
export async function withRestoredState<S, T>(
  backup: () => Promise<S>,
  work: () => Promise<T>,
  restore: (state: S) => Promise<void>,
  onRestoreError?: (error: unknown) => void,
): Promise<T> {
  const state = await backup()
  try {
    return await work()
  } finally {
    try {
      await restore(state)
    } catch (error) {
      if (onRestoreError) onRestoreError(error)
      else throw error
    }
  }
}
