import { describe, expect, it } from 'vitest'
import {
  browserPartitionFor,
  isLoopbackHost,
  normalizeBrowserUrl,
  shouldTrustBrowserCertificate,
  sshLabelFor,
} from '../../../shared/browser'

describe('isLoopbackHost', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    '127.0.0.1',
    '::1',
    '[::1]',
    'api.localhost',
    'my.service.localhost.',
  ])('accepts loopback host %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true)
  })

  it.each([
    'example.com',
    'myhost',
    '10.0.0.1',
    '192.168.1.5',
    'notlocalhost',
    'localhost.example.com',
    '',
  ])('rejects non-loopback host "%s"', (host) => {
    expect(isLoopbackHost(host)).toBe(false)
  })
})

describe('shouldTrustBrowserCertificate', () => {
  it('trusts portless authority errors for localhost subdomains', () => {
    expect(shouldTrustBrowserCertificate('app.localhost', 'net::ERR_CERT_AUTHORITY_INVALID')).toBe(true)
  })

  it('does not trust other certificate errors or public hosts', () => {
    expect(shouldTrustBrowserCertificate('app.localhost', 'net::ERR_CERT_DATE_INVALID')).toBe(false)
    expect(shouldTrustBrowserCertificate('example.com', 'net::ERR_CERT_AUTHORITY_INVALID')).toBe(false)
  })
})

describe('normalizeBrowserUrl', () => {
  it('prefixes host:port with http://', () => {
    expect(normalizeBrowserUrl('localhost:5173')).toBe('http://localhost:5173')
  })

  it('prefixes bare hostnames and keeps paths', () => {
    expect(normalizeBrowserUrl('example.com/docs')).toBe('http://example.com/docs')
  })

  it('passes absolute URLs through validation', () => {
    expect(normalizeBrowserUrl('https://example.com/a?b=c')).toBe('https://example.com/a?b=c')
    expect(normalizeBrowserUrl('http://localhost:5173/#/route')).toBe('http://localhost:5173/#/route')
  })

  it('treats prose as a web search', () => {
    expect(normalizeBrowserUrl('vite dev server proxy config'))
      .toBe('https://duckduckgo.com/?q=vite%20dev%20server%20proxy%20config')
  })

  it('rejects empty input', () => {
    expect(normalizeBrowserUrl('')).toBeNull()
    expect(normalizeBrowserUrl('   ')).toBeNull()
  })

  it('returns null for unparseable absolute URLs', () => {
    expect(normalizeBrowserUrl('http://')).toBeNull()
  })
})

describe('browserPartitionFor', () => {
  it('names a persisted partition per location', () => {
    expect(browserPartitionFor('loc-1')).toBe('persist:browser:loc-1')
  })
})

describe('sshLabelFor', () => {
  it('formats user@host', () => {
    expect(sshLabelFor('deploy', 'dev.box')).toBe('deploy@dev.box')
  })
})
