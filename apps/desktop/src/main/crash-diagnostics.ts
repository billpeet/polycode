import { app, dialog, ipcMain, type WebContents } from 'electron'
import { createHash } from 'node:crypto'
import * as Sentry from '@sentry/electron/main'
import { writeFatalLog, flushAppLogs } from './app-logger'
import { flushObservability, recordLog } from './observability'
import { latestMemorySamples } from './memory-telemetry'
import { crashBreadcrumbs } from './crash-context'

const reasons = new Set(['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction'])
const views = new Set(['chat', 'diff', 'file', 'command', 'terminal', 'browser', 'tasks', 'files', 'commands', 'plan', 'workspace'])
const processTypes = new Set(['Browser', 'Tab', 'Utility', 'Zygote', 'Sandbox helper', 'GPU', 'Pepper Plugin', 'Pepper Plugin Broker'])

export function installCrashDiagnostics(options: {
  capture: boolean
  locationId: (contents: WebContents) => string | undefined | null
}): void {
  const activeViews = new Map<number, string>()
  let crashes: number[] = []
  let presenting = false
  ipcMain.on('telemetry:view', (event, view: unknown) => {
    if (event.sender.getType() === 'window' && typeof view === 'string' && views.has(view)) {
      activeViews.set(event.sender.id, view)
    }
  })

  async function report(details: Electron.RenderProcessGoneDetails, type: string, contents?: WebContents): Promise<void> {
    if (details.reason === 'clean-exit') return
    const now = Date.now()
    crashes = [...crashes.filter((at) => now - at < 5 * 60_000), now].slice(-3)
    const location = contents?.getType() === 'webview' ? options.locationId(contents) : null
    let gpu: Record<string, string> = {}
    try { gpu = { ...app.getGPUFeatureStatus() } } catch { /* GPU may be unavailable during startup. */ }
    const context = {
      reason: reasons.has(details.reason) ? details.reason : 'unknown',
      exitCode: Number.isInteger(details.exitCode) ? details.exitCode : null,
      processType: type,
      appVersion: app.getVersion(), electronVersion: process.versions.electron,
      chromiumVersion: process.versions.chrome,
      gpu, disableGpu: app.commandLine.hasSwitch('disable-gpu'),
      activeView: contents?.getType() === 'webview' ? 'browser' : contents ? activeViews.get(contents.id) ?? 'unknown' : 'unknown',
      guestLocationId: location ? createHash('sha256').update(location).digest('hex') : null,
      memory: latestMemorySamples(), breadcrumbs: crashBreadcrumbs(),
    }
    writeFatalLog('process-gone', JSON.stringify(context))
    recordLog('FATAL', 'Electron process exited unexpectedly', { 'crash.context': JSON.stringify(context) })
    if (options.capture) Sentry.captureEvent({
      message: 'Electron process exited unexpectedly', level: 'fatal',
      tags: { source: 'process-gone', processType: type, reason: context.reason },
      contexts: { crash: context },
      // Do not inherit SDK breadcrumbs that may contain URLs or IPC payloads.
      breadcrumbs: context.breadcrumbs.map(({ at, name, durationMs }) => ({
        timestamp: at / 1000, category: 'performance', message: name, data: { durationMs },
      })),
    })
    flushAppLogs()
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled([flushObservability(), ...(options.capture ? [Sentry.flush(2000)] : [])]),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 2000) }),
    ])
    clearTimeout(timer)
    if (!app.isReady() || presenting || contents?.isDestroyed()) return
    // Electron restarts child processes itself. Offer GPU diagnostics if failures repeat.
    if (!contents && crashes.length < 3) return
    presenting = true
    try {
      const repeated = crashes.length >= 3
      const buttons = contents ? ['Reload', 'Dismiss'] : ['Dismiss']
      if (repeated) buttons.push('Restart with GPU disabled')
      const { response } = await dialog.showMessageBox({
        type: 'error', title: 'PolyCode process stopped',
        message: `${type} stopped (${context.reason}).`,
        detail: 'Diagnostics were written to the app logs.' + (repeated ? ' Repeated crashes detected. Restarting stops running sessions; disabling GPU can help diagnose graphics problems.' : ''),
        buttons, cancelId: contents ? 1 : 0, noLink: true,
      })
      if (buttons[response] === 'Reload' && contents && !contents.isDestroyed()) contents.reload()
      if (buttons[response] === 'Restart with GPU disabled') {
        app.relaunch({ args: [...process.argv.slice(1).filter((arg) => arg !== '--disable-gpu'), '--disable-gpu'] })
        app.quit()
      }
    } finally { presenting = false }
  }

  app.on('web-contents-created', (_event, contents) => {
    const type = contents.getType()
    if (type !== 'window' && type !== 'webview') return
    contents.on('destroyed', () => activeViews.delete(contents.id))
    contents.on('render-process-gone', (_event, details) => {
      void report(details, type === 'webview' ? 'webview' : 'main-renderer', contents)
        .catch((error) => { writeFatalLog('crash-diagnostics-failed', error); flushAppLogs() })
    })
  })
  app.on('child-process-gone', (_event, details) => {
    // Service names are arbitrary strings and can contain user data. Report the known type only.
    void report(details, processTypes.has(details.type) ? details.type : 'unknown-child')
      .catch((error) => { writeFatalLog('crash-diagnostics-failed', error); flushAppLogs() })
  })
}
