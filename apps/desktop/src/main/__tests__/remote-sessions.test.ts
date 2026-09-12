import { describe, expect, it } from 'vitest'
import {
  LoginRateLimiter,
  SESSION_ABSOLUTE_LIFETIME_MS,
  SESSION_COOKIE,
  SESSION_IDLE_TIMEOUT_MS,
  SessionStore,
  expiredSessionCookie,
  readSessionCookie,
  resolveClientAddress,
  sessionCookie,
} from '../remote/sessions'

describe('SessionStore', () => {
  it('mints unguessable ids that it then recognises', () => {
    const store = new SessionStore()
    const a = store.mint()
    const b = store.mint()

    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
    expect(store.has(a)).toBe(true)
    expect(store.has(b)).toBe(true)
    expect(store.has(undefined)).toBe(false)
    expect(store.has('0'.repeat(64))).toBe(false)
  })

  it('forgets a revoked id and everything on clear', () => {
    const store = new SessionStore()
    const a = store.mint()
    const b = store.mint()

    store.revoke(a)
    expect(store.has(a)).toBe(false)
    expect(store.has(b)).toBe(true)

    store.clear()
    expect(store.has(b)).toBe(false)
    expect(store.size).toBe(0)
  })
})

describe('SessionStore expiry', () => {
  function store(): { store: SessionStore; advance: (ms: number) => void } {
    let now = 1_000_000_000
    return { store: new SessionStore(() => now), advance: (ms) => { now += ms } }
  }

  it('forgets a session left idle past the idle timeout', () => {
    const { store: s, advance } = store()
    const id = s.mint()

    advance(SESSION_IDLE_TIMEOUT_MS - 1)
    expect(s.has(id)).toBe(true)

    advance(SESSION_IDLE_TIMEOUT_MS + 1)
    expect(s.has(id)).toBe(false)
    expect(s.size).toBe(0)
  })

  it('renews the idle clock on every use', () => {
    const { store: s, advance } = store()
    const id = s.mint()

    // Three near-idle gaps total 21 days: past one idle timeout many times over, still
    // inside the 30-day absolute lifetime.
    for (let i = 0; i < 3; i++) {
      advance(SESSION_IDLE_TIMEOUT_MS - 1)
      expect(s.has(id)).toBe(true)
    }
  })

  it('ends at the absolute lifetime however active it was', () => {
    const { store: s, advance } = store()
    const id = s.mint()
    const step = SESSION_IDLE_TIMEOUT_MS / 2

    let elapsed = 0
    while (elapsed + step <= SESSION_ABSOLUTE_LIFETIME_MS) {
      advance(step)
      elapsed += step
      expect(s.has(id)).toBe(true)
    }
    advance(step)
    expect(s.has(id)).toBe(false)
  })
})

describe('resolveClientAddress', () => {
  it('honours X-Forwarded-For only when the peer is a loopback proxy', () => {
    expect(resolveClientAddress('127.0.0.1', '100.64.0.9')).toBe('100.64.0.9')
    expect(resolveClientAddress('::1', '100.64.0.9')).toBe('100.64.0.9')
    expect(resolveClientAddress('::ffff:127.0.0.1', '100.64.0.9')).toBe('100.64.0.9')
    expect(resolveClientAddress('192.168.1.20', '100.64.0.9')).toBe('192.168.1.20')
    expect(resolveClientAddress('192.168.1.20', undefined)).toBe('192.168.1.20')
    expect(resolveClientAddress('127.0.0.1', undefined)).toBe('127.0.0.1')
    expect(resolveClientAddress(undefined, '100.64.0.9')).toBe('unknown')
  })
})

describe('LoginRateLimiter', () => {
  function limiter(): { limiter: LoginRateLimiter; advance: (ms: number) => void } {
    let now = 1_000_000
    return {
      limiter: new LoginRateLimiter(3, 60_000, () => now),
      advance: (ms) => { now += ms },
    }
  }

  it('allows up to the failure budget, then blocks until the window slides', () => {
    const { limiter: l, advance } = limiter()

    expect(l.allow('10.0.0.1')).toBe(true)
    l.recordFailure('10.0.0.1')
    l.recordFailure('10.0.0.1')
    expect(l.allow('10.0.0.1')).toBe(true)
    l.recordFailure('10.0.0.1')
    expect(l.allow('10.0.0.1')).toBe(false)
    expect(l.retryAfterSeconds('10.0.0.1')).toBe(60)

    advance(30_000)
    expect(l.allow('10.0.0.1')).toBe(false)
    expect(l.retryAfterSeconds('10.0.0.1')).toBe(30)

    advance(30_001)
    expect(l.allow('10.0.0.1')).toBe(true)
    expect(l.retryAfterSeconds('10.0.0.1')).toBe(0)
  })

  it('keys by client, and a success clears that client only', () => {
    const { limiter: l } = limiter()
    for (let i = 0; i < 3; i++) l.recordFailure('a')
    l.recordFailure('b')

    expect(l.allow('a')).toBe(false)
    expect(l.allow('b')).toBe(true)

    l.reset('a')
    expect(l.allow('a')).toBe(true)
  })
})

describe('session cookie', () => {
  const id = 'ab'.repeat(32)

  it('reads its own cookie out of a Cookie header among others', () => {
    expect(readSessionCookie(`theme=dark; ${SESSION_COOKIE}=${id}; other=1`)).toBe(id)
    expect(readSessionCookie(`${SESSION_COOKIE}=${id}`)).toBe(id)
  })

  it.each([
    undefined,
    '',
    'theme=dark',
    `${SESSION_COOKIE}=not-hex`,
    `${SESSION_COOKIE}=${'ab'.repeat(31)}`,
    `${SESSION_COOKIE}=`,
  ])('ignores a missing or malformed cookie: %s', (header) => {
    expect(readSessionCookie(header)).toBeUndefined()
  })

  it('is HttpOnly and SameSite=Strict, and Secure only behind TLS', () => {
    const plain = sessionCookie(id, { secure: false })
    expect(plain).toContain(`${SESSION_COOKIE}=${id}`)
    expect(plain).toContain('HttpOnly')
    expect(plain).toContain('SameSite=Strict')
    expect(plain).toContain('Path=/')
    expect(plain).not.toContain('Secure')

    expect(sessionCookie(id, { secure: true })).toContain('Secure')
  })

  it('expires with a zero max-age', () => {
    const expired = expiredSessionCookie({ secure: false })
    expect(expired).toContain(`${SESSION_COOKIE}=;`)
    expect(expired).toContain('Max-Age=0')
    expect(expired).toContain('HttpOnly')
  })
})
