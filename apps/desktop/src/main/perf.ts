import { ipcMain } from 'electron'

const IPC_PROFILING_PATCHED = Symbol.for('polycode.ipcProfilingPatched')
const DEFAULT_IPC_THRESHOLD_MS = 50
const HOT_IPC_THRESHOLD_MS = 16
const MAIN_THREAD_STALL_THRESHOLD_MS = 250
const MAIN_THREAD_STALL_SAMPLE_MS = 1000
const IPC_SUMMARY_INTERVAL_MS = 10_000

interface ChannelStats {
  count: number
  errors: number
  totalMs: number
  maxMs: number
  active: number
  maxActive: number
}

const channelStats = new Map<string, ChannelStats>()

function getChannelStats(channel: string): ChannelStats {
  let stats = channelStats.get(channel)
  if (!stats) {
    stats = { count: 0, errors: 0, totalMs: 0, maxMs: 0, active: 0, maxActive: 0 }
    channelStats.set(channel, stats)
  }
  return stats
}

function installIpcSummaryReporter(): void {
  setInterval(() => {
    const busiest = [...channelStats.entries()]
      .filter(([, stats]) => stats.count > 0)
      .sort((a, b) => b[1].totalMs - a[1].totalMs)
      .slice(0, 10)

    if (busiest.length > 0) {
      const summary = busiest.map(([channel, stats]) => {
        const averageMs = stats.totalMs / stats.count
        return `${channel}{count=${stats.count},avg=${averageMs.toFixed(1)}ms,max=${stats.maxMs.toFixed(1)}ms,errors=${stats.errors},concurrency=${stats.maxActive}}`
      }).join(' ')
      console.info(`[perf][ipc-summary] window=${IPC_SUMMARY_INTERVAL_MS}ms ${summary}`)
    }

    channelStats.clear()
  }, IPC_SUMMARY_INTERVAL_MS).unref()
}

type ProfiledIpcMain = typeof ipcMain & {
  [IPC_PROFILING_PATCHED]?: boolean
}

function isHotChannel(channel: string): boolean {
  return (
    channel.startsWith('files:') ||
    channel.startsWith('git:') ||
    channel.startsWith('messages:') ||
    channel.startsWith('plans:') ||
    channel.startsWith('claude-history:') ||
    channel.startsWith('commands:') ||
    channel === 'threads:list' ||
    channel === 'threads:listArchived' ||
    channel === 'threads:getModifiedFiles' ||
    channel === 'threads:getLogs' ||
    channel === 'threads:send'
  )
}

function getIpcThresholdMs(channel: string): number {
  return isHotChannel(channel) ? HOT_IPC_THRESHOLD_MS : DEFAULT_IPC_THRESHOLD_MS
}

function summarizeValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 96 ? `string(len=${value.length})` : JSON.stringify(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
    return String(value)
  }
  if (Array.isArray(value)) {
    return `array(len=${value.length})`
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    return `object(keys=${keys.slice(0, 6).join(',')}${keys.length > 6 ? ',…' : ''})`
  }
  return typeof value
}

function summarizeArgs(args: unknown[]): string {
  if (args.length === 0) return 'args=[]'
  return `args=[${args.map((arg) => summarizeValue(arg)).join(', ')}]`
}

export function installIpcProfiling(): void {
  const profiledIpcMain = ipcMain as ProfiledIpcMain
  if (profiledIpcMain[IPC_PROFILING_PATCHED]) return
  profiledIpcMain[IPC_PROFILING_PATCHED] = true
  installIpcSummaryReporter()

  const originalHandle = ipcMain.handle.bind(ipcMain)

  ipcMain.handle = ((channel, listener) => {
    return originalHandle(channel, async (event, ...args) => {
      const startedAt = performance.now()
      let outcome = 'ok'
      const stats = getChannelStats(channel)
      stats.active += 1
      stats.maxActive = Math.max(stats.maxActive, stats.active)

      try {
        return await listener(event, ...args)
      } catch (error) {
        outcome = 'error'
        stats.errors += 1
        throw error
      } finally {
        const durationMs = performance.now() - startedAt
        stats.active -= 1
        stats.count += 1
        stats.totalMs += durationMs
        stats.maxMs = Math.max(stats.maxMs, durationMs)
        const thresholdMs = getIpcThresholdMs(channel)
        if (durationMs >= thresholdMs) {
          console.warn(
            `[perf][ipc] ${channel} ${durationMs.toFixed(1)}ms outcome=${outcome} ${summarizeArgs(args)}`
          )
        }
      }
    })
  }) as typeof ipcMain.handle
}

export function installMainThreadStallMonitor(): void {
  let expectedAt = performance.now() + MAIN_THREAD_STALL_SAMPLE_MS

  setInterval(() => {
    const now = performance.now()
    const driftMs = now - expectedAt
    expectedAt = now + MAIN_THREAD_STALL_SAMPLE_MS

    if (driftMs >= MAIN_THREAD_STALL_THRESHOLD_MS) {
      console.warn(`[perf][main-thread] event-loop-stall ${driftMs.toFixed(1)}ms`)
    }
  }, MAIN_THREAD_STALL_SAMPLE_MS).unref()
}
