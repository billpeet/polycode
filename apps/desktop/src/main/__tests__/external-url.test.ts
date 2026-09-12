import { describe, expect, it } from 'vitest'
import { isOpenableExternalUrl } from '../external-url'

describe('isOpenableExternalUrl', () => {
  it.each([
    'https://github.com/billpeet/polycode/pull/1',
    'http://localhost:5173/',
    'HTTPS://EXAMPLE.COM',
    'mailto:someone@example.com',
  ])('opens web and mail URLs: %s', (url) => {
    expect(isOpenableExternalUrl(url)).toBe(true)
  })

  it.each([
    'javascript:alert(1)',
    'file:///C:/Windows/System32/calc.exe',
    'ms-msdt:/id PCWDiagnostic /skip force /param IT_RebrowseForFile=?',
    'search-ms:query=x&crumb=location:\\\\evil',
    'vscode://file/C:/x',
    'data:text/html,<script>alert(1)</script>',
    'smb://evil/share',
    '',
    'not a url',
    '//evil.example',
  ])('refuses anything the OS might hand to another program: %s', (url) => {
    expect(isOpenableExternalUrl(url)).toBe(false)
  })
})
