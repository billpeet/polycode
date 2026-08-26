import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'polycode-favicon-cache-'))
vi.mock('electron', () => ({ app: { getPath: () => cacheRoot } }))
import {
  clearProjectFaviconCache,
  flushProjectFaviconCache,
  projectFaviconDataUrl,
  projectFaviconOverrideDataUrl,
  resolveProjectFaviconPath,
  storeProjectFaviconPath,
} from '../project-favicon'

const roots: string[] = []
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'polycode-favicon-'))
  roots.push(root)
  return root
}

afterEach(() => {
  clearProjectFaviconCache()
  fs.rmSync(path.join(cacheRoot, 'favicon-cache.json'), { force: true })
  fs.rmSync(path.join(cacheRoot, 'favicon-cache.json.tmp'), { force: true })
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('project favicon discovery', () => {
  it('stores files inside any project location as relative paths', () => {
    const first = path.join('C:', 'projects', 'main')
    const worktree = path.join('C:', 'projects', 'worktree')
    const icon = path.join(worktree, 'assets', 'project.svg')

    expect(storeProjectFaviconPath(icon, [first, worktree])).toBe(path.join('assets', 'project.svg'))
  })

  it('keeps files outside project locations as absolute paths', () => {
    const icon = path.resolve(tempRoot(), 'project.svg')
    expect(storeProjectFaviconPath(icon, [path.resolve(tempRoot())])).toBe(icon)
  })

  it('resolves a relative override against every local location', async () => {
    const first = tempRoot()
    const worktree = tempRoot()
    fs.mkdirSync(path.join(worktree, 'branding'))
    fs.writeFileSync(path.join(worktree, 'branding', 'project.svg'), '<svg/>')

    await expect(projectFaviconOverrideDataUrl(path.join('branding', 'project.svg'), [first, worktree]))
      .resolves.toMatch(/^data:image\/svg\+xml;base64,/)
  })

  it('finds a favicon in a nested monorepo app', async () => {
    const root = tempRoot()
    fs.mkdirSync(path.join(root, 'apps', 'web', 'static'), { recursive: true })
    fs.writeFileSync(path.join(root, 'apps', 'web', 'static', 'favicon.png'), 'png')
    await expect(resolveProjectFaviconPath(root)).resolves.toBe(path.join(root, 'apps', 'web', 'static', 'favicon.png'))
  })

  it('finds a SvelteKit static icon', async () => {
    const root = tempRoot()
    fs.mkdirSync(path.join(root, 'static'))
    fs.writeFileSync(path.join(root, 'static', 'icon.svg'), '<svg/>')
    await expect(resolveProjectFaviconPath(root)).resolves.toBe(path.join(root, 'static', 'icon.svg'))
  })

  it('prefers a well-known favicon', async () => {
    const root = tempRoot()
    fs.mkdirSync(path.join(root, 'public'))
    fs.writeFileSync(path.join(root, 'favicon.svg'), '<svg/>')
    fs.writeFileSync(path.join(root, 'public', 'favicon.png'), 'png')
    await expect(resolveProjectFaviconPath(root)).resolves.toBe(path.join(root, 'favicon.svg'))
    await expect(projectFaviconDataUrl(root)).resolves.toMatch(/^data:image\/svg\+xml;base64,/)
  })

  it('follows local icon metadata', async () => {
    const root = tempRoot()
    fs.mkdirSync(path.join(root, 'public', 'images'), { recursive: true })
    fs.writeFileSync(path.join(root, 'index.html'), '<link href="/images/app.png" rel="icon">')
    fs.writeFileSync(path.join(root, 'public', 'images', 'app.png'), 'png')
    await expect(resolveProjectFaviconPath(root)).resolves.toBe(path.join(root, 'public', 'images', 'app.png'))
  })

  it('returns null when no favicon exists', async () => {
    await expect(resolveProjectFaviconPath(tempRoot())).resolves.toBeNull()
  })

  it('caches successful and negative results', async () => {
    const iconRoot = tempRoot()
    fs.writeFileSync(path.join(iconRoot, 'favicon.png'), 'first')
    const first = await projectFaviconDataUrl(iconRoot)
    fs.writeFileSync(path.join(iconRoot, 'favicon.png'), 'second')
    await expect(projectFaviconDataUrl(iconRoot)).resolves.toBe(first)

    const emptyRoot = tempRoot()
    await expect(projectFaviconDataUrl(emptyRoot)).resolves.toBeNull()
    fs.writeFileSync(path.join(emptyRoot, 'favicon.png'), 'added-later')
    await expect(projectFaviconDataUrl(emptyRoot)).resolves.toBeNull()
  })

  it('deduplicates concurrent requests for the same project', async () => {
    const root = tempRoot()
    fs.writeFileSync(path.join(root, 'favicon.svg'), '<svg/>')
    const first = projectFaviconDataUrl(root)
    const second = projectFaviconDataUrl(root)

    expect(second).toBe(first)
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.stringMatching(/^data:image\/svg\+xml;base64,/),
      expect.stringMatching(/^data:image\/svg\+xml;base64,/),
    ])
  })

  it('persists positive results across in-memory cache resets', async () => {
    const root = tempRoot()
    fs.writeFileSync(path.join(root, 'favicon.svg'), '<svg>persisted</svg>')
    const first = await projectFaviconDataUrl(root)
    await flushProjectFaviconCache()
    clearProjectFaviconCache()

    await expect(projectFaviconDataUrl(root)).resolves.toBe(first)
  })

  it('persists negative results across in-memory cache resets', async () => {
    const root = tempRoot()
    await expect(projectFaviconDataUrl(root)).resolves.toBeNull()
    await flushProjectFaviconCache()
    clearProjectFaviconCache()
    fs.writeFileSync(path.join(root, 'favicon.png'), 'added after negative discovery')

    await expect(projectFaviconDataUrl(root)).resolves.toBeNull()
  })
})
