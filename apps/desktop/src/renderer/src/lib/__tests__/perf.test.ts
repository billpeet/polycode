import { afterEach, expect, it, vi } from 'vitest'
import { installRendererPerfObservers } from '../perf'

afterEach(() => vi.restoreAllMocks())

it('drops sleep artifacts, resumes monitoring, and reports signed heap deltas', () => {
  let now = 0
  let heap = 1000
  let observe!: (list: { getEntries: () => unknown[] }) => void
  let frame!: (time: number) => void
  let heartbeat!: () => void
  const send = vi.fn()
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('performance', { now: () => now, get memory() { return { usedJSHeapSize: heap } } })
  vi.stubGlobal('window', {
    api: { send },
    requestAnimationFrame: (callback: typeof frame) => { frame = callback },
    setInterval: (callback: typeof heartbeat) => { heartbeat = callback },
  })
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {} })
  vi.stubGlobal('PerformanceObserver', class {
    constructor(callback: typeof observe) { observe = callback }
    observe() {}
  })
  try {
    installRendererPerfObservers()
    now = 70_000
    frame(now)
    heartbeat()
    observe({ getEntries: () => [{ duration: 244_000, name: 'unknown', entryType: 'longtask' }] })
    expect(send).not.toHaveBeenCalled()
    now += 1000
    heap = 800
    frame(now)
    heartbeat()
    observe({ getEntries: () => [{ duration: 75, name: 'unknown', entryType: 'longtask' }] })
    const reports = send.mock.calls.filter(([channel]) => channel === 'telemetry:duration').map(([, report]) => report)
    expect(reports.map(report => report.name)).toEqual([
      'polycode.renderer.frame-jank', 'polycode.renderer.event-loop-stall', 'polycode.renderer.long-task',
    ])
    expect(send.mock.calls.find(([channel, report]) => channel === 'log:write' && report.messages[0].includes('long-task'))?.[1].messages[1]).toContain('heapUsedBytes=800 heapDeltaBytes=-200')
    expect(reports[2].attributes).not.toHaveProperty('heapUsedBytes')
    heap = 700
    observe({ getEntries: () => [{ duration: 80, name: 'unknown', entryType: 'longtask' }] })
    expect(send.mock.calls.filter(([channel]) => channel === 'telemetry:duration')).toHaveLength(3)
  } finally {
    vi.unstubAllGlobals()
  }
})

it('buckets content sizes into a bounded label set', async () => {
  const { sizeBucket } = await import('../perf')
  expect([0, 99, 100, 1999, 2000, 49_999, 199_999, 200_000, 5_000_000].map(sizeBucket)).toEqual([
    '<100', '<100', '<500', '<2000', '<10000', '<50000', '<200000', '>=200000', '>=200000',
  ])
  expect(sizeBucket(-1)).toBe('unknown')
  expect(sizeBucket(Number.NaN)).toBe('unknown')
})

it('does not report a hidden window as stalled once it is shown again', () => {
  // Past the first test's clock: reportPerf's throttle map is module-level.
  let now = 500_000
  let heartbeat!: () => void
  let frame!: (time: number) => void
  let onVisibility: () => void = () => {}
  const send = vi.fn()
  const doc = { visibilityState: 'visible', addEventListener: (_: string, cb: () => void) => { onVisibility = cb } }
  vi.stubGlobal('performance', { now: () => now })
  vi.stubGlobal('window', {
    api: { send },
    requestAnimationFrame: (callback: typeof frame) => { frame = callback },
    setInterval: (callback: typeof heartbeat) => { heartbeat = callback },
  })
  vi.stubGlobal('document', doc)
  vi.stubGlobal('PerformanceObserver', undefined)
  try {
    installRendererPerfObservers()
    now = 500_100
    heartbeat()
    frame(now)
    // Window goes to the background; Chromium stops firing the timer for 20s.
    doc.visibilityState = 'hidden'
    onVisibility()
    now = 520_100
    doc.visibilityState = 'visible'
    onVisibility()
    heartbeat()
    frame(now)
    expect(send).not.toHaveBeenCalled()
    // A real stall while visible is still reported.
    now = 520_200
    heartbeat()
    now = 525_200
    heartbeat()
    const stalls = send.mock.calls.filter(([channel, report]) => channel === 'telemetry:duration' && report.name === 'polycode.renderer.event-loop-stall')
    expect(stalls).toHaveLength(1)
    expect(stalls[0][1].durationMs).toBeCloseTo(4900, 0)
  } finally {
    vi.unstubAllGlobals()
  }
})
