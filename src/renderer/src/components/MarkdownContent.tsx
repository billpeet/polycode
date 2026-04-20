import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { getHighlighter, onReady } from '../lib/shiki'
import { reportPerf } from '../lib/perf'

// Configure marked with syntax highlighting and copy-button chrome
marked.setOptions({
  async: false
})

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

const renderer = new marked.Renderer()
renderer.code = function ({ text, lang }) {
  const hl = getHighlighter()
  let codeHtml: string
  let language: string

  if (hl) {
    const loaded = hl.getLoadedLanguages()
    language = lang && loaded.includes(lang) ? lang : 'text'
    codeHtml = hl.codeToHtml(text, { lang: language, theme: 'github-dark' })
  } else {
    language = lang || 'plaintext'
    codeHtml = `<pre><code>${escapeHtml(text)}</code></pre>`
  }

  const langLabel = language === 'text' || language === 'plaintext' ? '' : language
  const encodedCode = escapeAttr(text)
  return `<div class="code-block-wrapper">
  <div class="code-block-header">
    <span class="code-block-lang">${langLabel}</span>
    <button class="code-copy-btn" data-code="${encodedCode}">
      <span class="btn-label">copy</span>
    </button>
  </div>
  ${codeHtml}
</div>`
}

marked.use({ renderer })

function decodeAttr(encoded: string): string {
  return encoded
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

interface Props {
  content: string
}

export default function MarkdownContent({ content }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [shikiReady, setShikiReady] = useState(!!getHighlighter())

  useEffect(() => onReady(() => setShikiReady(true)), [])

  useEffect(() => {
    if (!ref.current) return
    const startedAt = performance.now()
    const raw = marked.parse(content) as string
    const clean = DOMPurify.sanitize(raw, {
      ADD_ATTR: ['data-code', 'style', 'tabindex'],
      ADD_TAGS: ['button']
    })
    ref.current.innerHTML = clean
    reportPerf(
      'markdown-content:render',
      performance.now() - startedAt,
      {
        contentLength: content.length,
        hasHighlighter: !!getHighlighter(),
      },
      { thresholdMs: 12, minIntervalMs: 1000 }
    )

    const container = ref.current
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      const btn = target.closest('.code-copy-btn') as HTMLElement | null
      if (!btn) return

      const encoded = btn.getAttribute('data-code') ?? ''
      const decoded = decodeAttr(encoded)
      const label = btn.querySelector('.btn-label') as HTMLElement | null

      navigator.clipboard.writeText(decoded).then(() => {
        if (label) label.textContent = 'copied!'
        btn.classList.add('copied')
        setTimeout(() => {
          if (label) label.textContent = 'copy'
          btn.classList.remove('copied')
        }, 1800)
      })
    }

    container.addEventListener('click', handleClick)
    return () => container.removeEventListener('click', handleClick)
  }, [content, shikiReady])

  return (
    <div
      ref={ref}
      className="prose-content max-w-none"
    />
  )
}
