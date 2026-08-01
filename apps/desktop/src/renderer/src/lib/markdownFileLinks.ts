interface MarkdownClickEvent {
  target: unknown
  preventDefault: () => void
}

interface MarkdownFileLinkActions {
  selectFile: (path: string, lineNumber?: number | null) => void
  setRightPanelTab: (tab: 'files') => void
}

interface ClosestTarget {
  closest: (selector: string) => unknown
}

interface AttributeTarget {
  getAttribute: (name: string) => string | null
}

export interface MarkdownFileTarget {
  filePath: string
  lineNumber: number | null
}

export function filePathFromMarkdownCopyTarget(target: unknown): string | null {
  const closestTarget = target as ClosestTarget | null
  const button = closestTarget?.closest?.(
    '.file-path-copy-btn[data-file-path]'
  ) as AttributeTarget | null
  const encodedPath = button?.getAttribute?.('data-file-path')
  return encodedPath ? markdownFilePathFromHref(encodedPath) : null
}

export function markdownFilePathFromHref(href: string): string | null {
  return markdownFileTargetFromHref(href)?.filePath ?? null
}

export function markdownFileTargetFromHref(href: string): MarkdownFileTarget | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(href)
  } catch {
    return null
  }

  const lineSuffix = decoded.match(/:(\d+)$/)
  const parsedLineNumber = lineSuffix ? Number(lineSuffix[1]) : null
  const lineNumber = parsedLineNumber !== null && Number.isSafeInteger(parsedLineNumber) && parsedLineNumber > 0
    ? parsedLineNumber
    : null
  const path = lineNumber === null ? decoded : decoded.slice(0, -lineSuffix![0].length)

  if (/^[A-Za-z]:[\\/]/.test(path)) {
    return { filePath: path, lineNumber }
  }

  // Codex commonly renders Windows paths as `/C:/...` so they work as
  // markdown hrefs. Strip that markdown-only leading slash before previewing.
  if (/^\/[A-Za-z]:[\\/]/.test(path)) {
    return { filePath: path.slice(1).replace(/\//g, '\\'), lineNumber }
  }

  if (path.startsWith('file:///')) {
    const filePath = path.slice('file:///'.length)
    return {
      filePath: /^[A-Za-z]:\//.test(filePath) ? filePath.replace(/\//g, '\\') : `/${filePath}`,
      lineNumber,
    }
  }

  if (path.startsWith('/') && !path.startsWith('//')) {
    return { filePath: path, lineNumber }
  }

  return null
}

export function handleMarkdownFileLinkClick(
  event: MarkdownClickEvent,
  actions: MarkdownFileLinkActions
): boolean {
  const target = event.target as ClosestTarget | null
  const anchor = target?.closest?.('a[data-file-path], a[href]') as AttributeTarget | null
  const href = anchor?.getAttribute?.('data-file-path') ?? anchor?.getAttribute?.('href')
  if (!href) return false

  const fileTarget = markdownFileTargetFromHref(href)
  if (!fileTarget) return false

  const lineNumberAttr = anchor?.getAttribute?.('data-line-number')
  const lineNumberFromAttr = lineNumberAttr ? Number(lineNumberAttr) : null
  const lineNumber = lineNumberFromAttr !== null
    && Number.isSafeInteger(lineNumberFromAttr)
    && lineNumberFromAttr > 0
    ? lineNumberFromAttr
    : fileTarget.lineNumber

  event.preventDefault()
  if (lineNumber === null) {
    actions.selectFile(fileTarget.filePath)
  } else {
    actions.selectFile(fileTarget.filePath, lineNumber)
  }
  actions.setRightPanelTab('files')
  return true
}
