/**
 * RunGit adapter. Facts only — the ADR-0001 policy lives in the lifecycle.
 *
 * Deliberately uncached: these reads decide whether a worktree is destroyed,
 * so they always hit git directly rather than any TTL cache. Runs are
 * local-only (a lifecycle interface precondition), hence the bare runner.
 */
import { createRunner } from '../../driver/runner'
import { runGit } from '../../git-runner'
import { resolveDefaultBranchRef } from '../../git'
import { RunGit } from '../types'

function exec(args: string[], cwd: string): Promise<string> {
  return runGit(createRunner({}), cwd, args)
}

export function createRunGit(): RunGit {
  return {
    async fetchOrigin(repoPath) {
      await exec(['fetch', 'origin'], repoPath)
    },

    resolveBaseRef(repoPath) {
      // Runs branch off the REMOTE default: a stale local main is exactly the
      // footgun the fetch-at-fire-time rule exists to avoid.
      return resolveDefaultBranchRef(repoPath, { includeLocal: false })
    },

    async workingTreeFacts(worktreePath) {
      const porcelain = (await exec(['status', '--porcelain'], worktreePath)).trim()
      const unpushed = (await exec(['rev-list', '--count', 'HEAD', '--not', '--remotes'], worktreePath)).trim()
      return { dirty: porcelain !== '', unpushedCommits: Number.parseInt(unpushed, 10) || 0 }
    },
  }
}
