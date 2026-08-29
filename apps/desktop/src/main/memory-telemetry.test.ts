import { beforeEach, describe, expect, it, vi } from 'vitest'

const { recordGauge } = vi.hoisted(() => ({ recordGauge: vi.fn() }))

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3' },
}))
vi.mock('./observability', () => ({ recordGauge }))

import { recordMemorySample } from './memory-telemetry'

describe('memory telemetry', () => {
  beforeEach(() => recordGauge.mockClear())

  it('records process and heap byte gauges with bounded attributes', () => {
    recordMemorySample({
      process: 'renderer',
      privateBytes: 1,
      residentSetBytes: 2,
      sharedBytes: 3,
      heapUsedBytes: 4,
      heapTotalBytes: 5,
      heapLimitBytes: 6,
    })

    expect(recordGauge.mock.calls).toEqual([
      ['polycode.process.memory.private', 1, 'By', { 'polycode.process.type': 'renderer', 'polycode.release': '1.2.3' }],
      ['polycode.process.memory.resident_set', 2, 'By', { 'polycode.process.type': 'renderer', 'polycode.release': '1.2.3' }],
      ['polycode.process.memory.shared', 3, 'By', { 'polycode.process.type': 'renderer', 'polycode.release': '1.2.3' }],
      ['polycode.process.heap.used', 4, 'By', { 'polycode.process.type': 'renderer', 'polycode.release': '1.2.3' }],
      ['polycode.process.heap.total', 5, 'By', { 'polycode.process.type': 'renderer', 'polycode.release': '1.2.3' }],
      ['polycode.process.heap.limit', 6, 'By', { 'polycode.process.type': 'renderer', 'polycode.release': '1.2.3' }],
    ])
  })
})
