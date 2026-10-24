import { createHighlighter, type Highlighter } from 'shiki'
import { PRELOADED_SYNTAX_THEMES, type SyntaxTheme } from '../../../shared/themes'

let highlighter: Highlighter | null = null
const listeners: Array<() => void> = []

createHighlighter({
  // The built-in themes' palettes are loaded up front so switching between them is
  // instant; a custom theme's other choices load on first use (`loadSyntaxTheme`).
  themes: [...PRELOADED_SYNTAX_THEMES],
  langs: [
    'typescript', 'javascript', 'tsx', 'jsx',
    'json', 'html', 'css', 'scss', 'less',
    'python', 'ruby', 'go', 'rust', 'java',
    'c', 'cpp', 'csharp', 'php', 'swift',
    'kotlin', 'scala', 'bash', 'powershell',
    'sql', 'yaml', 'toml', 'xml', 'markdown',
    'graphql', 'dockerfile', 'makefile', 'cmake', 'svelte',
  ],
}).then((h) => {
  highlighter = h
  listeners.forEach((cb) => cb())
  listeners.length = 0
})

export function getHighlighter(): Highlighter | null {
  return highlighter
}

export function onReady(cb: () => void): () => void {
  if (highlighter) {
    cb()
    return () => {}
  }
  listeners.push(cb)
  return () => {
    const i = listeners.indexOf(cb)
    if (i >= 0) listeners.splice(i, 1)
  }
}

const loading = new Map<SyntaxTheme, Promise<void>>()

/** True once `theme` can be passed to the highlighter. */
export function isSyntaxThemeLoaded(theme: SyntaxTheme): boolean {
  return !!highlighter && highlighter.getLoadedThemes().includes(theme)
}

/** Load a bundled syntax palette that was not preloaded. Resolves once it is usable. */
export function loadSyntaxTheme(theme: SyntaxTheme): Promise<void> {
  if (isSyntaxThemeLoaded(theme)) return Promise.resolve()
  let pending = loading.get(theme)
  if (!pending) {
    pending = new Promise<void>((resolve) => onReady(resolve))
      .then(() => highlighter?.loadTheme(theme))
      .then(() => undefined)
      .finally(() => loading.delete(theme))
    loading.set(theme, pending)
  }
  return pending
}
