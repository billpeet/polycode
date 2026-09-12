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
 * intended trade: nothing durable holds a credential-equivalent.
 */

export const SESSION_COOKIE = 'polycode_session'
const SESSION_ID_PATTERN = /^[0-9a-f]{64}$/
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

export class SessionStore {
  private readonly ids = new Set<string>()

  mint(): string {
    const id = randomBytes(32).toString('hex')
    this.ids.add(id)
    return id
  }

  has(id: string | undefined): boolean {
    return id !== undefined && this.ids.has(id)
  }

  revoke(id: string): void {
    this.ids.delete(id)
  }

  clear(): void {
    this.ids.clear()
  }

  get size(): number {
    return this.ids.size
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
