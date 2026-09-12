import { createReadStream, promises as fs } from 'fs'
import type * as http from 'http'
import { extname, join, resolve, sep } from 'path'

/**
 * Serves the renderer bundle to browsers. Only two shapes of path exist in that bundle —
 * `index.html` and hashed files under `assets/` — and nothing else under the root is
 * reachable, whatever the request says.
 */

/**
 * The web UI's policy. The renderer bundle is self-contained (PostHog is the
 * `no-external` build, Sentry is a fetch target, not a script), so scripts are
 * `'self'` only; `'wasm-unsafe-eval'` is for shiki's Oniguruma engine. Inline styles
 * are what Tailwind, xterm and shiki emit, so `style-src` allows them. Anything
 * user-controlled that reaches the DOM already goes through DOMPurify or React text
 * nodes — this header is the second line, not the first.
 */
export const WEB_UI_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.sentry.io https://*.posthog.com",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ')

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
}

export function isStaticPath(pathname: string): boolean {
  return pathname === '/' || pathname === '/index.html' || pathname.startsWith('/assets/')
}

/**
 * Map a request path onto a file under `root`, or null when it names anything other
 * than `index.html` or a file directly inside `assets/`. Resolution is absolute, so a
 * traversal segment that survives URL normalisation still cannot escape.
 */
export function resolveStaticFile(root: string, pathname: string): string | null {
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  let decoded: string
  try {
    decoded = decodeURIComponent(relativePath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null

  const rootAbs = resolve(root)
  const file = resolve(rootAbs, decoded)
  const index = join(rootAbs, 'index.html')
  const assets = join(rootAbs, 'assets') + sep
  if (file !== index && !file.startsWith(assets)) return null
  return file
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Not found')
}

export async function serveStaticFile(
  root: string,
  pathname: string,
  res: http.ServerResponse,
): Promise<void> {
  const file = resolveStaticFile(root, pathname)
  if (!file) return notFound(res)

  let size: number
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) return notFound(res)
    size = stat.size
  } catch {
    return notFound(res)
  }

  const isIndex = file === join(resolve(root), 'index.html')
  const headers: http.OutgoingHttpHeaders = {
    'Content-Type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': size,
    // Vite content-hashes everything under assets/; index.html is the one mutable entry.
    'Cache-Control': isIndex ? 'no-store' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  }
  if (isIndex) {
    headers['Content-Security-Policy'] = WEB_UI_CONTENT_SECURITY_POLICY
    headers['Referrer-Policy'] = 'no-referrer'
  }

  res.writeHead(200, headers)
  const stream = createReadStream(file)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}
