/**
 * Pure helpers for the internal browser, shared by main (proxy setup) and
 * renderer (URL bar). No Electron or Node imports: everything here is
 * unit-testable without either.
 */

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '[::ffff:127.0.0.1]'])

/**
 * Whether `host` refers to the machine the request originates from.
 *
 * The browser proxy consults this for every request it relays: loopback
 * targets go through the SSH tunnel, everything else is relayed direct.
 * It is the in-proxy counterpart of the `<-loopback>` proxy bypass rule
 * (which stops Chromium skipping the proxy for loopback hosts entirely).
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, '')
  if (LOOPBACK_NAMES.has(normalized)) return true
  // `*.localhost` resolves to loopback in Chromium (and in systemd-resolved),
  // and some dev tools hand out per-site subdomains.
  return normalized.endsWith('.localhost')
}

/**
 * Portless development certificates are trusted on the session host, but a
 * remote browser guest validates the same certificate on this machine. Allow
 * only the CA error for loopback names used by local development servers.
 */
export function shouldTrustBrowserCertificate(host: string, verificationResult: string): boolean {
  return verificationResult === 'net::ERR_CERT_AUTHORITY_INVALID' && isLoopbackHost(host)
}

/** Hostname(:port)? with an optional path — loose enough for "localhost:5173". */
const HOST_LIKE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)*(:\d+)?([/?#].*)?$/i

/**
 * Turn what the user typed into a navigable URL.
 *
 * "localhost:5173" and "example.com/x" become http:// URLs; anything with a
 * scheme passes through URL validation untouched; anything else is a web
 * search. Returns null for empty input only.
 */
export function normalizeBrowserUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith('file:')) {
    try {
      return new URL(trimmed).toString()
    } catch {
      return null
    }
  }

  if (!/\s/.test(trimmed) && HOST_LIKE.test(trimmed)) {
    return `http://${trimmed}`
  }

  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`
}

/**
 * Electron session partition shared by every Browser tab at a location.
 * Persisted, so dev-server logins and localStorage survive restarts.
 */
export function browserPartitionFor(locationId: string): string {
  return `persist:browser:${locationId}`
}

/** `user@host` label for the proxy badge in the URL bar. */
export function sshLabelFor(user: string, host: string): string {
  return `${user}@${host}`
}
