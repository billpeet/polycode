import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Dirent } from 'node:fs'

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

const faviconCache = new Map<string, string | null>()
const faviconRequests = new Map<string, Promise<string | null>>()

function cacheKey(root: string): string {
  const resolved = path.resolve(root)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

async function existingFile(root: string, relativePath: string): Promise<string | null> {
  const resolvedRoot = path.resolve(root)
  const candidate = path.resolve(resolvedRoot, relativePath)
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${path.sep}`)) return null
  try {
    return (await fs.stat(candidate)).isFile() ? candidate : null
  } catch {
    return null
  }
}

async function findNestedProjectIcon(root: string): Promise<string | null> {
  let directories = [path.resolve(root)]
  const fallbackIcons: string[] = []
  let visited = 0

  for (let depth = 0; depth <= MAX_SEARCH_DEPTH && directories.length > 0; depth++) {
    const nextDirectories: string[] = []
    const favicons: string[] = []
    for (const directory of directories.sort()) {
      let entries: Dirent[]
      try {
        entries = await fs.readdir(directory, { withFileTypes: true })
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

export async function resolveProjectFaviconPath(root: string): Promise<string | null> {
  for (const candidate of FAVICON_CANDIDATES) {
    const found = await existingFile(root, candidate)
    if (found) return found
  }

  for (const sourceFile of ICON_SOURCE_FILES) {
    const sourcePath = await existingFile(root, sourceFile)
    if (!sourcePath) continue
    let source: string
    try {
      source = await fs.readFile(sourcePath, 'utf8')
    } catch {
      continue
    }
    const href = source.match(LINK_ICON_HTML_RE)?.[1] ?? source.match(LINK_ICON_OBJ_RE)?.[1]
    if (!href || /^(?:[a-z]+:|\/\/)/i.test(href)) continue
    const cleanHref = href.replace(/^\//, '')
    for (const candidate of [`public/${cleanHref}`, cleanHref]) {
      const found = await existingFile(root, candidate)
      if (found) return found
    }
  }
  return findNestedProjectIcon(root)
}

async function discoverProjectFaviconDataUrl(root: string): Promise<string | null> {
  const faviconPath = await resolveProjectFaviconPath(root)
  if (!faviconPath) return null
  const mimeType = MIME_TYPES[path.extname(faviconPath).toLowerCase()]
  if (!mimeType) return null
  try {
    return `data:${mimeType};base64,${(await fs.readFile(faviconPath)).toString('base64')}`
  } catch {
    return null
  }
}

export function projectFaviconDataUrl(root: string): Promise<string | null> {
  const key = cacheKey(root)
  if (faviconCache.has(key)) return Promise.resolve(faviconCache.get(key) ?? null)

  const pending = faviconRequests.get(key)
  if (pending) return pending

  const request = discoverProjectFaviconDataUrl(root).then((result) => {
    faviconCache.set(key, result)
    return result
  }).finally(() => {
    faviconRequests.delete(key)
  })
  faviconRequests.set(key, request)
  return request
}

export function clearProjectFaviconCache(): void {
  faviconCache.clear()
  faviconRequests.clear()
}
