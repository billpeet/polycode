import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let home: string

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => home,
}))

const { ensureScratchDir, removeScratchDir, scratchDirForThread } = await import('../scratch')

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'polycode-scratch-test-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('scratch directories', () => {
  it('places each thread in its own directory under ~/.polycode/scratch', () => {
    expect(scratchDirForThread('thread-1')).toBe(join(home, '.polycode', 'scratch', 'thread-1'))
  })

  it('creates the directory on demand and is idempotent', () => {
    const dir = ensureScratchDir('thread-1')
    expect(dir && existsSync(dir)).toBe(true)
    expect(ensureScratchDir('thread-1')).toBe(dir)
  })

  it('removes the directory and its contents, leaving other threads alone', async () => {
    const dir = ensureScratchDir('thread-1')!
    const other = ensureScratchDir('thread-2')!
    writeFileSync(join(dir, 'notes.md'), 'analysis')

    await removeScratchDir('thread-1')

    expect(existsSync(dir)).toBe(false)
    expect(existsSync(other)).toBe(true)
  })

  it('resolves when there is nothing to remove', async () => {
    await expect(removeScratchDir('never-created')).resolves.toBeUndefined()
  })

  it.each(['..', '.', '', '../outside', 'a/b', 'a\\b', 'C:'])('refuses the unsafe thread id %j', async (id) => {
    const keep = join(home, '.polycode', 'keep.txt')
    ensureScratchDir('thread-1')
    writeFileSync(keep, 'keep')

    expect(scratchDirForThread(id)).toBeNull()
    expect(ensureScratchDir(id)).toBeNull()
    await removeScratchDir(id)

    expect(existsSync(keep)).toBe(true)
    expect(existsSync(join(home, '.polycode', 'scratch', 'thread-1'))).toBe(true)
  })
})
