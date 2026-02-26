import React from 'react'
import ReactDOM from 'react-dom/client'
import * as Sentry from '@sentry/electron/renderer'
import { init as reactInit } from '@sentry/react'
import './index.css'
import App from './App'
import { SENTRY_DSN } from '../../shared/sentry.config'

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

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
