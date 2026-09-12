// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { isAllowedTokenStyle, sanitizeMarkdownHtml } from '../sanitizeMarkdown'

/**
 * Regression suite for the policy that stands between provider/repository markdown and
 * `innerHTML`. Every case here is something an assistant message or a cloned README
 * could contain.
 *
 * jsdom rather than happy-dom: DOMPurify walks the tree with a NodeIterator and relies
 * on browser-exact semantics; under happy-dom it keeps `<script>` and drops `<a>`, which
 * would make every assertion here meaningless.
 */

describe('sanitizeMarkdownHtml — script and URL vectors', () => {
  it('strips event handlers and script elements', () => {
    const out = sanitizeMarkdownHtml('<img src="x" onerror="alert(1)"><script>alert(2)</script><p onclick="x()">hi</p>')
    expect(out).not.toMatch(/onerror|onclick|<script/i)
    expect(out).toContain('<p>hi</p>')
  })

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'vscode://file/C:/x',
    'ms-msdt:/id x',
  ])('drops a link to %s', (href) => {
    const out = sanitizeMarkdownHtml(`<a href="${href}">x</a>`)
    expect(out).not.toMatch(/href=/i)
  })

  it('keeps web, mail and relative links', () => {
    expect(sanitizeMarkdownHtml('<a href="https://example.com/a?b=1#c">x</a>')).toContain('href="https://example.com/a?b=1#c"')
    expect(sanitizeMarkdownHtml('<a href="mailto:a@b.c">x</a>')).toContain('href="mailto:a@b.c"')
    expect(sanitizeMarkdownHtml('<a href="#section">x</a>')).toContain('href="#section"')
  })

  it('removes forms and formaction, even with code controls admitted', () => {
    const out = sanitizeMarkdownHtml(
      '<form action="https://evil.example"><button formaction="javascript:alert(1)">go</button></form>',
      { codeControls: true },
    )
    expect(out).not.toMatch(/<form|formaction/i)
  })
})

describe('sanitizeMarkdownHtml — inline style policy', () => {
  it('keeps shiki token colours on spans', () => {
    const out = sanitizeMarkdownHtml('<pre><code><span style="color:#E1E4E8">x</span><span style="color:#79B8FF;font-style:italic">y</span></code></pre>')
    expect(out).toContain('style="color:#E1E4E8"')
    expect(out).toContain('font-style:italic')
  })

  it('strips layout styles that could overlay the real UI', () => {
    const out = sanitizeMarkdownHtml(
      '<div style="position:fixed;inset:0;z-index:2147483647;background:#000">Approve?</div>'
      + '<span style="position:fixed;color:#fff">x</span>'
      + '<span style="color:#fff;display:block;width:100vw">y</span>'
      + '<p style="color:red">z</p>',
    )
    expect(out).not.toMatch(/style=/i)
    expect(out).toContain('Approve?')
  })

  it('does not let a value smuggle a function call in', () => {
    expect(sanitizeMarkdownHtml('<span style="color:url(javascript:x)">x</span>')).not.toMatch(/style=/i)
    expect(sanitizeMarkdownHtml('<span style="color:expression(alert(1))">x</span>')).not.toMatch(/style=/i)
    expect(sanitizeMarkdownHtml('<span style="color:var(--x)">x</span>')).not.toMatch(/style=/i)
    expect(sanitizeMarkdownHtml('<span style="color:#fff;background-image:url(https://x)">x</span>')).not.toMatch(/style=/i)
  })
})

describe('sanitizeMarkdownHtml — code controls', () => {
  const chrome = '<button class="copy" data-code="abc" data-file-path="%2Fa" data-line-number="3" tabindex="0">copy</button>'

  it('admits the copy button and its data hooks only when asked', () => {
    const on = sanitizeMarkdownHtml(chrome, { codeControls: true })
    expect(on).toContain('<button')
    expect(on).toContain('data-code="abc"')
    expect(on).toContain('data-file-path="%2Fa"')

    const off = sanitizeMarkdownHtml(chrome)
    expect(off).not.toContain('<button')
    expect(off).not.toContain('data-code')
  })
})

describe('isAllowedTokenStyle', () => {
  it('accepts only the token text properties with plain values', () => {
    expect(isAllowedTokenStyle('color:#fff')).toBe(true)
    expect(isAllowedTokenStyle('color: #79B8FF; font-weight: bold; text-decoration: underline')).toBe(true)
    expect(isAllowedTokenStyle('color: rgb(1, 2, 3)')).toBe(false)
    expect(isAllowedTokenStyle('')).toBe(false)
    expect(isAllowedTokenStyle('position:fixed')).toBe(false)
    expect(isAllowedTokenStyle('color:#fff;top:0')).toBe(false)
    expect(isAllowedTokenStyle('color:red !important')).toBe(false)
    expect(isAllowedTokenStyle('color')).toBe(false)
  })
})
