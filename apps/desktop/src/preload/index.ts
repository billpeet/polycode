import { contextBridge, ipcRenderer } from 'electron'
import { isLocalChannel } from '@polycode/shared'
import { getHeapStatistics } from 'node:v8'

export type IpcListener = (...args: unknown[]) => void

// ── Slow-invoke signal ───────────────────────────────────────────────────────
//
// Every request/response call already flows through api.invoke, which makes this the one
// place that can cheaply notice "something the UI asked for is taking a while". Listeners
// get the number of calls currently in flight past the threshold; the renderer decides
// whether that means anything (it only surfaces the signal while a remote host is active,
// where the delay is network distance rather than local work).
const SLOW_INVOKE_THRESHOLD_MS = 400

type SlowInvokeListener = (pendingSlowCalls: number) => void
const slowInvokeListeners = new Set<SlowInvokeListener>()
let pendingSlowCalls = 0

function notifySlowInvoke(): void {
  for (const listener of slowInvokeListeners) {
    try {
      listener(pendingSlowCalls)
    } catch {
      // A broken listener must not take down IPC timing for everyone else.
    }
  }
}

function trackSlowInvoke(promise: Promise<unknown>): void {
  let counted = false
  const timer = setTimeout(() => {
    counted = true
    pendingSlowCalls += 1
    notifySlowInvoke()
  }, SLOW_INVOKE_THRESHOLD_MS)
  void promise.finally(() => {
    clearTimeout(timer)
    if (counted) {
      pendingSlowCalls -= 1
      notifySlowInvoke()
    }
  }).catch(() => undefined)
}

const api = {
  /**
   * Request/response calls are allowlisted from the channel registry, which makes it a
   * runtime trust boundary rather than only a typing convenience. Anything renderer code
   * can reach must be declared `local: true` in CHANNEL_REGISTRY.
   *
   * `on` and `send` are deliberately not gated: they carry streaming event channels
   * (`thread:output:${threadId}`, `command:*`, `log:write`) which are per-thread and
   * per-command, so they are not enumerable in the registry.
   */
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!isLocalChannel(channel)) {
      return Promise.reject(
        new Error(`Blocked IPC channel "${channel}" — not declared local in CHANNEL_REGISTRY`),
      )
    }
    const startedAt = performance.now()
    const pending = ipcRenderer.invoke(channel, ...args)
    trackSlowInvoke(pending)
    return pending.finally(() => {
      const durationMs = performance.now() - startedAt
      if (durationMs >= 50) {
        ipcRenderer.send('log:write', {
          source: 'renderer',
          level: durationMs >= 250 ? 'warn' : 'debug',
          timestamp: new Date().toISOString(),
          messages: [`[perf][renderer-ipc] ${channel} ${durationMs.toFixed(1)}ms`],
        })
      }
    })
  },

  on(channel: string, callback: IpcListener): () => void {
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void =>
      callback(...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },

  send(channel: string, ...args: unknown[]): void {
    ipcRenderer.send(channel, ...args)
  },

  /**
   * Subscribe to the count of invoke calls currently in flight past the slow threshold.
   * Fires only on transitions (a call crossing the threshold, or such a call settling).
   */
  onSlowInvoke(callback: (pendingSlowCalls: number) => void): () => void {
    slowInvokeListeners.add(callback)
    return () => slowInvokeListeners.delete(callback)
  }
}

contextBridge.exposeInMainWorld('api', api)

const MEMORY_SAMPLE_INTERVAL_MS = 30_000

async function reportMemory(): Promise<void> {
  const [memory, heap] = await Promise.all([
    process.getProcessMemoryInfo(),
    Promise.resolve(getHeapStatistics()),
  ])
  ipcRenderer.send('telemetry:memory', {
    process: 'renderer',
    privateBytes: memory.private * 1024,
    residentSetBytes: memory.residentSet * 1024,
    sharedBytes: memory.shared * 1024,
    heapUsedBytes: heap.used_heap_size,
    heapTotalBytes: heap.total_heap_size,
    heapLimitBytes: heap.heap_size_limit,
  })
}

function reportMemorySafely(): void {
  void reportMemory().catch((error) => {
    ipcRenderer.send('log:write', {
      source: 'renderer',
      level: 'warn',
      timestamp: new Date().toISOString(),
      messages: [`[telemetry] Memory sample failed: ${String(error)}`],
    })
  })
}

reportMemorySafely()
setInterval(reportMemorySafely, MEMORY_SAMPLE_INTERVAL_MS)
