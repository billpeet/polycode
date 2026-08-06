import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearProjectFaviconCache,
  projectFaviconDataUrl,
  resolveProjectFaviconPath,
} from '../project-favicon'

const roots: string[] = []
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'polycode-favicon-'))
  roots.push(root)
  return root
}

afterEach(() => {
  clearProjectFaviconCache()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('project favicon discovery', () => {
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
})
