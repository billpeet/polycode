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
  vi.stubGlobal('document', { visibilityState: 'visible' })
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
