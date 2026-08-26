import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Dirent } from 'node:fs'
import { app } from 'electron'

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
const MAX_SEARCH_DEPTH = 4
const MAX_SEARCH_ENTRIES = 1500
const CACHE_VERSION = 1
const NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60_000

const LINK_ICON_HTML_RE = /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i
const LINK_ICON_OBJ_RE = /(?=[^}]*\brel\s*:\s*["'](?:icon|shortcut icon)["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/i

const faviconCache = new Map<string, string | null>()
const faviconRequests = new Map<string, Promise<string | null>>()
type PersistentEntry = { iconPath: string | null; iconModifiedAt: number | null; discoveredAt: number }
type PersistentCache = { version: number; entries: Record<string, PersistentEntry> }
let persistentCache: PersistentCache | null = null
let persistenceQueue = Promise.resolve()
let discoveryQueue = Promise.resolve()

function cacheKey(root: string): string {
  const resolved = path.resolve(root)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function persistentCachePath(): string {
  return path.join(app.getPath('userData'), 'favicon-cache.json')
}

async function loadPersistentCache(): Promise<PersistentCache> {
  if (persistentCache) return persistentCache
  try {
    const parsed = JSON.parse(await fs.readFile(persistentCachePath(), 'utf8')) as PersistentCache
    persistentCache = parsed.version === CACHE_VERSION && parsed.entries
      ? parsed
      : { version: CACHE_VERSION, entries: {} }
  } catch {
    persistentCache = { version: CACHE_VERSION, entries: {} }
  }
  return persistentCache
}

function persistCache(cache: PersistentCache): void {
  persistenceQueue = persistenceQueue.then(async () => {
    const cachePath = persistentCachePath()
    await fs.mkdir(path.dirname(cachePath), { recursive: true })
    const temporaryPath = `${cachePath}.tmp`
    await fs.writeFile(temporaryPath, JSON.stringify(cache), 'utf8')
    await fs.rename(temporaryPath, cachePath)
  }).catch(() => undefined)
}

async function readFaviconDataUrl(iconPath: string): Promise<{ dataUrl: string; modifiedAt: number } | null> {
  const mimeType = MIME_TYPES[path.extname(iconPath).toLowerCase()]
  if (!mimeType) return null
  try {
    const [contents, stats] = await Promise.all([fs.readFile(iconPath), fs.stat(iconPath)])
    if (!stats.isFile()) return null
    return { dataUrl: `data:${mimeType};base64,${contents.toString('base64')}`, modifiedAt: stats.mtimeMs }
  } catch {
    return null
  }
}

export async function faviconFileDataUrl(iconPath: string): Promise<string | null> {
  return (await readFaviconDataUrl(iconPath))?.dataUrl ?? null
}

export function storeProjectFaviconPath(iconPath: string | null | undefined, locationPaths: string[]): string | null {
  const selected = iconPath?.trim()
  if (!selected) return null
  if (!path.isAbsolute(selected)) return path.normalize(selected)

  const resolvedSelected = path.resolve(selected)
  const roots = locationPaths.map((root) => path.resolve(root)).sort((a, b) => b.length - a.length)
  for (const root of roots) {
    const relative = path.relative(root, resolvedSelected)
    if (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) return relative
  }
  return resolvedSelected
}

export async function projectFaviconOverrideDataUrl(faviconPath: string, locationPaths: string[]): Promise<string | null> {
  if (path.isAbsolute(faviconPath)) return faviconFileDataUrl(faviconPath)
  for (const root of locationPaths) {
    const dataUrl = await faviconFileDataUrl(path.resolve(root, faviconPath))
    if (dataUrl) return dataUrl
  }
  return null
}

async function readPersistentResult(root: string): Promise<string | null | undefined> {
  const key = cacheKey(root)
  const cache = await loadPersistentCache()
  const entry = cache.entries[key]
  if (!entry) return undefined
  if (!entry.iconPath) {
    return Date.now() - entry.discoveredAt < NEGATIVE_CACHE_TTL_MS ? null : undefined
  }
  const icon = await readFaviconDataUrl(entry.iconPath)
  if (!icon || icon.modifiedAt !== entry.iconModifiedAt) return undefined
  return icon.dataUrl
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

async function discoverProjectFavicon(root: string): Promise<{ dataUrl: string | null; entry: PersistentEntry }> {
  const faviconPath = await resolveProjectFaviconPath(root)
  if (!faviconPath) return { dataUrl: null, entry: { iconPath: null, iconModifiedAt: null, discoveredAt: Date.now() } }
  const icon = await readFaviconDataUrl(faviconPath)
  return icon
    ? { dataUrl: icon.dataUrl, entry: { iconPath: faviconPath, iconModifiedAt: icon.modifiedAt, discoveredAt: Date.now() } }
    : { dataUrl: null, entry: { iconPath: null, iconModifiedAt: null, discoveredAt: Date.now() } }
}

function enqueueDiscovery<T>(task: () => Promise<T>): Promise<T> {
  const result = discoveryQueue.then(task, task)
  discoveryQueue = result.then(() => undefined, () => undefined)
  return result
}

export function projectFaviconDataUrl(root: string): Promise<string | null> {
  const key = cacheKey(root)
  if (faviconCache.has(key)) return Promise.resolve(faviconCache.get(key) ?? null)

  const pending = faviconRequests.get(key)
  if (pending) return pending

  const request = readPersistentResult(root).then((persisted) => {
    if (persisted !== undefined) return persisted
    return enqueueDiscovery(async () => {
      const result = await discoverProjectFavicon(root)
      const cache = await loadPersistentCache()
      cache.entries[key] = result.entry
      persistCache(cache)
      return result.dataUrl
    })
  }).then((dataUrl) => {
    faviconCache.set(key, dataUrl)
    return dataUrl
  }).finally(() => {
    faviconRequests.delete(key)
  })
  faviconRequests.set(key, request)
  return request
}

export function clearProjectFaviconCache(): void {
  faviconCache.clear()
  faviconRequests.clear()
  persistentCache = null
  discoveryQueue = Promise.resolve()
  persistenceQueue = Promise.resolve()
}

/** Wait for the latest atomic cache write; primarily useful for orderly shutdown and tests. */
export function flushProjectFaviconCache(): Promise<void> {
  return persistenceQueue
}
