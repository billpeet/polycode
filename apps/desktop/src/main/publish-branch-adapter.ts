import type { SshConfig, WslConfig } from '../shared/types'
import { createForge } from './forge'
import {
  commitChangesAndGetHash,
  createBranch,
  getGitStatus,
  gitPush,
  stageAll,
} from './git'
import { publishBranch, type PublishBranchDependencies } from './publish-branch'
import type { PublishBranchInput, PublishBranchResult } from '../shared/types'
import { PublishBranchError } from './publish-branch'

export function createPublishBranchDependencies(
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): PublishBranchDependencies {
  const forge = createForge(ssh, wsl)
  return {
    async inspect(repoPath) {
      const status = await getGitStatus(repoPath, ssh, wsl)
      if (!status) throw new Error('Could not read repository status')
      return {
        branch: status.branch,
        dirty: status.files.length > 0,
        ahead: status.ahead,
        hasUpstream: status.hasUpstream,
      }
    },
    createBranch: (repoPath, name, base) => createBranch(repoPath, name, base, false, ssh, wsl),
    stageAll: (repoPath) => stageAll(repoPath, ssh, wsl),
    commit: (repoPath, message) => commitChangesAndGetHash(repoPath, message, ssh, wsl),
    async push(repoPath) {
      await gitPush(repoPath, ssh, wsl)
    },
    createPullRequest: (repoPath, payload) => forge.createPullRequest(repoPath, payload),
  }
}

export async function publishRepositoryBranch(
  input: PublishBranchInput,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<PublishBranchResult> {
  try {
    return await publishBranch(input, createPublishBranchDependencies(ssh, wsl))
  } catch (error: unknown) {
    if (!(error instanceof PublishBranchError)) throw error
    return {
      ok: false,
      failedAt: error.failedAt,
      effects: error.effects,
      message: error.message,
    }
  }
}
