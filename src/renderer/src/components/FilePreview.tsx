import { useEffect, useRef } from 'react'
import { useFilesStore } from '../stores/files'
import hljs from 'highlight.js'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase()
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    fish: 'bash',
    ps1: 'powershell',
    sql: 'sql',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    xml: 'xml',
    svg: 'xml',
    vue: 'xml',
    md: 'markdown',
    mdx: 'markdown',
    graphql: 'graphql',
    gql: 'graphql',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    cmake: 'cmake',
  }
  return langMap[ext ?? ''] ?? 'plaintext'
}

function isMarkdown(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase()
  return ext === 'md' || ext === 'mdx'
}

function basename(filePath: string): string {
  return filePath.split(/[/\\]/).pop() ?? filePath
}

function CodePreview({ content, language }: { content: string; language: string }) {
  const lines = content.split('\n')
  const lineNumberWidth = String(lines.length).length

  return (
    <div
      className="overflow-auto text-xs leading-relaxed"
      style={{
        background: 'var(--color-surface)',
        height: '100%',
        fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Code", monospace',
      }}
    >
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <tbody>
          {lines.map((line, i) => (
            <LineRow key={i} lineNumber={i + 1} line={line} language={language} lineNumberWidth={lineNumberWidth} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function LineRow({
  lineNumber,
  line,
  language,
  lineNumberWidth,
}: {
  lineNumber: number
  line: string
  language: string
  lineNumberWidth: number
}) {
  const codeRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (codeRef.current && line) {
      codeRef.current.innerHTML = hljs.highlight(line, { language }).value
    }
  }, [line, language])

  return (
    <tr>
      <td
        className="select-none text-right pr-3 pl-3"
        style={{
          color: 'var(--color-text-muted)',
          opacity: 0.5,
          verticalAlign: 'top',
          width: `${lineNumberWidth + 2}ch`,
          minWidth: `${lineNumberWidth + 2}ch`,
        }}
      >
        {lineNumber}
      </td>
      <td
        style={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          paddingRight: '1rem',
        }}
      >
        <code ref={codeRef} className={`hljs language-${language}`}>
          {line || '\n'}
        </code>
      </td>
    </tr>
  )
}

function MarkdownPreview({ content }: { content: string }) {
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
      className="prose-content p-4 overflow-auto"
      style={{
        background: 'var(--color-surface)',
        height: '100%',
      }}
    />
  )
}

export default function FilePreview() {
  const selectedFilePath = useFilesStore((s) => s.selectedFilePath)
  const fileContent = useFilesStore((s) => s.fileContent)
  const loadingContent = useFilesStore((s) => s.loadingContent)
  const clearSelection = useFilesStore((s) => s.clearSelection)

  if (!selectedFilePath) {
    return null
  }

  const language = getLanguageFromPath(selectedFilePath)
  const showMarkdown = isMarkdown(selectedFilePath)
  const fileName = basename(selectedFilePath)

  return (
    <div
      className="flex flex-col h-full border-l"
      style={{
        background: 'var(--color-surface)',
        borderColor: 'var(--color-border)',
        minWidth: 300,
        maxWidth: '50%',
        width: 400,
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b flex-shrink-0"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <span
          className="text-xs font-medium truncate flex-1"
          style={{ color: 'var(--color-text)' }}
          title={selectedFilePath}
        >
          {fileName}
        </span>
        {fileContent?.truncated && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ background: 'rgba(251, 191, 36, 0.2)', color: '#fbbf24' }}
          >
            Truncated
          </span>
        )}
        {!showMarkdown && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded uppercase"
            style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-muted)' }}
          >
            {language}
          </span>
        )}
        <button
          onClick={clearSelection}
          className="rounded p-1 hover:bg-white/10 transition-colors"
          style={{ color: 'var(--color-text-muted)' }}
          title="Close preview"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {loadingContent ? (
          <div className="flex items-center justify-center h-full">
            <span className="streaming-dot" style={{ width: 8, height: 8, background: 'var(--color-text-muted)' }} />
          </div>
        ) : fileContent === null ? (
          <div className="flex items-center justify-center h-full text-xs" style={{ color: 'var(--color-text-muted)' }}>
            Unable to read file
          </div>
        ) : showMarkdown ? (
          <MarkdownPreview content={fileContent.content} />
        ) : (
          <CodePreview content={fileContent.content} language={language} />
        )}
      </div>
    </div>
  )
}
