import { describe, expect, it } from 'vitest'
import { getAllowedCorsOrigin, isAllowedHostHeader } from '../http-request-security'

describe('isAllowedHostHeader', () => {
  it('accepts the configured host and port', () => {
    expect(isAllowedHostHeader('127.0.0.1:3285', '127.0.0.1', 3285)).toBe(true)
    expect(isAllowedHostHeader('[::1]:3285', '::1', 3285)).toBe(true)
  })

  it.each([
    undefined,
    '127.0.0.1',
    '127.0.0.1:9999',
    'attacker.example:3285',
    '127.0.0.1:3285/path',
    'user@127.0.0.1:3285',
  ])('rejects a Host that does not identify the configured listener: %s', (host) => {
    expect(isAllowedHostHeader(host, '127.0.0.1', 3285)).toBe(false)
  })

  it('allows IP literals and the local hostname but not arbitrary DNS names for wildcard listeners', () => {
    const localHostname = 'desktop-er4u7gp'
    expect(isAllowedHostHeader('192.168.1.20:3285', '0.0.0.0', 3285, localHostname)).toBe(true)
    expect(isAllowedHostHeader('localhost:3285', '0.0.0.0', 3285, localHostname)).toBe(true)
    expect(isAllowedHostHeader('DESKTOP-ER4U7GP:3285', '0.0.0.0', 3285, localHostname)).toBe(true)
    expect(isAllowedHostHeader('rebind.attacker.example:3285', '0.0.0.0', 3285, localHostname)).toBe(false)
  })
})

describe('getAllowedCorsOrigin', () => {
  it('echoes the exact same-origin HTTP origin', () => {
    expect(getAllowedCorsOrigin(
      'http://192.168.1.20:3285',
      '192.168.1.20:3285',
    )).toBe('http://192.168.1.20:3285')
  })

  it.each([
    undefined,
    'https://192.168.1.20:3285',
    'http://attacker.example',
    'null',
  ])('rejects a cross-origin or non-HTTP origin: %s', (origin) => {
    expect(getAllowedCorsOrigin(origin, '192.168.1.20:3285')).toBeNull()
  })
})
