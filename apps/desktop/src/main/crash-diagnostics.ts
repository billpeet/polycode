import { app, dialog, ipcMain, type WebContents } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import * as Sentry from '@sentry/electron/main'
import { writeFatalLog, flushAppLogs } from './app-logger'
import { flushObservability, recordLog } from './observability'
import { latestMemorySamples } from './memory-telemetry'
import { crashBreadcrumbs } from './crash-context'

const reasons = new Set(['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction'])
const views = new Set(['chat', 'diff', 'file', 'command', 'terminal', 'browser', 'tasks', 'files', 'commands', 'plan', 'workspace'])
const processTypes = new Set(['Browser', 'Tab', 'Utility', 'Zygote', 'Sandbox helper', 'GPU', 'Pepper Plugin', 'Pepper Plugin Broker'])

/**
 * Exit code Windows gives processes it terminates while ending the user's
 * session (`DBG_TERMINATE_PROCESS`, 0x40010004). Seen on GPU, Utility and
 * renderer processes when Windows Update restarted the machine (GitHub #97).
 */
export const WINDOWS_SESSION_TERMINATED_EXIT_CODE = 0x40010004

/** Exits closer together than this are one incident. */
const INCIDENT_WINDOW_MS = 1500
/** How long a Windows session-end signal suppresses reports; the user can still cancel a shutdown. */
const SESSION_END_SUPPRESSION_MS = 60_000
const MAX_REPORTED_EXITS = 20

type ShutdownSignal = 'app-quit' | 'windows-session-end' | 'windows-session-terminated'

interface ProcessExit {
  at: number
  processType: string
  reason: string
  exitCode: number | null
  contents?: WebContents
  context: Record<string, unknown>
}

type BeforeSend = (event: Sentry.ErrorEvent, hint: Sentry.EventHint) => Promise<Sentry.ErrorEvent | null>

export function installCrashDiagnostics(options: {
  capture: boolean
  locationId: (contents: WebContents) => string | undefined | null
  /** Test hook: how long to collect exits into one incident. */
  incidentWindowMs?: number
}): BeforeSend {
  const incidentWindowMs = options.incidentWindowMs ?? INCIDENT_WINDOW_MS
  const activeViews = new Map<number, string>()
  let incidents: number[] = []
  let presenting = false
  let pending: ProcessExit[] = []
  let pendingTimer: ReturnType<typeof setTimeout> | undefined
  let shutdown: { signal: ShutdownSignal; at: number } | null = null
  // Sentry carries Electron's details into the native event. Stamp that object
  // before its listeners run, rather than guessing from upload time or a title.
  const nativeIncidents = new Map<string, ProcessExit[]>()
  let pendingIncidentId: string | undefined

  ipcMain.on('telemetry:view', (event, view: unknown) => {
    if (event.sender.getType() === 'window' && typeof view === 'string' && views.has(view)) {
      activeViews.set(event.sender.id, view)
    }
  })

  function signalShutdown(signal: ShutdownSignal): void {
    if (shutdown?.signal === 'app-quit') return
    shutdown = { signal, at: Date.now() }
  }

  /** The app quitting never reverses; a Windows session end can be cancelled. */
  function activeShutdown(): ShutdownSignal | null {
    if (!shutdown) return null
    if (shutdown.signal === 'app-quit') return shutdown.signal
    return Date.now() - shutdown.at < SESSION_END_SUPPRESSION_MS ? shutdown.signal : null
  }

  function incidentShutdown(exits: ProcessExit[]): ShutdownSignal | null {
    // A dump can upload seconds later. A subsequent quit must not turn an
    // earlier unexpected exit into acknowledged teardown.
    return shutdown && shutdown.at <= exits[0].at + incidentWindowMs ? activeShutdown() : null
  }

  function describeExit(details: Electron.RenderProcessGoneDetails, type: string, contents?: WebContents): ProcessExit {
    const location = contents?.getType() === 'webview' ? options.locationId(contents) : null
    let gpu: Record<string, string> = {}
    try { gpu = { ...app.getGPUFeatureStatus() } } catch { /* GPU may be unavailable during startup. */ }
    const reason = reasons.has(details.reason) ? details.reason : 'unknown'
    const exitCode = Number.isInteger(details.exitCode) ? details.exitCode : null
    const context = {
      reason, exitCode,
      processType: type,
      appVersion: app.getVersion(), electronVersion: process.versions.electron,
      chromiumVersion: process.versions.chrome,
      gpu, disableGpu: app.commandLine.hasSwitch('disable-gpu'),
      activeView: contents?.getType() === 'webview' ? 'browser' : contents ? activeViews.get(contents.id) ?? 'unknown' : 'unknown',
      guestLocationId: location ? createHash('sha256').update(location).digest('hex') : null,
      memory: latestMemorySamples(), breadcrumbs: crashBreadcrumbs(),
      shutdownSignal: activeShutdown(),
    }
    return { at: Date.now(), processType: type, reason, exitCode, contents, context }
  }

  function onProcessGone(details: Electron.RenderProcessGoneDetails, type: string, contents?: WebContents): void {
    if (details.reason === 'clean-exit') return
    if (process.platform === 'win32' && details.reason === 'killed' && details.exitCode === WINDOWS_SESSION_TERMINATED_EXIT_CODE) {
      signalShutdown('windows-session-terminated')
    }
    const exit = describeExit(details, type, contents)
    const incidentId = pendingIncidentId ?? randomUUID()
    Object.assign(details, { polycodeIncidentId: incidentId })
    exit.context.incidentId = incidentId
    if (!nativeIncidents.has(incidentId)) {
      nativeIncidents.set(incidentId, [])
      if (nativeIncidents.size > 20) nativeIncidents.delete(nativeIncidents.keys().next().value!)
    }
    nativeIncidents.get(incidentId)!.push(exit)
    // The local log is written at once: the main process may not outlive the burst.
    writeFatalLog('process-gone', JSON.stringify(exit.context))
    flushAppLogs()
    pending.push(exit)
    pendingIncidentId = incidentId
    pendingTimer ??= setTimeout(() => {
      pendingTimer = undefined
      const exits = pending
      pending = []
      pendingIncidentId = undefined
      void resolveIncident(exits).catch(reportFailure)
    }, incidentWindowMs)
  }

  /**
   * One process-tree failure makes Electron report each child separately.
   * Report the burst once, and not at all if the app or the Windows session
   * started ending while it was collected.
   */
  async function resolveIncident(exits: ProcessExit[]): Promise<void> {
    if (exits.length === 0) return
    const signal = incidentShutdown(exits)
    if (signal && exits.every((exit) => exit.reason !== 'crashed' && exit.reason !== 'oom')) {
      writeFatalLog('process-gone-suppressed', JSON.stringify({ shutdownSignal: signal, exits: exits.length }))
      flushAppLogs()
      return
    }
    // The first exit that was not merely killed is the likeliest trigger.
    const primary = exits.find((exit) => exit.reason !== 'killed') ?? exits[0]
    const unexpected = exits.some((exit) => exit.reason !== 'killed')
    const context = {
      ...primary.context,
      shutdownSignal: signal,
      exitCount: exits.length,
      exits: exits.slice(0, MAX_REPORTED_EXITS).map((exit) => ({
        processType: exit.processType, reason: exit.reason, exitCode: exit.exitCode, offsetMs: exit.at - exits[0].at,
      })),
    }
    const breadcrumbs = primary.context.breadcrumbs as ReturnType<typeof crashBreadcrumbs>
    recordLog(unexpected ? 'FATAL' : 'WARN', 'Electron process exited unexpectedly', { 'crash.context': JSON.stringify(context) })
    if (options.capture) Sentry.captureEvent({
      message: 'Electron process exited unexpectedly', level: unexpected ? 'fatal' : 'warning',
      fingerprint: ['process-gone', primary.processType, primary.reason, String(primary.exitCode)],
      tags: {
        source: 'process-gone', processType: primary.processType, reason: primary.reason,
        exitCode: String(primary.exitCode), exitCount: String(exits.length),
        crashIncidentId: String(primary.context.incidentId),
      },
      contexts: { crash: context },
      // Do not inherit SDK breadcrumbs that may contain URLs or IPC payloads.
      breadcrumbs: breadcrumbs.map(({ at, name, durationMs }) => ({
        timestamp: at / 1000, category: 'performance', message: name, data: { durationMs },
      })),
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled([flushObservability(), ...(options.capture ? [Sentry.flush(2000)] : [])]),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 2000) }),
    ])
    clearTimeout(timer)
    const now = Date.now()
    incidents = [...incidents.filter((at) => now - at < 5 * 60_000), now].slice(-3)
    if (!app.isReady() || presenting || activeShutdown()) return
    const renderers = [...new Set(exits.flatMap((exit) => exit.contents && !exit.contents.isDestroyed() ? [exit.contents] : []))]
    // Electron restarts child processes itself. Offer GPU diagnostics if failures repeat.
    // A renderer whose contents were destroyed meanwhile has nothing to recover.
    const repeated = incidents.length >= 3
    const rendererGone = exits.some((exit) => exit.contents)
    if (renderers.length === 0 && (rendererGone || !repeated)) return
    presenting = true
    try {
      const buttons = renderers.length ? ['Reload', 'Dismiss'] : ['Dismiss']
      if (repeated) buttons.push('Restart with GPU disabled')
      const others = exits.length > 1 ? ` ${exits.length - 1} other process exit${exits.length > 2 ? 's' : ''} followed.` : ''
      const { response } = await dialog.showMessageBox({
        type: 'error', title: 'PolyCode process stopped',
        message: `${primary.processType} stopped (${primary.reason}).`,
        detail: 'Diagnostics were written to the app logs.' + others + (repeated ? ' Repeated crashes detected. Restarting stops running sessions; disabling GPU can help diagnose graphics problems.' : ''),
        buttons, cancelId: renderers.length ? 1 : 0, noLink: true,
      })
      if (buttons[response] === 'Reload') {
        for (const contents of renderers) if (!contents.isDestroyed()) contents.reload()
      }
      if (buttons[response] === 'Restart with GPU disabled') {
        app.relaunch({ args: [...process.argv.slice(1).filter((arg) => arg !== '--disable-gpu'), '--disable-gpu'] })
        app.quit()
      }
    } finally { presenting = false }
  }

  function reportFailure(error: unknown): void {
    writeFatalLog('crash-diagnostics-failed', error)
    flushAppLogs()
  }

  // Covers every quit this app starts: window close, updater install, relaunch.
  app.on('before-quit', () => signalShutdown('app-quit'))
  // On Windows, a shutdown, restart or log-off skips `before-quit`.
  app.on('browser-window-created', (_event, window) => {
    window.on('query-session-end', () => signalShutdown('windows-session-end'))
    window.on('session-end', () => signalShutdown('windows-session-end'))
  })
  app.on('web-contents-created', (_event, contents) => {
    const type = contents.getType()
    if (type !== 'window' && type !== 'webview') return
    contents.on('destroyed', () => activeViews.delete(contents.id))
    contents.on('render-process-gone', (_event, details) => {
      try { onProcessGone(details, type === 'webview' ? 'webview' : 'main-renderer', contents) } catch (error) { reportFailure(error) }
    })
  })
  app.on('child-process-gone', (_event, details) => {
    // Service names are arbitrary strings and can contain user data. Report the known type only.
    try { onProcessGone(details, processTypes.has(details.type) ? details.type : 'unknown-child') } catch (error) { reportFailure(error) }
  })

  return async (event, hint) => {
    if (event.platform !== 'native') return event
    const electron = event.contexts?.electron
    const details = electron?.details as { polycodeIncidentId?: unknown } | undefined
    const id = details?.polycodeIncidentId
    const exits = typeof id === 'string' ? nativeIncidents.get(id) : undefined
    // Native dumps found on the next launch have no live exit details. Keep
    // their original release, contexts and attachments; never guess a match.
    if (!exits) return event
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, incidentWindowMs - (Date.now() - exits[0].at))))
    const signal = incidentShutdown(exits)
    const primary = exits.find((exit) => exit.reason !== 'killed') ?? exits[0]
    const dump = hint.attachments?.find((attachment) => attachment.attachmentType === 'event.minidump')
    const minidumpId = dump?.filename.match(/^([a-f0-9-]{36})\.dmp$/i)?.[1]
    // Sentry may load older or other-process dumps in the same callback. The
    // callback marker alone is not sufficient evidence for dropping a dump.
    const data = dump?.data
    const header = data instanceof Uint8Array && data.byteLength >= 32
      ? new DataView(data.buffer, data.byteOffset, data.byteLength) : undefined
    const dumpAt = header?.getUint32(0, true) === 0x504d444d ? header.getUint32(20, true) * 1000 : null
    const nativeType = electron?.['crashpad.process_type']
    const sameProcess = exits.some((exit) => {
      const expected = exit.processType === 'main-renderer' || exit.processType === 'webview' ? 'renderer'
        : exit.processType === 'GPU' ? 'gpu-process' : exit.processType === 'Utility' ? 'utility' : null
      return expected !== null && nativeType === expected
    })
    const matchingDump = sameProcess && dumpAt !== null && dumpAt >= exits[0].at - 1000
      && dumpAt <= exits[exits.length - 1].at + 1000
    const context = {
      ...primary.context, shutdownSignal: signal, exitCount: exits.length,
      correlationMethod: 'sentry-process-gone', minidumpId: minidumpId ?? null,
      matchingDump,
      // Symbolication occurs at Sentry after this hook, not in JavaScript.
      symbolicationStatus: 'server-pending',
    }
    writeFatalLog('native-crash', JSON.stringify({ ...context, nativeEventId: event.event_id ?? null }))
    flushAppLogs()
    // A native OOM exception can be parsed by Sentry even when exit details
    // say killed. Preserve that evidence as well as crashed/oom exits.
    if (matchingDump && signal && exits.every((exit) => exit.reason === 'killed') && !event.exception?.values?.length) return null
    event.tags = { ...event.tags, crashIncidentId: String(id), ...(minidumpId ? { minidumpId } : {}) }
    event.contexts = { ...event.contexts, crash: context }
    // Sentry's default renderer details include URLs and arbitrary service names.
    if (electron) {
      delete electron.crashed_url
      electron.details = { reason: primary.reason, exitCode: primary.exitCode }
    }
    event.breadcrumbs = (primary.context.breadcrumbs as ReturnType<typeof crashBreadcrumbs>).map(({ at, name, durationMs }) => ({
      timestamp: at / 1000, category: 'performance', message: name, data: { durationMs },
    }))
    return event
  }
}
