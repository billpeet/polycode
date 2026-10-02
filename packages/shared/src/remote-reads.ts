/** Only cache refreshes may be coalesced or deferred. Never include mutations. */
const REFRESH_CHANNELS = new Set([
  'projects:list', 'threads:list', 'threads:listQueue', 'threads:listArchived',
  'threads:listSnoozed', 'threads:archivedCount', 'threads:snoozedCount',
  'sessions:list', 'messages:list', 'messages:listBySession',
])

/**
 * The Remote Host refuses a ninth concurrent RPC (`remote/server.ts`). Each client stays
 * below that so its own bursts queue here instead of being refused there. Other clients
 * share the host's slots, so this lowers the refusal rate; the busy retry is what makes a
 * refusal harmless.
 */
export const REMOTE_MAX_IN_FLIGHT = 6
const REFRESH_MAX_IN_FLIGHT = 4

/** Backoff before each retry of a refused request; jittered ±50% so a burst does not re-collide. */
const BUSY_RETRY_DELAYS_MS = [150, 400, 1_000]

export const REMOTE_HOST_BUSY = 'REMOTE_HOST_BUSY'

/**
 * Keeps the `[REMOTE_REQUEST_TIMEOUT]` prefix that clients older than this code already
 * classify as an expected transport failure.
 */
export const REMOTE_HOST_BUSY_MESSAGE = '[REMOTE_REQUEST_TIMEOUT] Remote host is busy. This request was not started; retry shortly.'

/**
 * The host refused the request before running its handler. Unlike a timeout, nothing
 * happened host-side, so a retry is safe for every channel, mutations included.
 */
export class RemoteHostBusyError extends Error {
  readonly code = REMOTE_HOST_BUSY

  constructor(message: string = REMOTE_HOST_BUSY_MESSAGE) {
    super(message)
    this.name = 'RemoteHostBusyError'
  }
}

/** Hosts before the typed code answered with a bare 503 whose message says it was not started. */
export function isRemoteHostBusyResponse(status: number, body: { code?: unknown; error?: unknown }): boolean {
  if (body.code === REMOTE_HOST_BUSY) return true
  return status === 503 && typeof body.error === 'string' && body.error.includes('This request was not started')
}

export function isRemoteHostBusyError(error: unknown): boolean {
  if ((error as { code?: unknown } | null)?.code === REMOTE_HOST_BUSY) return true
  return /RemoteHostBusyError|This request was not started/.test(error instanceof Error ? error.message : String(error))
}

/** Re-run `operation` while the host refuses it unstarted; any other outcome settles at once. */
export async function retryWhileHostBusy<T>(operation: () => Promise<T>, stopped: () => boolean = () => false): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      const delay = BUSY_RETRY_DELAYS_MS[attempt]
      if (delay === undefined || stopped() || !isRemoteHostBusyError(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, delay * (0.5 + Math.random())))
      if (stopped()) throw error
    }
  }
}

function backpressure(): Error {
  return new Error('[REMOTE_REQUEST_TIMEOUT] Remote host is busy. Showing last synced data; refresh will retry shortly.')
}

function connectionChanged(): Error {
  return new Error('[REMOTE_UNAVAILABLE] Remote connection changed')
}

type Job = () => void

/**
 * One instance per host connection: the admission gate for every RPC to that host.
 *
 * All calls share `REMOTE_MAX_IN_FLIGHT` slots and are retried while the host is busy.
 * Cache refreshes are additionally coalesced, capped at four slots, and deferred while the
 * host is stalled; every other call is admitted ahead of them and never deferred or dropped.
 */
export class RemoteReads {
  private pending = new Map<string, Promise<unknown>>()
  private calls: Job[] = []
  private refreshes: Job[] = []
  private active = 0
  private activeRefreshes = 0
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
    if (this.disposed) return Promise.reject(connectionChanged())
    if (!REFRESH_CHANNELS.has(channel)) return this.call(operation)
    const key = JSON.stringify([channel, args])
    const existing = this.pending.get(key)
    if (existing) return existing
    if (Date.now() < this.retryAt || this.refreshes.length >= 64) return Promise.reject(backpressure())

    const pending = new Promise<unknown>((resolve, reject) => {
      this.refreshes.push(() => {
        if (this.disposed) {
          reject(connectionChanged())
          return
        }
        if (Date.now() < this.retryAt) {
          reject(backpressure())
          return
        }
        this.active++
        this.activeRefreshes++
        const startedAt = Date.now()
        void (async () => {
          try {
            const value = await this.attempt(operation)
            // Only a successful recovery probe clears the stall, not an older request.
            if (!this.disposed && this.degraded && startedAt >= this.retryAt) {
              this.degraded = false
              this.timeouts = []
              this.onDegraded(false)
            }
            resolve(value)
          } catch (error) {
            // A refusal is load, not a stall: the host answered at once.
            if (!this.disposed && !isRemoteHostBusyError(error) && /REMOTE_REQUEST_TIMEOUT|RemoteRequestTimeoutError/.test(String(error))) {
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
            this.activeRefreshes--
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

  private call(operation: () => Promise<unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.calls.push(() => {
        if (this.disposed) {
          reject(connectionChanged())
          return
        }
        this.active++
        void this.attempt(operation).then(resolve, reject).finally(() => {
          this.active--
          this.pump()
        })
      })
      this.pump()
    })
  }

  private attempt<T>(operation: () => Promise<T>): Promise<T> {
    return retryWhileHostBusy(operation, () => this.disposed)
  }

  private pump(): void {
    if (this.disposed) {
      for (const job of this.calls.splice(0)) job()
      for (const job of this.refreshes.splice(0)) job()
      return
    }
    // After cooldown, let one read prove the RPC endpoint has recovered.
    const refreshLimit = this.degraded ? 1 : REFRESH_MAX_IN_FLIGHT
    while (this.active < REMOTE_MAX_IN_FLIGHT) {
      const job = this.calls.shift() ?? (this.activeRefreshes < refreshLimit ? this.refreshes.shift() : undefined)
      if (!job) return
      job()
    }
  }
}
