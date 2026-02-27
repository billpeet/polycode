/**
 * Bun test preload: mock @sentry/electron/main before any test file imports it.
 * In the bun test environment (not Electron), electron cannot be loaded so Sentry
 * would throw "Export named 'app' not found in module 'electron'".
 */
import { mock } from 'bun:test'

mock.module('@sentry/electron/main', () => ({
  init: () => {},
  addBreadcrumb: () => {},
  captureException: () => {},
  captureMessage: () => {},
  setContext: () => {},
  setTag: () => {},
  setUser: () => {},
  withScope: (fn: (scope: unknown) => void) => fn({}),
}))
