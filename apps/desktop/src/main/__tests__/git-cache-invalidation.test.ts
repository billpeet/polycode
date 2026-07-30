/**
 * `git.ts` mutations clear their own read cache — tested against the real module.
 *
 * This coverage used to live in `dispatch-characterisation.test.ts`, as a
 * `git.invalidateGitCache([...])` entry at the end of 24 recorded call sequences. That file
 * mocks `../git` wholesale, so once the invalidation moved *inside* `git.ts` those entries
 * could only have been deleted — leaving nothing in the suite asserting that any git mutation
 * invalidates anything. The assertions moved here instead, and got stronger in the move:
 *
 * - The invalidation is **observed, not spied**. Every test reads through a cached entry point
 *   (`getCachedGitStatus`), reads again to prove the second read is a cache *hit*, then mutates
 *   and reads a third time. What is asserted is how many git commands the Runner actually ran.
 *   A test that only checked "invalidateGitCache was called" would still pass if the call
 *   targeted the wrong scope, which is the failure mode most likely to happen silently.
 * - The **scope** is asserted directly: `invalidateGitCache` is keyed on
 *   `getCacheScope(repoPath, ssh, wsl)`, so a mutation must clear one repo on one transport and
 *   leave every neighbouring key alone.
 *
 * `git.ts` builds its Runner per command via `createRunner({ ssh, wsl })`, so that module is
 * mocked to hand back one `FakeRunner` whose `runCommands` is the command counter. The cache is
 * module-level state, hence a fresh `import` per test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeRunner } from '../driver/runner/fake'
import type { RunCommand, RunResult } from '../driver/runner'

const createRunnerMock = vi.fn()

vi.mock('../driver/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../driver/runner')>()
  return { ...actual, createRunner: (...args: unknown[]) => createRunnerMock(...args) }
})

/**
 * A `FakeRunner` that can fail one *specific* command.
 *
 * `queueResult` is positional, and the calls under test spend a variable number of commands
 * before the one that matters (`discardFileChanges` probes for HEAD and for the file in HEAD
 * first), so "fail the Nth result" would be pinned to those internals. Matching on the
 * arguments is not.
 */
class ScriptedRunner extends FakeRunner {
  failFor: RegExp | null = null
  failStdout = ''

  override async run(command: RunCommand): Promise<RunResult> {
    const result = await super.run(command)
    if (this.failFor?.test(command.args.join(' '))) {
      return {
        stdout: this.failStdout,
        // Deliberately not lock-shaped: `runGit` retries lock failures ten times.
        stderr: 'fatal: scripted failure',
        exitCode: 128,
        timedOut: false,
      }
    }
    return result
  }
}

const REPO = 'C:/repo'
const OTHER_REPO = 'C:/other'
const SSH = { host: 'build.test', user: 'alice' }
const WSL = { distro: 'Ubuntu' }

let runner: ScriptedRunner
let git: typeof import('../git')

beforeEach(async () => {
  runner = new ScriptedRunner()
  createRunnerMock.mockReset()
  // One shared Runner for every command, so `runCommands.length` is a global counter.
  createRunnerMock.mockImplementation(() => runner)
  // Fresh module: `gitReadCache` is module-level state.
  vi.resetModules()
  git = await import('../git')
})

/** Read cached status and report how many git commands that read actually spent. */
async function statusCost(
  repoPath = REPO,
  ssh: typeof SSH | null = null,
  wsl: typeof WSL | null = null,
): Promise<number> {
  const before = runner.runCommands.length
  await git.getCachedGitStatus(repoPath, ssh, wsl)
  return runner.runCommands.length - before
}

/** Populate the cache for a scope and assert the next read is served from it. */
async function warmCache(
  repoPath = REPO,
  ssh: typeof SSH | null = null,
  wsl: typeof WSL | null = null,
): Promise<void> {
  expect(await statusCost(repoPath, ssh, wsl)).toBeGreaterThan(0)
  // The load-bearing half of the fixture: without a proven cache hit here, the "cache was
  // cleared" assertion below would also pass against a cache that never worked at all.
  expect(await statusCost(repoPath, ssh, wsl)).toBe(0)
}

describe('git.ts mutations invalidate the repo they mutated', () => {
  /**
   * A representative spread rather than all 23: one stage, one unstage, one commit, one stash,
   * one branch operation, one pull, one discard, plus `gitInit` (the one whose invalidation a
   * non-handler caller newly triggers, via project-admin.ts).
   */
  const MUTATIONS: Array<[label: string, run: (g: typeof git) => Promise<unknown>]> = [
    ['stageFile', (g) => g.stageFile(REPO, 'src/a.ts', null, null)],
    ['stageAll', (g) => g.stageAll(REPO, null, null)],
    ['unstageFile', (g) => g.unstageFile(REPO, 'src/a.ts', null, null)],
    ['commitChanges', (g) => g.commitChanges(REPO, 'a message', null, null)],
    ['amendCommit', (g) => g.amendCommit(REPO, null, null, null)],
    ['undoLastCommit', (g) => g.undoLastCommit(REPO, null, null)],
    ['createStash', (g) => g.createStash(REPO, { includeUntracked: true }, null, null)],
    ['popStash', (g) => g.popStash(REPO, 'stash@{0}', null, null)],
    ['checkoutBranch', (g) => g.checkoutBranch(REPO, 'main', null, null)],
    ['createBranch', (g) => g.createBranch(REPO, 'feature/y', 'main', false, null, null)],
    ['gitPull', (g) => g.gitPull(REPO, null, null)],
    ['gitPullWithAutoStash', (g) => g.gitPullWithAutoStash(REPO, true, null, null)],
    ['gitPush', (g) => g.gitPush(REPO, null, null)],
    ['mergeBranch', (g) => g.mergeBranch(REPO, 'feature/y', null, null)],
    ['discardFileChanges', (g) => g.discardFileChanges(REPO, 'src/a.ts', null, null, null)],
    ['discardAllChanges', (g) => g.discardAllChanges(REPO, null, null)],
    ['gitInit', (g) => g.gitInit(REPO, null, null)],
  ]

  for (const [label, run] of MUTATIONS) {
    it(`${label} clears the cached status for its repo`, async () => {
      await warmCache()

      await run(git)

      // Cleared: the read had to hit git again. This is the whole assertion — no spy on
      // `invalidateGitCache`, because a spy cannot tell a right scope from a wrong one.
      expect(await statusCost()).toBeGreaterThan(0)
    })
  }

  it('a mutation that throws leaves the cache alone — the failure semantics the handlers had', async () => {
    // The invalidation sits at the END of each function body rather than in a `finally`, which
    // is exactly where the dispatch layer used to put it: after the `await`, so a rejection
    // skips it. A failed operation changed nothing, so there is nothing stale to clear.
    await warmCache()

    runner.failFor = /^add -- src\/a\.ts$/
    await expect(git.stageFile(REPO, 'src/a.ts', null, null)).rejects.toThrow('scripted failure')

    expect(await statusCost()).toBe(0)
  })

  it('a conflicted merge invalidates too — it resolves rather than throwing', async () => {
    // `mergeBranch` is the one mutation with two success exits, and the conflicted one is the
    // easy exit to forget: the merge command *failed*, but the working tree now holds conflict
    // markers and a half-merged index, so the next `git:status` read has to see them.
    await warmCache()

    runner.failFor = /^merge feature\/y$/
    runner.failStdout = 'CONFLICT (content): Merge conflict in src/a.ts\nAutomatic merge failed'

    await expect(git.mergeBranch(REPO, 'feature/y', null, null)).resolves.toEqual({
      conflicts: ['src/a.ts'],
    })
    expect(await statusCost()).toBeGreaterThan(0)
  })

  it('a bulk discard that fails part-way leaves no stale cache — a fixed bug', async () => {
    // BEHAVIOUR CHANGE, pinned deliberately. `git:discardFiles` discards one file at a time,
    // collects per-file errors, and throws a summary at the end — jumping straight past the
    // `invalidateRepoGitCache(repoPath)` that used to be the handler's last line. So a partial
    // failure discarded some files and then left the cache stale for a repo that really did
    // change. With the invalidation inside `discardFileChanges`, each successful discard clears
    // the cache on its own and there is no stale window left to leave behind.
    //
    // The sequence below is that handler's loop, with no read in between — which is what makes
    // it discriminating: under the old arrangement the final read would be a cache HIT.
    await warmCache()

    await git.discardFileChanges(REPO, 'src/a.ts', null, null, null)

    runner.failFor = /^checkout HEAD -- src\/b\.ts$/
    const errors: string[] = []
    try {
      await git.discardFileChanges(REPO, 'src/b.ts', null, null, null)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
    expect(errors).toHaveLength(1)

    expect(await statusCost()).toBeGreaterThan(0)
  })
})

/**
 * The scoping property — `invalidateGitCache` walks `gitReadCache` deleting keys that end in
 * `::${getCacheScope(repoPath, ssh, wsl)}`, so it is one `endsWith` away from clearing far more
 * than it should, and a suffix bug is invisible in a single-repo single-transport test.
 */
describe('invalidateGitCache is scoped to one repo on one transport', () => {
  it('a mutation in one repo leaves another repo cached', async () => {
    await warmCache(REPO)
    await warmCache(OTHER_REPO)

    await git.stageAll(REPO, null, null)

    expect(await statusCost(REPO)).toBeGreaterThan(0)
    expect(await statusCost(OTHER_REPO)).toBe(0)
  })

  it('an ssh-hosted mutation leaves the local scope for the same path cached', async () => {
    // The same repoPath under two transports is two independent cache scopes — a repo checked
    // out at the same path locally and on a build host is the real case. Clearing the wrong one
    // would show up as a UI that never refreshes for one of them.
    await warmCache(REPO, SSH, null)
    await warmCache(REPO, null, null)

    await git.commitChanges(REPO, 'remote work', SSH, null)

    expect(await statusCost(REPO, SSH, null)).toBeGreaterThan(0)
    expect(await statusCost(REPO, null, null)).toBe(0)
  })

  it('a local mutation leaves the ssh and wsl scopes for the same path cached', async () => {
    // The other direction, and the wsl scope as a third neighbour: `getTransportCacheKey`
    // renders local as `'local'`, which is a *substring* of nothing but is also the fallback
    // for both null configs — so this is the case a mis-keyed default would break.
    await warmCache(REPO, null, null)
    await warmCache(REPO, SSH, null)
    await warmCache(REPO, null, WSL)

    await git.checkoutBranch(REPO, 'main', null, null)

    expect(await statusCost(REPO, null, null)).toBeGreaterThan(0)
    expect(await statusCost(REPO, SSH, null)).toBe(0)
    expect(await statusCost(REPO, null, WSL)).toBe(0)
  })

  it('two wsl distros at the same path are separate scopes', async () => {
    await warmCache(REPO, null, { distro: 'Ubuntu' })
    await warmCache(REPO, null, { distro: 'Debian' })

    await git.stageFile(REPO, 'src/a.ts', null, { distro: 'Ubuntu' })

    expect(await statusCost(REPO, null, { distro: 'Ubuntu' })).toBeGreaterThan(0)
    expect(await statusCost(REPO, null, { distro: 'Debian' })).toBe(0)
  })

  it('clears every cached op for the scope, not just the one the caller happened to read', async () => {
    // `getCacheScope` is the suffix; the op name is the prefix. A mutation has to clear all of
    // them — a `status` read that refreshes while `branches` and `isRepo` stay stale is the
    // shape of bug this asserts against.
    await warmCache(REPO)
    const branchesCost = await countingRead(() => git.listCachedBranches(REPO, null, null))
    const isRepoCost = await countingRead(() => git.isGitRepoCached(REPO, null, null))
    expect(branchesCost).toBeGreaterThan(0)
    expect(isRepoCost).toBeGreaterThan(0)
    expect(await countingRead(() => git.listCachedBranches(REPO, null, null))).toBe(0)
    expect(await countingRead(() => git.isGitRepoCached(REPO, null, null))).toBe(0)

    await git.gitInit(REPO, null, null)

    expect(await statusCost()).toBeGreaterThan(0)
    expect(await countingRead(() => git.listCachedBranches(REPO, null, null))).toBeGreaterThan(0)
    expect(await countingRead(() => git.isGitRepoCached(REPO, null, null))).toBeGreaterThan(0)
  })
})

/** How many git commands one read spent. */
async function countingRead(read: () => Promise<unknown>): Promise<number> {
  const before = runner.runCommands.length
  await read()
  return runner.runCommands.length - before
}
