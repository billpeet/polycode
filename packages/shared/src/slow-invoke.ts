/**
 * "Something the UI asked for is taking a while."
 *
 * Every request/response call in a client flows through one `invoke`, which makes it the
 * one place that can cheaply notice a slow call. Listeners get the number of calls
 * currently in flight past the threshold; the renderer decides whether that means
 * anything (it surfaces the signal only while talking to a remote host, where the delay
 * is network distance rather than local work).
 */

export const SLOW_INVOKE_THRESHOLD_MS = 400

export type SlowInvokeListener = (pendingSlowCalls: number) => void

export interface SlowInvokeTracker {
  /** Watch one call; counts it once it outlives the threshold, uncounts it when it settles. */
  track(promise: Promise<unknown>): void
  /** Fires only on transitions: a call crossing the threshold, or such a call settling. */
  subscribe(listener: SlowInvokeListener): () => void
}

export function createSlowInvokeTracker(thresholdMs = SLOW_INVOKE_THRESHOLD_MS): SlowInvokeTracker {
  const listeners = new Set<SlowInvokeListener>()
  let pendingSlowCalls = 0

  function notify(): void {
    for (const listener of listeners) {
      try {
        listener(pendingSlowCalls)
      } catch {
        // A broken listener must not take down timing for everyone else.
      }
    }
  }

  return {
    track(promise) {
      let counted = false
      const timer = setTimeout(() => {
        counted = true
        pendingSlowCalls += 1
        notify()
      }, thresholdMs)
      void promise.finally(() => {
        clearTimeout(timer)
        if (counted) {
          pendingSlowCalls -= 1
          notify()
        }
      }).catch(() => undefined)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
