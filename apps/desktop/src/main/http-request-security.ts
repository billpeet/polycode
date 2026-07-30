import { isIP } from 'node:net'
import { hostname } from 'node:os'

interface ParsedHost {
  hostname: string
  port: string
}

function normalizeHostname(hostname: string): string {
  const withoutBrackets = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
  return withoutBrackets.toLowerCase()
}

function parseHost(hostHeader: string | undefined): ParsedHost | null {
  if (!hostHeader || /[\s/@\\?#]/.test(hostHeader)) return null

  try {
    const url = new URL(`http://${hostHeader}`)
    return {
      hostname: normalizeHostname(url.hostname),
      port: url.port,
    }
  } catch {
    return null
  }
}

function isWildcardHost(host: string): boolean {
  const normalized = normalizeHostname(host.trim())
  return normalized === '0.0.0.0' || normalized === '::' || normalized === ''
}

/**
 * Validate Host before handling a local HTTP request. Wildcard listeners accept
 * literal IP addresses, localhost, and this machine's own hostname, but not
 * arbitrary DNS names. The hostname exception supports normal desktop-to-desktop
 * connections without reopening the attacker-controlled Host header used by DNS
 * rebinding.
 */
export function isAllowedHostHeader(
  hostHeader: string | undefined,
  bindHost: string,
  port: number,
  localHostname = hostname(),
): boolean {
  const requested = parseHost(hostHeader)
  if (!requested || requested.port !== String(port)) return false

  if (isWildcardHost(bindHost)) {
    return requested.hostname === 'localhost'
      || requested.hostname === normalizeHostname(localHostname.trim())
      || isIP(requested.hostname) !== 0
  }

  return requested.hostname === normalizeHostname(bindHost.trim())
}

/**
 * Browser access is same-origin only. Non-browser clients normally omit Origin
 * and are unaffected; an unrelated website receives no readable CORS response.
 */
export function getAllowedCorsOrigin(
  originHeader: string | undefined,
  hostHeader: string | undefined,
): string | null {
  const requested = parseHost(hostHeader)
  if (!originHeader || !requested) return null

  try {
    const origin = new URL(originHeader)
    if (
      origin.protocol !== 'http:' ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    ) {
      return null
    }

    const originHostname = normalizeHostname(origin.hostname)
    if (originHostname !== requested.hostname || origin.port !== requested.port) {
      return null
    }

    return origin.origin
  } catch {
    return null
  }
}
