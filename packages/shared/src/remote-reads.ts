/** Only cache refreshes may be coalesced or deferred. Never include mutations. */
const REFRESH_CHANNELS = new Set([
  'projects:list', 'threads:list', 'threads:listQueue', 'threads:listArchived',
  'threads:listSnoozed', 'threads:archivedCount', 'threads:snoozedCount',
  'sessions:list', 'messages:list', 'messages:listBySession',
])

function backpressure(): Error {
  return new Error('[REMOTE_REQUEST_TIMEOUT] Remote host is busy. Showing last synced data; refresh will retry shortly.')
}

/** One instance per host connection. Limits reads without delaying user mutations. */
export class RemoteReads {
  private pending = new Map<string, Promise<unknown>>()
  private queue: Array<() => void> = []
  private active = 0
  private timeouts: number[] = []
  private retryAt = 0
  private degraded = false
  private disposed = false

  constructor(private readonly onDegraded: (degraded: boolean) => void = () => {}) {}

  dispose(): void {
    this.disposed = true
    this.pump()
  }

  invoke(channel: string, args: unknown[], operation: () => Promise<unknown>): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('[REMOTE_UNAVAILABLE] Remote connection changed'))
    if (!REFRESH_CHANNELS.has(channel)) return operation()
    const key = JSON.stringify([channel, args])
    const existing = this.pending.get(key)
    if (existing) return existing
    if (Date.now() < this.retryAt || this.queue.length >= 64) return Promise.reject(backpressure())

    const pending = new Promise<unknown>((resolve, reject) => {
      this.queue.push(() => {
        if (this.disposed) {
          reject(new Error('[REMOTE_UNAVAILABLE] Remote connection changed'))
          return
        }
        if (Date.now() < this.retryAt) {
          reject(backpressure())
          return
        }
        this.active++
        const startedAt = Date.now()
        void (async () => {
          try {
            const value = await operation()
            // Only a successful recovery probe clears the stall, not an older request.
            if (!this.disposed && this.degraded && startedAt >= this.retryAt) {
              this.degraded = false
              this.timeouts = []
              this.onDegraded(false)
            }
            resolve(value)
          } catch (error) {
            if (!this.disposed && /REMOTE_REQUEST_TIMEOUT|RemoteRequestTimeoutError/.test(String(error))) {
              const now = Date.now()
              this.timeouts = this.timeouts.filter((time) => now - time <= 10_000)
              this.timeouts.push(now)
              if (this.degraded || this.timeouts.length >= 3) {
                this.retryAt = now + 30_000
                if (!this.degraded) {
                  this.degraded = true
                  this.onDegraded(true)
                }
              }
            }
            reject(error)
          } finally {
            this.active--
            this.pump()
          }
        })()
      })
    })
    this.pending.set(key, pending)
    const cleanup = () => { this.pending.delete(key) }
    void pending.then(cleanup, cleanup)
    this.pump()
    return pending
  }

  private pump(): void {
    // After cooldown, let one read prove the RPC endpoint has recovered.
    while ((this.disposed || this.active < (this.degraded ? 1 : 4)) && this.queue.length) this.queue.shift()!()
  }
}
