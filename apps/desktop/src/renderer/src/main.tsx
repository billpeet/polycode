import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import App from './App'
import WebRoot from './components/WebRoot'
import { SENTRY_DSN } from '../../shared/sentry.config'
import { installRendererPerfObservers, reportReactCommit } from './lib/perf'
import { initPostHog } from './lib/posthog'
import { client } from './lib/client'

type RendererLogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'

function serializeRendererArg(arg: unknown): string {
  if (arg instanceof Error) {
    return arg.stack || `${arg.name}: ${arg.message}`
  }

  if (typeof arg === 'string') {
    return arg
  }

  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

function installRendererLogForwarding(): void {
  const originalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  }

  const levels: RendererLogLevel[] = ['log', 'info', 'warn', 'error', 'debug']

  for (const level of levels) {
    console[level] = (...args: unknown[]) => {
      originalConsole[level](...args)
      client.send('log:write', {
        source: 'renderer',
        level,
        timestamp: new Date().toISOString(),
        messages: args.map(serializeRendererArg),
      })
    }
  }
}

/**
 * Sentry's Electron renderer SDK talks to the main process over a bridge the preload
 * installs; without one it is the plain browser SDK we want. Both are loaded on demand so
 * neither initialises in the wrong host.
 */
async function initErrorReporting(): Promise<void> {
  const release = `polycode@${__APP_VERSION__}`
  if (client.kind === 'electron') {
    const Sentry = await import('@sentry/electron/renderer')
    Sentry.init({
      dsn: SENTRY_DSN,
      release,
      integrations: [Sentry.browserTracingIntegration()],
      tracesSampleRate: 0.1,
    })
  } else {
    // Errors only. Tracing would report the page URL — this machine's tailnet name —
    // as the transaction name, and a browser session has no business telling Sentry that.
    const Sentry = await import('@sentry/react')
    Sentry.init({ dsn: SENTRY_DSN, release })
  }
}

// Console lines are forwarded to the desktop's log file. A browser has no such file to
// write to; its console is its log.
if (client.kind === 'electron') installRendererLogForwarding()
installRendererPerfObservers()

if (import.meta.env.PROD) {
  void initErrorReporting()
  // Autocapture sends clicked-element text and the page URL. Fine for the desktop
  // (file:// URL, one user); not for a page served at a tailnet hostname.
  if (client.kind === 'electron') initPostHog()
}

window.addEventListener('error', (event) => {
  console.error('[renderer] Uncaught error', event.error ?? event.message, {
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  })
})

window.addEventListener('unhandledrejection', (event) => {
  console.error('[renderer] Unhandled promise rejection', event.reason)
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <React.Profiler id="App" onRender={reportReactCommit}>
      {client.kind === 'web' ? <WebRoot /> : <App />}
    </React.Profiler>
  </React.StrictMode>
)
