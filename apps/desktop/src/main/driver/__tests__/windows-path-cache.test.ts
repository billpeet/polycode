import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ sync: 0, async: 0 }))
const REG_OUTPUT = String.raw`
HKEY_CURRENT_USER\Environment
    Path    REG_EXPAND_SZ    C:\FromRegistry
`
vi.mock('child_process', async (original) => ({
  ...await original<typeof import('child_process')>(),
  spawnSync: vi.fn(() => { calls.sync++; return { status: 0, stdout: REG_OUTPUT } }),
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => {
    calls.async++
    setImmediate(() => cb(null, REG_OUTPUT.replace('FromRegistry', 'Updated')))
  }),
}))

import { augmentWindowsPath, resetWindowsPathCacheForTest, warmWindowsPathCache } from '../runner/utils'

const FROM_REGISTRY = String.raw`C:\FromRegistry`
const UPDATED = String.raw`C:\Updated`

let now = 0
beforeEach(() => { calls.sync = 0; calls.async = 0; now = 0; resetWindowsPathCacheForTest(() => now) })
afterEach(() => resetWindowsPathCacheForTest())

it.skipIf(process.platform !== 'win32')('reads the registry once, not once per child process', () => {
  const env = { Path: String.raw`C:\Tools` }
  for (let i = 0; i < 50; i++) expect(augmentWindowsPath(env).Path).toContain(FROM_REGISTRY)
  expect(calls.sync).toBe(2) // user + machine, once
  expect(calls.async).toBe(0)
})

it.skipIf(process.platform !== 'win32')('refreshes a stale snapshot in the background without blocking the caller', async () => {
  augmentWindowsPath({ Path: '' })
  now = 5 * 60_000
  // Stale: this call still answers from the old snapshot and starts an async refresh.
  expect(augmentWindowsPath({ Path: '' }).Path).toContain(FROM_REGISTRY)
  expect(calls.async).toBe(2)
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  expect(augmentWindowsPath({ Path: '' }).Path).toContain(UPDATED)
  expect(calls.sync).toBe(2)
})

it.skipIf(process.platform !== 'win32')('warming at startup means no spawn ever reads the registry synchronously', async () => {
  await warmWindowsPathCache()
  augmentWindowsPath({ Path: '' })
  expect(calls.sync).toBe(0)
  expect(calls.async).toBe(2)
})
