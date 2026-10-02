import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discardDirectory, isPathInside } from '../worktree-trash'

let root: string

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'polycode-trash-test-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function makeWorktree(name: string): string {
  const path = join(root, name)
  mkdirSync(join(path, 'src', 'deep'), { recursive: true })
  writeFileSync(join(path, 'src', 'deep', 'file.txt'), 'content')
  return path
}

describe('discardDirectory', () => {
  it('frees the original path before the delete finishes, then deletes in the background', async () => {
    const path = makeWorktree('wt1')

    const result = await discardDirectory(path)

    expect(existsSync(path)).toBe(false)
    expect(result.movedTo).not.toBeNull()
    await result.done
    expect(readdirSync(root)).toEqual([])
  })

  it('sweeps tombstones left behind by an interrupted earlier delete', async () => {
    const leftover = makeWorktree('.polycode-trash-old-abc')
    const path = makeWorktree('wt2')

    await (await discardDirectory(path)).done

    expect(existsSync(leftover)).toBe(false)
    expect(readdirSync(root)).toEqual([])
  })

  it('is a no-op for a directory that is already gone', async () => {
    const result = await discardDirectory(join(root, 'missing'))
    await result.done
    expect(result.movedTo).toBeNull()
  })
})

describe('isPathInside', () => {
  it('matches the directory itself and its descendants, not siblings sharing a prefix', () => {
    const base = join(root, 'repo-worktrees', 'abc')
    expect(isPathInside(base, base)).toBe(true)
    expect(isPathInside(base, join(base, 'src', 'index.ts'))).toBe(true)
    expect(isPathInside(base, join(root, 'repo-worktrees', 'abcdef'))).toBe(false)
    expect(isPathInside(base, join(root, 'repo-worktrees'))).toBe(false)
  })
})
