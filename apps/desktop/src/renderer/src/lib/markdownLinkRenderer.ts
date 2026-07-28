import { Renderer, type Tokens } from 'marked'
import { markdownFilePathFromHref } from './markdownFileLinks'

export function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// marked binds the active parser onto the renderer it invokes, so the base
// implementation has to be called with that same `this` — a renderer captured
// with .bind() never receives a parser and blows up on `this.parser`.
const defaultLinkRenderer = Renderer.prototype.link

// File links get preview + copy-path chrome; everything else falls through to
// marked's stock anchor rendering.
export function renderMarkdownLink(this: Renderer, token: Tokens.Link): string {
  const filePath = markdownFilePathFromHref(token.href)
  if (!filePath) return defaultLinkRenderer.call(this, token)

  const text = this.parser.parseInline(token.tokens)
  const title = token.title ? ` title="${escapeAttr(token.title)}"` : ''
  const encodedPath = escapeAttr(encodeURIComponent(filePath))
  return `<span class="file-link-with-copy"><a href="#" data-file-path="${encodedPath}"${title}>${text}</a><button type="button" class="file-path-copy-btn" data-file-path="${encodedPath}" title="Copy file path" aria-label="Copy file path"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="7" height="7" rx="1"></rect><path d="M10.5 5.5V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v5.5a1 1 0 0 0 1 1h1.5"></path></svg></button></span>`
}
