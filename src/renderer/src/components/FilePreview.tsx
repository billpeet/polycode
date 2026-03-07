import { useState, useEffect, useMemo, useCallback, useRef, type CSSProperties } from 'react'
import { useFilesStore } from '../stores/files'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { getHighlighter, onReady } from '../lib/shiki'
import type { ThemedToken } from 'shiki'

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
  const [shikiReady, setShikiReady] = useState(!!getHighlighter())
  useEffect(() => onReady(() => setShikiReady(true)), [])

  const tokenLines = useMemo(() => {
    const hl = getHighlighter()
    if (!hl || !shikiReady) return null
    const loaded = hl.getLoadedLanguages()
    const lang = loaded.includes(language) ? language : 'text'
    const { tokens } = hl.codeToTokens(content, { lang, theme: 'github-dark' })
    return tokens
  }, [content, language, shikiReady])

  const plainLines = useMemo(() => content.split('\n'), [content])
  const lineCount = tokenLines ? tokenLines.length : plainLines.length
  const lineNumberWidth = String(lineCount).length

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
          {(tokenLines ?? plainLines).map((line, i) => (
            <LineRow
              key={i}
              lineNumber={i + 1}
              tokens={tokenLines ? (line as ThemedToken[]) : null}
              plainText={tokenLines ? null : (line as string)}
              lineNumberWidth={lineNumberWidth}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function LineRow({
  lineNumber,
  tokens,
  plainText,
  lineNumberWidth,
}: {
  lineNumber: number
  tokens: ThemedToken[] | null
  plainText: string | null
  lineNumberWidth: number
}) {
  return (
    <tr style={{ background: 'transparent' }}>
      <td
        className="select-none text-right pr-3 pl-3"
        style={{
          color: 'var(--color-text-muted)',
          opacity: 0.5,
          verticalAlign: 'top',
          width: `${lineNumberWidth + 2}ch`,
          minWidth: `${lineNumberWidth + 2}ch`,
          background: 'transparent',
        }}
      >
        {lineNumber}
      </td>
      <td
        style={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          paddingRight: '1rem',
          background: 'transparent',
        }}
      >
        <code style={{ background: 'transparent' }}>
          {tokens
            ? tokens.map((token, j) => (
                <span key={j} style={{ color: token.color }}>{token.content}</span>
              ))
            : (plainText || '\n')}
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

// ─── Diff rendering ───────────────────────────────────────────────────────────

interface ParsedDiffLine {
  type: 'context' | 'removed' | 'added' | 'header'
  text: string
  oldLineNumber: number | null
  newLineNumber: number | null
}

function parseUnifiedDiff(raw: string): ParsedDiffLine[] {
  const lines = raw.split('\n')
  const result: ParsedDiffLine[] = []
  let oldLineNumber = 0
  let newLineNumber = 0

  const hunkHeaderRegex = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/

  for (const line of lines) {
    if (line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++') || line.startsWith('new file') || line.startsWith('old mode') || line.startsWith('new mode') || line.startsWith('deleted file') || line.startsWith('\\ No newline')) {
      const hunkMatch = line.match(hunkHeaderRegex)
      if (hunkMatch) {
        oldLineNumber = Number(hunkMatch[1])
        newLineNumber = Number(hunkMatch[2])
      }
      result.push({ type: 'header', text: line, oldLineNumber: null, newLineNumber: null })
    } else if (line.startsWith('-')) {
      result.push({ type: 'removed', text: line.slice(1), oldLineNumber, newLineNumber: null })
      oldLineNumber += 1
    } else if (line.startsWith('+')) {
      result.push({ type: 'added', text: line.slice(1), oldLineNumber: null, newLineNumber })
      newLineNumber += 1
    } else if (line.startsWith(' ')) {
      result.push({ type: 'context', text: line.slice(1), oldLineNumber, newLineNumber })
      oldLineNumber += 1
      newLineNumber += 1
    } else if (line === '') {
      result.push({ type: 'context', text: '', oldLineNumber, newLineNumber })
      oldLineNumber += 1
      newLineNumber += 1
    }
  }
  return result
}

function DiffPreview({ diff }: { diff: string }) {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff])
  const visibleLines = useMemo(() => lines.filter((line) => line.type !== 'header'), [lines])

  const removedCount = visibleLines.filter(l => l.type === 'removed').length
  const addedCount = visibleLines.filter(l => l.type === 'added').length
  const maxOldLine = Math.max(0, ...visibleLines.map((line) => line.oldLineNumber ?? 0))
  const maxNewLine = Math.max(0, ...visibleLines.map((line) => line.newLineNumber ?? 0))
  const lineNumberWidth = Math.max(String(Math.max(maxOldLine, maxNewLine)).length, 1)

  return (
    <div
      className="overflow-auto text-xs"
      style={{
        background: 'var(--color-surface)',
        height: '100%',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.72rem',
        lineHeight: 1.6,
      }}
    >
      {/* Stats bar */}
      {(removedCount > 0 || addedCount > 0) && (
        <div
          className="flex items-center gap-2 px-3 py-1"
          style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid var(--color-border)', fontSize: '0.65rem', fontWeight: 600 }}
        >
          {addedCount > 0 && <span style={{ color: '#4ade80' }}>+{addedCount}</span>}
          {removedCount > 0 && <span style={{ color: '#f87171' }}>{removedCount}</span>}
        </div>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: `${lineNumberWidth + 2}ch` }} />
          <col style={{ width: '1.6rem' }} />
          <col />
        </colgroup>
        <tbody>
          {visibleLines.map((line, idx) => {
            const isRemoved = line.type === 'removed'
            const isAdded = line.type === 'added'
            const isHeader = line.type === 'header'

            const rowBg = isRemoved
              ? 'rgba(248, 113, 113, 0.10)'
              : isAdded
                ? 'rgba(74, 222, 128, 0.08)'
                : isHeader
                  ? 'rgba(255,255,255,0.03)'
                  : 'transparent'

            const gutterBg = isRemoved
              ? 'rgba(248, 113, 113, 0.20)'
              : isAdded
                ? 'rgba(74, 222, 128, 0.15)'
                : 'transparent'

            const markerText = isRemoved ? '' : isAdded ? '+' : isHeader ? '' : ' '
            const markerColor = isRemoved ? '#f87171' : isAdded ? '#4ade80' : 'transparent'

            const textColor = isRemoved
              ? 'rgba(248, 113, 113, 0.85)'
              : isAdded
                ? 'rgba(200, 240, 210, 0.9)'
                : isHeader
                  ? 'var(--color-text-muted)'
                  : 'var(--color-text-muted)'

            const tdBase: CSSProperties = {
              padding: 0,
              verticalAlign: 'top',
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              overflowWrap: 'anywhere',
            }

            const lineNumberCellStyle: CSSProperties = {
              ...tdBase,
              textAlign: 'right',
              paddingRight: '0.5rem',
              paddingLeft: '0.5rem',
              userSelect: 'none',
              color: 'var(--color-text-muted)',
              opacity: 0.5,
              whiteSpace: 'nowrap',
            }

            const formatLineNumber = (): string => {
              if (isHeader) return ''
              if (isRemoved) return line.oldLineNumber === null ? '' : String(line.oldLineNumber)
              return line.newLineNumber === null ? '' : String(line.newLineNumber)
            }

            return (
              <tr key={idx} style={{ background: rowBg }}>
                <td style={lineNumberCellStyle}>
                  {formatLineNumber()}
                </td>
                <td style={{ ...tdBase, textAlign: 'center', background: gutterBg, color: markerColor, fontWeight: 700, fontSize: '0.75rem', userSelect: 'none' }}>
                  {markerText}
                </td>
                <td style={{ ...tdBase, color: textColor, paddingLeft: '0.5rem', paddingRight: '0.75rem' }}>
                  {isHeader ? line.text : (line.text || ' ')}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Resize handle ────────────────────────────────────────────────────────────

function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: 4,
        cursor: 'col-resize',
        zIndex: 10,
      }}
    />
  )
}

function useResize(defaultWidth = 400) {
  const [width, setWidth] = useState(defaultWidth)
  const isDragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true
    startX.current = e.clientX
    startWidth.current = width
    document.body.style.cursor = 'col-resize'
    e.preventDefault()
  }, [width])

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!isDragging.current) return
      const delta = startX.current - e.clientX
      const newWidth = Math.max(200, Math.min(startWidth.current + delta, window.innerWidth * 0.6))
      setWidth(newWidth)
    }
    function onMouseUp() {
      if (isDragging.current) {
        isDragging.current = false
        document.body.style.cursor = ''
      }
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  return { width, handleMouseDown }
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function FilePreview() {
  const selectedFilePath = useFilesStore((s) => s.selectedFilePath)
  const fileContent = useFilesStore((s) => s.fileContent)
  const loadingContent = useFilesStore((s) => s.loadingContent)
  const clearSelection = useFilesStore((s) => s.clearSelection)
  const diffView = useFilesStore((s) => s.diffView)
  const loadingDiff = useFilesStore((s) => s.loadingDiff)
  const clearDiff = useFilesStore((s) => s.clearDiff)
  const switchDiffToFile = useFilesStore((s) => s.switchDiffToFile)

  const { width, handleMouseDown } = useResize()

  // Diff view takes priority
  if (diffView || loadingDiff) {
    const fileName = diffView ? basename(diffView.filePath) : '...'

    return (
      <div
        className="flex flex-col h-full border-l"
        style={{
          position: 'relative',
          background: 'var(--color-surface)',
          borderColor: 'var(--color-border)',
          minWidth: 200,
          width,
          flexShrink: 0,
        }}
      >
        <ResizeHandle onMouseDown={handleMouseDown} />
        {/* Header */}
        <div
          className="flex items-center gap-2 px-3 py-2 border-b flex-shrink-0"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <span
            className="text-xs font-medium truncate flex-1"
            style={{ color: 'var(--color-text)' }}
            title={diffView?.filePath}
          >
            {fileName}
          </span>
          <span
            className="text-[10px] px-1.5 py-0.5 rounded uppercase"
            style={{ background: 'rgba(232, 123, 95, 0.15)', color: 'var(--color-claude)' }}
          >
            Diff
          </span>
          {diffView && (
            <button
              onClick={switchDiffToFile}
              className="text-[10px] px-1.5 py-0.5 rounded transition-colors underline underline-offset-2 hover:opacity-90"
              style={{ color: 'var(--color-text)' }}
              title="View full file"
            >
              View file
            </button>
          )}
          <button
            onClick={clearDiff}
            className="rounded p-1 hover:bg-white/10 transition-colors"
            style={{ color: 'var(--color-text-muted)' }}
            title="Close diff"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {loadingDiff ? (
            <div className="flex items-center justify-center h-full">
              <span className="streaming-dot" style={{ width: 8, height: 8, background: 'var(--color-text-muted)' }} />
            </div>
          ) : diffView && diffView.diff ? (
            <DiffPreview diff={diffView.diff} />
          ) : (
            <div className="flex items-center justify-center h-full text-xs" style={{ color: 'var(--color-text-muted)' }}>
              No changes
            </div>
          )}
        </div>
      </div>
    )
  }

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
        position: 'relative',
        background: 'var(--color-surface)',
        borderColor: 'var(--color-border)',
        minWidth: 200,
        width,
        flexShrink: 0,
      }}
    >
      <ResizeHandle onMouseDown={handleMouseDown} />
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
