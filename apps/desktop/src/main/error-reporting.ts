import { app } from 'electron'
import * as Sentry from '@sentry/electron/main'
import { SENTRY_DSN, sentryRelease } from '../shared/sentry.config'

/**
 * Starts Sentry for the main process.
 *
 * The release comes from `app.getVersion()`, the version electron-builder
 * packaged. npm's `npm_package_version` exists only under a package-manager
 * script, so an installed build reading it reported every main-process event
 * as `polycode@0.0.0` (GitHub #95).
 */
export function initMainErrorReporting(): void {
  Sentry.init({
    dsn: SENTRY_DSN,
    release: sentryRelease(app.getVersion()),
    environment: 'production',
    tracesSampleRate: 0.1,
  })
}
