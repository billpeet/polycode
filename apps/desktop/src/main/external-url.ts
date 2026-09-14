/**
 * The one answer to "may the renderer hand this URL to the operating system?"
 *
 * `shell.openExternal` launches whatever protocol handler the OS has registered —
 * `file:`, `ms-msdt:`, `search-ms:`, `vscode:` and friends — so it must only ever see
 * schemes a browser would open. Three call sites reach it: the `shell:openExternal`
 * channel, `will-navigate` for in-page anchors, and the window-open handler for
 * `target="_blank"`. All three use openExternalLink, which validates here.
 */
const OPENABLE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:'])

export function isOpenableExternalUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return OPENABLE_PROTOCOLS.has(parsed.protocol)
}
