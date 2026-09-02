/**
 * Classifiers for the typed transport errors the main-process RemoteControlClient throws
 * (`remote/client.ts`). Electron's IPC serialization keeps only the error message, so the
 * renderer matches on the error *name* embedded in it — e.g.
 * "Error invoking remote method 'messages:list': RemoteUnavailableError: Remote host …".
 *
 * These are expected connectivity transitions, not defects: stores should keep their
 * last-good data and let the connection banner/indicator explain the situation, rather
 * than reporting one Sentry issue per channel (see issue #48).
 */

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error)
}

/** The circuit is open: the host is unreachable and calls fail fast. */
export function isRemoteUnavailableError(error: unknown): boolean {
  return /RemoteUnavailableError|REMOTE_UNAVAILABLE/.test(messageOf(error))
}

/** The request outlived its budget while the host stayed reachable. */
export function isRemoteTimeoutError(error: unknown): boolean {
  return /RemoteRequestTimeoutError|REMOTE_REQUEST_TIMEOUT/.test(messageOf(error))
}

/** Any expected remote-transport failure: offline circuit or per-request timeout. */
export function isRemoteTransportError(error: unknown): boolean {
  return isRemoteUnavailableError(error) || isRemoteTimeoutError(error)
}
