import { createHighlighter, type Highlighter } from 'shiki'
import { SYNTAX_THEMES } from '../../../shared/themes'

let highlighter: Highlighter | null = null
const listeners: Array<() => void> = []

createHighlighter({
  // Every theme's syntax palette is loaded up front so switching themes is instant.
  themes: [...SYNTAX_THEMES],
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
