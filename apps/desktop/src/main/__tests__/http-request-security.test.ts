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
    expect(isAllowedHostHeader('192.168.1.20:3285', '0.0.0.0', 3285, { localHostname })).toBe(true)
    expect(isAllowedHostHeader('localhost:3285', '0.0.0.0', 3285, { localHostname })).toBe(true)
    expect(isAllowedHostHeader('DESKTOP-ER4U7GP:3285', '0.0.0.0', 3285, { localHostname })).toBe(true)
    expect(isAllowedHostHeader('rebind.attacker.example:3285', '0.0.0.0', 3285, { localHostname })).toBe(false)
  })

  describe('explicitly allowed hostnames', () => {
    const allowedHostnames = ['pc.tailnet.ts.net']

    it('pass on any port, since a fronting proxy presents its own', () => {
      expect(isAllowedHostHeader('pc.tailnet.ts.net', '127.0.0.1', 3285, { allowedHostnames })).toBe(true)
      expect(isAllowedHostHeader('pc.tailnet.ts.net:443', '127.0.0.1', 3285, { allowedHostnames })).toBe(true)
      expect(isAllowedHostHeader('PC.Tailnet.TS.NET', '127.0.0.1', 3285, { allowedHostnames })).toBe(true)
    })

    it('do not loosen the check for any other name', () => {
      expect(isAllowedHostHeader('other.tailnet.ts.net', '127.0.0.1', 3285, { allowedHostnames })).toBe(false)
      expect(isAllowedHostHeader('rebind.attacker.example:3285', '0.0.0.0', 3285, { allowedHostnames })).toBe(false)
      expect(isAllowedHostHeader('127.0.0.1:9999', '127.0.0.1', 3285, { allowedHostnames })).toBe(false)
    })
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

  it('accepts an HTTPS origin only when a proxy reports the client leg was TLS', () => {
    expect(getAllowedCorsOrigin('https://pc.tailnet.ts.net', 'pc.tailnet.ts.net', 'https'))
      .toBe('https://pc.tailnet.ts.net')
    expect(getAllowedCorsOrigin('https://pc.tailnet.ts.net', 'pc.tailnet.ts.net', 'http')).toBeNull()
    expect(getAllowedCorsOrigin('https://pc.tailnet.ts.net', 'pc.tailnet.ts.net')).toBeNull()
  })

  it('still requires the HTTPS origin to name this host', () => {
    expect(getAllowedCorsOrigin('https://attacker.example', 'pc.tailnet.ts.net', 'https')).toBeNull()
    expect(getAllowedCorsOrigin('https://pc.tailnet.ts.net:8443', 'pc.tailnet.ts.net', 'https')).toBeNull()
  })
})
