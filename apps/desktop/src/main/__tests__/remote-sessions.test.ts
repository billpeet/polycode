import { describe, expect, it } from 'vitest'
import {
  LoginRateLimiter,
  SESSION_COOKIE,
  SessionStore,
  expiredSessionCookie,
  readSessionCookie,
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
