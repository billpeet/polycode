import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `window.api` is reachable from exactly one renderer module. Everything else goes
 * through `lib/client.ts`, which is what lets the same bundle run in a browser served by a
 * Remote Host. The type declaration makes `window.api` optional so a direct call fails to
 * compile in strict mode; this test says the same thing for anyone reading the failure.
 */

const RENDERER_SRC = fileURLToPath(new URL('../..', import.meta.url))
const OWNER = join('lib', 'client.ts')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') sourceFiles(path, out)
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(path)
    }
  }
  return out
}

describe('renderer client seam', () => {
  it('reaches window.api only from lib/client.ts', () => {
    const offenders = sourceFiles(RENDERER_SRC)
      .map((path) => relative(RENDERER_SRC, path))
      .filter((rel) => rel !== OWNER)
      .filter((rel) => {
        const source = readFileSync(join(RENDERER_SRC, rel), 'utf8')
        // Strip comments so prose that mentions the bridge does not count.
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
        return /\bwindow\s*\.\s*api\b/.test(code)
      })
      .map((rel) => rel.split(sep).join('/'))

    expect(offenders).toEqual([])
  })
})
