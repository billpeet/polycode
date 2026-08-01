import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { getHighlighter, onReady } from '../lib/shiki'
import { reportPerf } from '../lib/perf'
import {
  filePathFromMarkdownCopyTarget,
  handleMarkdownFileLinkClick,
} from '../lib/markdownFileLinks'
import { escapeAttr, renderMarkdownLink } from '../lib/markdownLinkRenderer'
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'

// Configure marked with syntax highlighting and copy-button chrome
marked.setOptions({
  async: false
})

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

const renderer = new marked.Renderer()
renderer.link = renderMarkdownLink

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
  className?: string
}

export default function MarkdownContent({ content, className = '' }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [shikiReady, setShikiReady] = useState(!!getHighlighter())
  const selectFile = useFilesStore((state) => state.selectFile)
  const setRightPanelTab = useUiStore((state) => state.setRightPanelTab)

  useEffect(() => onReady(() => setShikiReady(true)), [])

  useEffect(() => {
    if (!ref.current) return
    const startedAt = performance.now()
    const raw = marked.parse(content) as string
    const clean = DOMPurify.sanitize(raw, {
      ADD_ATTR: ['data-code', 'data-file-path', 'data-line-number', 'style', 'tabindex'],
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
      const copyPath = filePathFromMarkdownCopyTarget(e.target)
      if (copyPath) {
        e.preventDefault()
        e.stopPropagation()
        const btn = (e.target as HTMLElement).closest('.file-path-copy-btn') as HTMLElement
        void navigator.clipboard.writeText(copyPath).then(() => {
          btn.classList.add('copied')
          btn.setAttribute('title', 'Copied')
          btn.setAttribute('aria-label', 'Copied')
          setTimeout(() => {
            btn.classList.remove('copied')
            btn.setAttribute('title', 'Copy file path')
            btn.setAttribute('aria-label', 'Copy file path')
          }, 1800)
        })
        return
      }

      if (handleMarkdownFileLinkClick(e, { selectFile, setRightPanelTab })) return

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
  }, [content, selectFile, setRightPanelTab, shikiReady])

  return (
    <div
      ref={ref}
      className={`prose-content max-w-none ${className}`.trim()}
    />
  )
}
