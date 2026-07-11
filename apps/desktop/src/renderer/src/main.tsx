import React from 'react'
import ReactDOM from 'react-dom/client'
import * as Sentry from '@sentry/electron/renderer'
import { init as reactInit } from '@sentry/react'
import './index.css'
import App from './App'
import { SENTRY_DSN } from '../../shared/sentry.config'
import { installRendererPerfObservers, reportReactCommit } from './lib/perf'

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
      window.api.send('log:write', {
        source: 'renderer',
        level,
        timestamp: new Date().toISOString(),
        messages: args.map(serializeRendererArg),
      })
    }
  }
}

installRendererLogForwarding()
installRendererPerfObservers()

if (import.meta.env.PROD) {
  Sentry.init(
    {
      dsn: SENTRY_DSN,
      release: `polycode@${__APP_VERSION__}`,
      integrations: [Sentry.browserTracingIntegration()],
      tracesSampleRate: 0.1,
    },
    reactInit
  )
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
      <App />
    </React.Profiler>
  </React.StrictMode>
)
