import { randomBytes } from 'crypto'

/**
 * Browser sessions for the web UI.
 *
 * A native client holds the host token and sends it as a bearer header on every call.
 * A browser must not: anything JS-readable is one XSS away from a shell on this machine
 * (`terminal:spawn` is a remote channel). So the browser presents the token exactly once,
 * to `POST /api/remote/session`, and gets back an opaque id in an `HttpOnly` cookie.
 *
 * Sessions live in memory only. An app restart logs every browser out, which is the
 * intended trade: nothing durable holds a credential-equivalent. They also age out on
 * their own — a cookie that leaks from a browser profile must not stay good for as long
 * as the desktop happens to stay up.
 */

export const SESSION_COOKIE = 'polycode_session'
const SESSION_ID_PATTERN = /^[0-9a-f]{64}$/
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

/** Hard ceiling from sign-in, however active the session is. */
export const SESSION_ABSOLUTE_LIFETIME_MS = SESSION_MAX_AGE_SECONDS * 1000
/** A session unused for this long is gone; every authenticated request renews it. */
export const SESSION_IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000

interface SessionRecord {
  createdAt: number
  lastSeenAt: number
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>()

  constructor(private readonly now: () => number = Date.now) {}

  mint(): string {
    const id = randomBytes(32).toString('hex')
    const at = this.now()
    this.sessions.set(id, { createdAt: at, lastSeenAt: at })
    return id
  }

  /** True for a live session; also renews its idle clock. Expired ids are forgotten. */
  has(id: string | undefined): boolean {
    if (id === undefined) return false
    const record = this.sessions.get(id)
    if (!record) return false
    const at = this.now()
    if (at - record.createdAt > SESSION_ABSOLUTE_LIFETIME_MS || at - record.lastSeenAt > SESSION_IDLE_TIMEOUT_MS) {
      this.sessions.delete(id)
      return false
    }
    record.lastSeenAt = at
    return true
  }

  revoke(id: string): void {
    this.sessions.delete(id)
  }

  clear(): void {
    this.sessions.clear()
  }

  get size(): number {
    return this.sessions.size
  }
}

/**
 * Sliding-window failure counter for the login exchange, keyed by client address.
 * The token is 192 bits, so this is not what makes guessing infeasible; it is what
 * keeps a misbehaving client from filling the log.
 */
export class LoginRateLimiter {
  private readonly failures = new Map<string, number[]>()

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs
    const kept = (this.failures.get(key) ?? []).filter((at) => at > cutoff)
    if (kept.length === 0) this.failures.delete(key)
    else this.failures.set(key, kept)
    return kept
  }

  allow(key: string): boolean {
    return this.recent(key).length < this.maxFailures
  }

  recordFailure(key: string): void {
    this.failures.set(key, [...this.recent(key), this.now()])
  }

  reset(key: string): void {
    this.failures.delete(key)
  }

  /** Seconds until the oldest failure in the window ages out; 0 when not limited. */
  retryAfterSeconds(key: string): number {
    const recent = this.recent(key)
    if (recent.length < this.maxFailures) return 0
    const oldest = Math.min(...recent)
    return Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1000))
  }
}

export function readSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name !== SESSION_COOKIE) continue
    const value = rest.join('=').trim()
    return SESSION_ID_PATTERN.test(value) ? value : undefined
  }
  return undefined
}

interface CookieOptions {
  /** Set when the client connection was TLS (a proxy told us via X-Forwarded-Proto). */
  secure: boolean
}

function cookieAttributes({ secure }: CookieOptions, maxAge: number): string {
  const attributes = ['Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`]
  if (secure) attributes.push('Secure')
  return attributes.join('; ')
}

export function sessionCookie(id: string, options: CookieOptions): string {
  return `${SESSION_COOKIE}=${id}; ${cookieAttributes(options, SESSION_MAX_AGE_SECONDS)}`
}

export function expiredSessionCookie(options: CookieOptions): string {
  return `${SESSION_COOKIE}=; ${cookieAttributes(options, 0)}`
}

const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * The address to rate-limit by. `X-Forwarded-For` is only meaningful when the peer is a
 * proxy on this machine (`tailscale serve` connects from loopback); from anyone else it
 * is a header the client chose, and honouring it would let one client be as many
 * addresses as it likes.
 */
export function resolveClientAddress(peerAddress: string | undefined, forwardedFor: string | undefined): string {
  if (forwardedFor && isLoopbackPeer(peerAddress)) return forwardedFor
  return peerAddress ?? 'unknown'
}

/** True when the socket peer is this machine — the only place a trusted proxy can sit. */
export function isLoopbackPeer(peerAddress: string | undefined): boolean {
  return peerAddress !== undefined && LOOPBACK_ADDRESSES.has(peerAddress)
}
