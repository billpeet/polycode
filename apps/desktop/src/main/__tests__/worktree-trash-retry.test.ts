import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ failures: 0, calls: 0 }))
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    rename: async (from: string, to: string) => {
      state.calls += 1
      if (state.failures > 0) {
        state.failures -= 1
        throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })
      }
      return real.rename(from, to)
    },
  }
})

import { discardDirectory } from '../worktree-trash'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'polycode-trash-retry-')); state.calls = 0 })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function makeWorktree(name: string): string {
  const path = join(root, name)
  mkdirSync(join(path, 'src'), { recursive: true })
  writeFileSync(join(path, 'src', 'f.txt'), 'x')
  return path
}

it('retries a busy rename with backoff and moves the directory aside once it frees up', async () => {
  const path = makeWorktree('wt')
  state.failures = 2
  const waited: number[] = []
  const result = await discardDirectory(path, { inPlaceFallback: false, delay: async (ms) => { waited.push(ms) } })
  expect(result.movedTo).not.toBeNull()
  expect(existsSync(path)).toBe(false)
  expect(state.calls).toBe(3)
  expect(waited).toEqual([100, 200])
  await result.done
})

it('gives up after the schedule is exhausted and reports the directory as not moved', async () => {
  const path = makeWorktree('wt2')
  state.failures = 99
  const result = await discardDirectory(path, { inPlaceFallback: false, delay: async () => {} })
  expect(result).toMatchObject({ existed: true, movedTo: null })
  expect(existsSync(path)).toBe(true)
  expect(state.calls).toBe(6)
  await result.done
})
