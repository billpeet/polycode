import type { IncomingHttpHeaders } from 'http'
import type { RemoteServerConfig } from '../../shared/types'
import { isLoopbackPeer } from './sessions'

/**
 * Signing a browser in by its tailnet identity instead of the host token.
 *
 * `tailscale serve` adds `Tailscale-User-Login` to every request it forwards, naming the
 * tailnet user whose device made it. That header is trustworthy under exactly one set of
 * conditions, all checked here:
 *
 * - the request reached us from loopback — `tailscaled` proxies from this machine, and a
 *   peer anywhere else could have typed the header itself;
 * - it is not a Funnel request, which carries a stranger's identity from the internet;
 * - the login is one the user chose to admit. A tailnet can have several members, and
 *   reaching this port under the tailnet's ACLs must not be the same as being let in.
 *
 * A process on this machine could still forge the header — and could already read the
 * token out of SQLite, so nothing new is granted. The caller uses a match only to mint the
 * ordinary session cookie; no other request ever consults the header.
 */

export const TAILSCALE_LOGIN_HEADER = 'tailscale-user-login'
const TAILSCALE_FUNNEL_HEADER = 'tailscale-funnel-request'

/** Lower-cased, trimmed, deduplicated logins; anything with whitespace inside is dropped. */
export function normalizeTailscaleLogins(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const out = new Set<string>()
  for (const raw of values) {
    if (typeof raw !== 'string') continue
    const login = raw.trim().toLowerCase()
    if (login && !/\s/.test(login)) out.add(login)
  }
  return [...out]
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** The admitted login this request is signed in as, or null. */
export function tailscaleIdentityLogin(
  peerAddress: string | undefined,
  headers: IncomingHttpHeaders,
  config: Pick<RemoteServerConfig, 'webEnabled' | 'tailscaleLogins'>,
): string | null {
  if (!config.webEnabled || config.tailscaleLogins.length === 0) return null
  if (!isLoopbackPeer(peerAddress)) return null
  if (headerValue(headers[TAILSCALE_FUNNEL_HEADER]) !== undefined) return null
  const login = headerValue(headers[TAILSCALE_LOGIN_HEADER])?.trim().toLowerCase()
  if (!login) return null
  return config.tailscaleLogins.includes(login) ? login : null
}
