import DOMPurify from 'dompurify'

/**
 * The one sanitiser for markdown that becomes `innerHTML`.
 *
 * Two kinds of content reach it: provider output (assistant messages, thinking, plans,
 * subagent prompts) and repository files (`.md` previews). Both are hostile by
 * assumption, and in a browser served by a Remote Host the page they land in holds a
 * session that can spawn a shell on the host. `marked` passes raw HTML through, so
 * DOMPurify is the barrier — and this module is where its policy lives, once.
 *
 * Beyond DOMPurify's defaults (which already reject `javascript:`/`data:`/`file:` and
 * every unknown scheme on `href`/`src`, and strip `on*`), two things are decided here:
 *
 * - `style` is kept only where shiki puts it: on a `<span>`, and only for the handful of
 *   text properties a token needs. Provider-authored inline CSS on anything else would
 *   otherwise let a message paint a full-viewport overlay over the real UI.
 * - `formaction` and `<form>` are forbidden outright: DOMPurify does not run `formaction`
 *   through its URI filter, and `<button>` is default-allowed.
 * - The code-block chrome — the copy `<button>` and the `data-*` hooks its click handlers
 *   read — is admitted only where the renderer emits it. DOMPurify allows both by default,
 *   so content that carries no such chrome (repository `.md` previews) has them forbidden
 *   rather than merely not added.
 */

const STYLE_HOST_TAG = 'SPAN'
const STYLE_PROPERTY_PATTERN = /^(?:color|background-color|font-style|font-weight|text-decoration)$/i
// Hex colours, keywords, `italic`, `bold`, `underline`. No parentheses: shiki emits none,
// and they are how `url()`, `expression()` and `var()` would get in.
const STYLE_VALUE_PATTERN = /^[#\w.%\s-]+$/

/** True when every declaration is one of the allowed text properties with a plain value. */
export function isAllowedTokenStyle(style: string): boolean {
  const declarations = style.split(';').map((d) => d.trim()).filter(Boolean)
  if (declarations.length === 0) return false
  return declarations.every((declaration) => {
    const colon = declaration.indexOf(':')
    if (colon === -1) return false
    const property = declaration.slice(0, colon).trim()
    const value = declaration.slice(colon + 1).trim()
    return STYLE_PROPERTY_PATTERN.test(property) && STYLE_VALUE_PATTERN.test(value)
  })
}

let hooked = false

function ensureHooks(): void {
  if (hooked) return
  hooked = true
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName !== 'style') return
    if (node.nodeName !== STYLE_HOST_TAG || !isAllowedTokenStyle(data.attrValue)) {
      data.keepAttr = false
    }
  })
}

export interface SanitizeMarkdownOptions {
  /**
   * Admit the code-block chrome the renderer emits: a copy `<button>` and the `data-*`
   * hooks the click handlers read. Off for content with no such chrome.
   */
  codeControls?: boolean
}

export function sanitizeMarkdownHtml(html: string, { codeControls = false }: SanitizeMarkdownOptions = {}): string {
  ensureHooks()
  return DOMPurify.sanitize(html, {
    ALLOW_DATA_ATTR: codeControls,
    FORBID_TAGS: codeControls ? ['form'] : ['form', 'button'],
    FORBID_ATTR: ['formaction'],
  })
}
