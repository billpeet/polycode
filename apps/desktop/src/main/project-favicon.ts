import * as fs from 'node:fs'
import * as path from 'node:path'

const FAVICON_CANDIDATES = [
  'favicon.svg', 'favicon.ico', 'favicon.png',
  'public/favicon.svg', 'public/favicon.ico', 'public/favicon.png',
  'static/favicon.svg', 'static/favicon.ico', 'static/favicon.png',
  'static/icon.svg', 'static/icon.ico', 'static/icon.png',
  'app/favicon.ico', 'app/favicon.png', 'app/icon.svg', 'app/icon.png', 'app/icon.ico',
  'src/favicon.ico', 'src/favicon.svg', 'src/app/favicon.ico', 'src/app/icon.svg', 'src/app/icon.png',
  'assets/icon.svg', 'assets/icon.png', 'assets/logo.svg', 'assets/logo.png', '.idea/icon.svg',
] as const

const ICON_SOURCE_FILES = [
  'index.html', 'public/index.html', 'app/routes/__root.tsx', 'src/routes/__root.tsx',
  'app/root.tsx', 'src/root.tsx', 'src/index.html',
] as const

const MIME_TYPES: Record<string, string> = {
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

const SEARCH_IGNORED_DIRS = new Set([
  '.git', '.next', '.svelte-kit', '.vite', 'bin', 'build', 'coverage', 'dist',
  'node_modules', 'obj', 'out', 'test-results',
])
const MAX_SEARCH_DEPTH = 5
const MAX_SEARCH_ENTRIES = 5000

const LINK_ICON_HTML_RE = /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i
const LINK_ICON_OBJ_RE = /(?=[^}]*\brel\s*:\s*["'](?:icon|shortcut icon)["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/i

function existingFile(root: string, relativePath: string): string | null {
  const resolvedRoot = path.resolve(root)
  const candidate = path.resolve(resolvedRoot, relativePath)
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${path.sep}`)) return null
  try {
    return fs.statSync(candidate).isFile() ? candidate : null
  } catch {
    return null
  }
}

function findNestedProjectIcon(root: string): string | null {
  let directories = [path.resolve(root)]
  const fallbackIcons: string[] = []
  let visited = 0

  for (let depth = 0; depth <= MAX_SEARCH_DEPTH && directories.length > 0; depth++) {
    const nextDirectories: string[] = []
    const favicons: string[] = []
    for (const directory of directories.sort()) {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (++visited > MAX_SEARCH_ENTRIES) return favicons[0] ?? fallbackIcons[0] ?? null
        const fullPath = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          if (!SEARCH_IGNORED_DIRS.has(entry.name)) nextDirectories.push(fullPath)
          continue
        }
        if (!entry.isFile() || !MIME_TYPES[path.extname(entry.name).toLowerCase()]) continue
        const baseName = path.basename(entry.name, path.extname(entry.name)).toLowerCase()
        const parentName = path.basename(directory).toLowerCase()
        if (baseName === 'favicon') favicons.push(fullPath)
        else if (baseName === 'icon' && ['assets', 'public', 'resources', 'static'].includes(parentName)) {
          fallbackIcons.push(fullPath)
        }
      }
    }
    if (favicons.length > 0) return favicons.sort()[0]
    directories = nextDirectories
  }
  return fallbackIcons.sort()[0] ?? null
}

export function resolveProjectFaviconPath(root: string): string | null {
  for (const candidate of FAVICON_CANDIDATES) {
    const found = existingFile(root, candidate)
    if (found) return found
  }

  for (const sourceFile of ICON_SOURCE_FILES) {
    const sourcePath = existingFile(root, sourceFile)
    if (!sourcePath) continue
    let source: string
    try {
      source = fs.readFileSync(sourcePath, 'utf8')
    } catch {
      continue
    }
    const href = source.match(LINK_ICON_HTML_RE)?.[1] ?? source.match(LINK_ICON_OBJ_RE)?.[1]
    if (!href || /^(?:[a-z]+:|\/\/)/i.test(href)) continue
    const cleanHref = href.replace(/^\//, '')
    for (const candidate of [`public/${cleanHref}`, cleanHref]) {
      const found = existingFile(root, candidate)
      if (found) return found
    }
  }
  return findNestedProjectIcon(root)
}

export function projectFaviconDataUrl(root: string): string | null {
  const faviconPath = resolveProjectFaviconPath(root)
  if (!faviconPath) return null
  const mimeType = MIME_TYPES[path.extname(faviconPath).toLowerCase()]
  if (!mimeType) return null
  try {
    return `data:${mimeType};base64,${fs.readFileSync(faviconPath).toString('base64')}`
  } catch {
    return null
  }
}
