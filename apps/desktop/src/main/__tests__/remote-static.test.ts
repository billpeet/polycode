import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WEB_UI_CONTENT_SECURITY_POLICY, isStaticPath, resolveStaticFile } from '../remote/static'

const root = resolve('/srv/polycode/out/renderer')

describe('resolveStaticFile', () => {
  it('serves index.html for the root and the two bundle shapes', () => {
    expect(resolveStaticFile(root, '/')).toBe(join(root, 'index.html'))
    expect(resolveStaticFile(root, '/index.html')).toBe(join(root, 'index.html'))
    expect(resolveStaticFile(root, '/assets/index-BbSAiTfW.js')).toBe(join(root, 'assets', 'index-BbSAiTfW.js'))
    expect(resolveStaticFile(root, '/assets/nested/theme.css')).toBe(join(root, 'assets', 'nested', 'theme.css'))
  })

  it.each([
    '/main/index.js',
    '/package.json',
    '/assets',
    '/assets/',
    '/assets/../../main/index.js',
    '/assets/%2e%2e/%2e%2e/main/index.js',
    '/assets/app%00.js',
    '/%ZZ',
  ])('refuses anything outside index.html and assets/: %s', (pathname) => {
    expect(resolveStaticFile(root, pathname)).toBeNull()
  })

  it('lets a traversal that lands back on index.html through, since that is still index.html', () => {
    expect(resolveStaticFile(root, '/assets/../index.html')).toBe(join(root, 'index.html'))
  })
})

describe('isStaticPath', () => {
  it('names only the paths the bundle can contain', () => {
    expect(isStaticPath('/')).toBe(true)
    expect(isStaticPath('/index.html')).toBe(true)
    expect(isStaticPath('/assets/x.js')).toBe(true)
    expect(isStaticPath('/api/remote/rpc')).toBe(false)
    expect(isStaticPath('/login')).toBe(false)
  })
})

describe('web UI content security policy', () => {
  it('confines scripts to the bundle and forbids framing and plugins', () => {
    const directives = WEB_UI_CONTENT_SECURITY_POLICY.split('; ')
    expect(directives).toContain("script-src 'self' 'wasm-unsafe-eval'")
    expect(directives).toContain("frame-ancestors 'none'")
    expect(directives).toContain("object-src 'none'")
    expect(directives).toContain("base-uri 'none'")
    expect(WEB_UI_CONTENT_SECURITY_POLICY).not.toContain("'unsafe-eval'")
    expect(WEB_UI_CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*'unsafe-inline'/)
  })
})
