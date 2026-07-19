import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { projectFaviconDataUrl, resolveProjectFaviconPath } from '../project-favicon'

const roots: string[] = []
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'polycode-favicon-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('project favicon discovery', () => {
  it('finds a favicon in a nested monorepo app', () => {
    const root = tempRoot()
    fs.mkdirSync(path.join(root, 'apps', 'web', 'static'), { recursive: true })
    fs.writeFileSync(path.join(root, 'apps', 'web', 'static', 'favicon.png'), 'png')
    expect(resolveProjectFaviconPath(root)).toBe(path.join(root, 'apps', 'web', 'static', 'favicon.png'))
  })

  it('finds a SvelteKit static icon', () => {
    const root = tempRoot()
    fs.mkdirSync(path.join(root, 'static'))
    fs.writeFileSync(path.join(root, 'static', 'icon.svg'), '<svg/>')
    expect(resolveProjectFaviconPath(root)).toBe(path.join(root, 'static', 'icon.svg'))
  })

  it('prefers a well-known favicon', () => {
    const root = tempRoot()
    fs.mkdirSync(path.join(root, 'public'))
    fs.writeFileSync(path.join(root, 'favicon.svg'), '<svg/>')
    fs.writeFileSync(path.join(root, 'public', 'favicon.png'), 'png')
    expect(resolveProjectFaviconPath(root)).toBe(path.join(root, 'favicon.svg'))
    expect(projectFaviconDataUrl(root)).toMatch(/^data:image\/svg\+xml;base64,/)
  })

  it('follows local icon metadata', () => {
    const root = tempRoot()
    fs.mkdirSync(path.join(root, 'public', 'images'), { recursive: true })
    fs.writeFileSync(path.join(root, 'index.html'), '<link href="/images/app.png" rel="icon">')
    fs.writeFileSync(path.join(root, 'public', 'images', 'app.png'), 'png')
    expect(resolveProjectFaviconPath(root)).toBe(path.join(root, 'public', 'images', 'app.png'))
  })

  it('returns null when no favicon exists', () => {
    expect(resolveProjectFaviconPath(tempRoot())).toBeNull()
  })
})
