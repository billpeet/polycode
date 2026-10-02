export const SENTRY_DSN = 'https://5f8599725aec8c859c6da07470dbcbe7@o4510043638333440.ingest.us.sentry.io/4510949653676032'

/**
 * The Sentry release for an app version, shared by the main process and the
 * renderer so their events land in the same release.
 *
 * Set explicitly rather than left to @sentry/electron's default, which is
 * `${app.name}@${version}` — `polycode-electron@…` here, not `polycode@…`.
 */
export function sentryRelease(version: string): string {
  return `polycode@${version}`
}
