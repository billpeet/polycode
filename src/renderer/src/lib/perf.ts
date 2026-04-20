import type { ProfilerOnRenderCallback } from 'react'

const DEFAULT_MIN_INTERVAL_MS = 5000
const LONG_TASK_THRESHOLD_MS = 50
const REACT_COMMIT_THRESHOLD_MS = 20
const FRAME_JANK_THRESHOLD_MS = 250

const lastSentAtByKey = new Map<string, number>()

function serializeDetails(details: Record<string, unknown>): string {
  const entries = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      if (typeof value === 'string' && value.length > 120) {
        return `${key}=string(len=${value.length})`
      }
      if (Array.isArray(value)) {
        return `${key}=array(len=${value.length})`
      }
      if (typeof value === 'object' && value !== null) {
        return `${key}=object(keys=${Object.keys(value).slice(0, 6).join(',')})`
      }
      return `${key}=${String(value)}`
    })

  return entries.join(' ')
}

function shouldSend(key: string, minIntervalMs: number): boolean {
  const now = performance.now()
  const lastSentAt = lastSentAtByKey.get(key) ?? -Infinity
  if (now - lastSentAt < minIntervalMs) return false
  lastSentAtByKey.set(key, now)
  return true
}

export function reportPerf(
  name: string,
  durationMs: number,
  details: Record<string, unknown> = {},
  options: {
    thresholdMs?: number
    minIntervalMs?: number
    level?: 'log' | 'info' | 'warn' | 'error' | 'debug'
  } = {}
): void {
  const thresholdMs = options.thresholdMs ?? REACT_COMMIT_THRESHOLD_MS
  if (durationMs < thresholdMs) return

  const key = `${name}:${serializeDetails(details)}`
  if (!shouldSend(key, options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS)) return

  const detailText = serializeDetails(details)
  window.api.send('log:write', {
    source: 'renderer',
    level: options.level ?? 'warn',
    timestamp: new Date().toISOString(),
    messages: [
      `[perf][renderer] ${name} ${durationMs.toFixed(1)}ms`,
      detailText,
    ].filter(Boolean),
  })
}

export const reportReactCommit: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime
) => {
  reportPerf(
    `react-commit:${id}`,
    actualDuration,
    {
      phase,
      baseDuration: baseDuration.toFixed(1),
      startTime: startTime.toFixed(1),
      commitTime: commitTime.toFixed(1),
    },
    { thresholdMs: REACT_COMMIT_THRESHOLD_MS, minIntervalMs: 2000 }
  )
}

export function installRendererPerfObservers(): void {
  if (typeof window === 'undefined') return

  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          reportPerf(
            'long-task',
            entry.duration,
            {
              entryType: entry.entryType,
              name: entry.name,
            },
            { thresholdMs: LONG_TASK_THRESHOLD_MS, minIntervalMs: 2000 }
          )
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch {
      // longtask observation is Chromium-specific; ignore when unavailable
    }
  }

  let previousFrameAt = performance.now()
  const tick = (now: number) => {
    const frameGapMs = now - previousFrameAt
    if (document.visibilityState === 'visible' && frameGapMs >= FRAME_JANK_THRESHOLD_MS) {
      reportPerf(
        'frame-jank',
        frameGapMs,
        {},
        { thresholdMs: FRAME_JANK_THRESHOLD_MS, minIntervalMs: 2000 }
      )
    }
    previousFrameAt = now
    window.requestAnimationFrame(tick)
  }

  window.requestAnimationFrame(tick)
}
