/**
 * The preload bridge gates `invoke` on CHANNEL_REGISTRY, which makes the registry a
 * runtime trust boundary rather than only a typing convenience.
 *
 * That gate can break working features if renderer code invokes a channel that is not
 * declared `local: true`, so this test walks every literal `invoke('...')` in the
 * renderer and checks it against the allowlist.
 */
import { describe, expect, test } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHANNEL_REGISTRY, isLocalChannel, LOCAL_CHANNELS } from '@polycode/shared'

const rendererDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'renderer', 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry) ? [full] : []
  })
}

/** Channels the renderer invokes, as string literals. Template literals are skipped. */
function invokedChannels(): Set<string> {
  const found = new Set<string>()
  for (const file of sourceFiles(rendererDir)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/\binvoke(?:<[^>]*>)?\(\s*'([^']+)'/g)) {
      found.add(match[1])
    }
  }
  return found
}

describe('preload channel allowlist', () => {
  test('LOCAL_CHANNELS matches the registry', () => {
    const expected = Object.entries(CHANNEL_REGISTRY)
      .filter(([, capability]) => capability.local)
      .map(([channel]) => channel)
    expect([...LOCAL_CHANNELS].sort()).toEqual(expected.sort())
  })

  test('remote-only channels are not reachable from the renderer', () => {
    expect(isLocalChannel('attachments:readDataUrl')).toBe(false)
    expect(isLocalChannel('plans:getForThread')).toBe(false)
    expect(isLocalChannel('definitely-not-a-channel')).toBe(false)
  })

  test('every channel the renderer invokes is allowlisted', () => {
    const invoked = [...invokedChannels()]
    expect(invoked.length).toBeGreaterThan(100)

    const blocked = invoked.filter((channel) => !isLocalChannel(channel))
    expect(blocked).toEqual([])
  })
})
