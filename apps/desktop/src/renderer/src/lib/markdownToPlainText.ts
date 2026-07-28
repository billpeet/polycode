import { marked } from 'marked'

type MarkdownToken = {
  type: string
  text?: string
  tokens?: MarkdownToken[]
  items?: MarkdownToken[]
  ordered?: boolean
  start?: number | ''
}

function inlineText(tokens: MarkdownToken[] = []): string {
  return tokens.map((token) => {
    if (token.type === 'br') return '\n'
    if (token.tokens) return inlineText(token.tokens)
    return token.text ?? ''
  }).join('')
}

function blockText(tokens: MarkdownToken[], depth = 0, separator = '\n\n'): string {
  return tokens.map((token) => {
    if (token.type === 'space') return ''

    if (token.type === 'list') {
      const start = typeof token.start === 'number' ? token.start : 1
      return (token.items ?? []).map((item, index) => {
        const marker = token.ordered ? `${start + index}. ` : '- '
        const indent = '  '.repeat(depth)
        const content = blockText(item.tokens ?? [], depth + 1, '\n')
        return `${indent}${marker}${content}`
      }).join('\n')
    }

    if (token.type === 'blockquote') {
      return blockText(token.tokens ?? [], depth)
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    }

    if (token.type === 'code') return token.text ?? ''
    if (token.tokens) return inlineText(token.tokens)
    return token.text ?? ''
  }).filter(Boolean).join(separator)
}

export function markdownToPlainText(markdown: string): string {
  return blockText(marked.lexer(markdown) as MarkdownToken[]).trim()
}
