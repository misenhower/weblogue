import { describe, expect, it } from 'vitest'
import { runCalibrationSweep, withRestoredState } from '../tools/calib/lib/runner'

describe('calibration hardware-run orchestration', () => {
  it('retries point failures, performs end recovery, and preserves point order', async () => {
    const attempts = new Map<number, number>()
    const result = await runCalibrationSweep<number>({
      pointCount: 3,
      prepare: async () => {},
      capture: async (index) => {
        const n = (attempts.get(index) ?? 0) + 1
        attempts.set(index, n)
        if (index === 1 && n <= 2) throw new Error('transient')
        return index * 10
      },
      isInfrastructureError: () => false,
    })
    expect(result.values).toEqual([0, 10, 20])
    expect(result.recovered).toEqual([1])
    expect(attempts.get(1)).toBe(3)
  })

  it('restores the edit buffer even when the run throws', async () => {
    const events: string[] = []
    await expect(
      withRestoredState(
        async () => {
          events.push('backup')
          return 'original'
        },
        async () => {
          events.push('run')
          throw new Error('capture failed')
        },
        async (value) => {
          events.push(`restore:${value}`)
        },
      ),
    ).rejects.toThrow('capture failed')
    expect(events).toEqual(['backup', 'run', 'restore:original'])
  })

  it('does not retry software post-processing errors', async () => {
    let captures = 0
    await expect(
      runCalibrationSweep({
        pointCount: 1,
        prepare: async () => {},
        capture: async () => ++captures,
        commit: async () => {
          throw new Error('replica render failed')
        },
        isInfrastructureError: () => false,
      }),
    ).rejects.toThrow('replica render failed')
    expect(captures).toBe(1)
  })

  it('aborts immediately on capture infrastructure failure', async () => {
    const infrastructure = new Error('device disconnected')
    let captures = 0
    await expect(
      runCalibrationSweep({
        pointCount: 2,
        prepare: async () => {},
        capture: async () => {
          captures++
          throw infrastructure
        },
        isInfrastructureError: (error) => error === infrastructure,
      }),
    ).rejects.toBe(infrastructure)
    expect(captures).toBe(1)
  })

  it('does not perform end recovery when every point failed', async () => {
    let captures = 0
    const result = await runCalibrationSweep({
      pointCount: 2,
      prepare: async () => {},
      capture: async () => {
        captures++
        throw new Error('bad point')
      },
      isInfrastructureError: () => false,
    })
    expect(result.values).toEqual([null, null])
    expect(result.recovered).toEqual([])
    expect(captures).toBe(4)
  })

  it('reports restoration failure without replacing a successful run result', async () => {
    const restoreErrors: unknown[] = []
    const value = await withRestoredState(
      async () => 'original',
      async () => 42,
      async () => {
        throw new Error('restore failed')
      },
      (error) => restoreErrors.push(error),
    )
    expect(value).toBe(42)
    expect((restoreErrors[0] as Error).message).toBe('restore failed')
  })
})
