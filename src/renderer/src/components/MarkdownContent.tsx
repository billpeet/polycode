import { useEffect, useRef } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js'
import 'highlight.js/styles/github-dark.css'

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

const renderer = new marked.Renderer()
renderer.code = function ({ text, lang }) {
  const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext'
  const highlighted = hljs.highlight(text, { language }).value
  const langLabel = language === 'plaintext' ? '' : language
  const encodedCode = escapeAttr(text)
  return `<div class="code-block-wrapper">
  <div class="code-block-header">
    <span class="code-block-lang">${langLabel}</span>
    <button class="code-copy-btn" data-code="${encodedCode}">
      <span class="btn-label">copy</span>
    </button>
  </div>
  <pre><code class="hljs language-${language}">${highlighted}</code></pre>
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

  useEffect(() => {
    if (!ref.current) return
    const raw = marked.parse(content) as string
    const clean = DOMPurify.sanitize(raw, {
      ADD_ATTR: ['data-code'],
      ADD_TAGS: ['button']
    })
    ref.current.innerHTML = clean

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
  }, [content])

  return (
    <div
      ref={ref}
      className="prose-content max-w-none"
    />
  )
}
