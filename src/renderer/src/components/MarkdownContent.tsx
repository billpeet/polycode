import { useEffect, useRef } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js'
import 'highlight.js/styles/github-dark.css'

// Configure marked with syntax highlighting
marked.setOptions({
  async: false
})

const renderer = new marked.Renderer()
renderer.code = function ({ text, lang }) {
  const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext'
  const highlighted = hljs.highlight(text, { language }).value
  return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`
}

marked.use({ renderer })

interface Props {
  content: string
}

export default function MarkdownContent({ content }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ref.current) return
    const raw = marked.parse(content) as string
    const clean = DOMPurify.sanitize(raw)
    ref.current.innerHTML = clean
  }, [content])

  return (
    <div
      ref={ref}
      className="prose prose-sm prose-invert max-w-none"
      style={{ color: 'var(--color-text)' }}
    />
  )
}
