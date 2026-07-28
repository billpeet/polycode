interface MarkdownClickEvent {
  target: unknown
  preventDefault: () => void
}

interface MarkdownFileLinkActions {
  selectFile: (path: string) => void
  setRightPanelTab: (tab: 'files') => void
}

interface ClosestTarget {
  closest: (selector: string) => unknown
}

interface AttributeTarget {
  getAttribute: (name: string) => string | null
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
  let decoded: string
  try {
    decoded = decodeURIComponent(href)
  } catch {
    return null
  }

  if (/^[A-Za-z]:[\\/]/.test(decoded)) {
    return decoded
  }

  if (decoded.startsWith('file:///')) {
    const filePath = decoded.slice('file:///'.length)
    return /^[A-Za-z]:\//.test(filePath) ? filePath.replace(/\//g, '\\') : `/${filePath}`
  }

  if (decoded.startsWith('/') && !decoded.startsWith('//')) {
    return decoded
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

  const filePath = markdownFilePathFromHref(href)
  if (!filePath) return false

  event.preventDefault()
  actions.selectFile(filePath)
  actions.setRightPanelTab('files')
  return true
}
