/**
 * Vitest setup: mock @sentry/electron/main before any test file imports it.
 * Outside Electron, the module cannot be loaded normally, so Sentry
 * would throw "Export named 'app' not found in module 'electron'".
 */
import { vi } from 'vitest'

vi.mock('@sentry/electron/main', () => ({
  init: () => {},
  addBreadcrumb: () => {},
  captureException: () => {},
  captureMessage: () => {},
  setContext: () => {},
  setTag: () => {},
  setUser: () => {},
  withScope: (fn: (scope: unknown) => void) => fn({}),
}))
