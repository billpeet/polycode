/**
 * Coalesces a burst of items into one `flush` call per interval.
 *
 * Streaming providers deliver `thread:output` as many small frames per second. Applying
 * each one to the store meant one React render per frame, and each render re-grouped the
 * transcript, re-estimated row heights and re-parsed the live message's markdown. Grafana
 * showed those renders as back-to-back 100–250ms renderer tasks for the length of a fast
 * turn — the "words come in slowly / the UI locks up" symptom. One flush per interval
 * bounds that work to a fixed number of renders per second regardless of frame rate.
 */
export interface OutputBatcher<T> {
  push(item: T): void
  /** Apply everything pending now, e.g. before a completion handler reads the store. */
  flush(): void
  /** Drop anything pending and stop the timer. */
  dispose(): void
}

export const DEFAULT_FLUSH_INTERVAL_MS = 60

export function createOutputBatcher<T>(
  apply: (items: T[]) => void,
  options: { intervalMs?: number } = {},
): OutputBatcher<T> {
  const intervalMs = options.intervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
  let pending: T[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (pending.length === 0) return
    const items = pending
    pending = []
    apply(items)
  }

  return {
    push(item) {
      if (disposed) return
      pending.push(item)
      // Trailing timer: the first frame of a burst waits one interval, later frames join it.
      if (!timer) timer = setTimeout(flush, intervalMs)
    },
    flush,
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
      pending = []
    },
  }
}
