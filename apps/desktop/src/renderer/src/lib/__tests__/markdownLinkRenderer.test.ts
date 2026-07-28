import { describe, expect, it } from 'vitest'
import { Marked, Renderer } from 'marked'
import { renderMarkdownLink } from '../markdownLinkRenderer'

function parse(markdown: string): string {
  const renderer = new Renderer()
  renderer.link = renderMarkdownLink
  const instance = new Marked({ async: false })
  instance.use({ renderer })
  return (instance.parse(markdown) as string).trim()
}

describe('markdown link renderer', () => {
  // Regression: the fallback used to be captured with .bind(renderer), so it
  // ran against a renderer marked never attached a parser to — every ordinary
  // link threw "Cannot read properties of undefined (reading 'parseInline')"
  // and took the whole transcript down with it.
  it('renders an ordinary web link without throwing', () => {
    expect(parse('see [the docs](https://example.com)')).toBe(
      '<p>see <a href="https://example.com">the docs</a></p>'
    )
  })

  it('keeps inline formatting inside an ordinary link', () => {
    expect(parse('see [**bold** docs](https://example.com)')).toBe(
      '<p>see <a href="https://example.com"><strong>bold</strong> docs</a></p>'
    )
  })

  it('preserves the title on an ordinary link', () => {
    expect(parse('[docs](https://example.com "Title")')).toBe(
      '<p><a href="https://example.com" title="Title">docs</a></p>'
    )
  })

  it('renders an autolink without throwing', () => {
    expect(parse('visit <https://example.com>')).toBe(
      '<p>visit <a href="https://example.com">https://example.com</a></p>'
    )
  })

  it('gives file links preview and copy-path chrome', () => {
    const html = parse('open [main.ts](file:///C:/tmp/main.ts)')
    expect(html).toContain('class="file-link-with-copy"')
    expect(html).toContain('class="file-path-copy-btn"')
    expect(html).toContain('data-file-path="C%3A%5Ctmp%5Cmain.ts"')
    expect(html).toContain('>main.ts</a>')
  })
})
