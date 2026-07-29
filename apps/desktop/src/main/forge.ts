import type { PullRequest, SshConfig, WslConfig } from '../shared/types'
import { createPullRequest as createAzurePullRequest } from './azure-devops'
import { detectGitHostingProvider } from './git'
import { createGitHubPullRequest } from './github'

export interface Forge {
  createPullRequest(
    repoPath: string,
    payload: { target: string; title: string; description?: string },
  ): Promise<PullRequest>
}

export function createForge(ssh?: SshConfig | null, wsl?: WslConfig | null): Forge {
  return {
    async createPullRequest(repoPath, payload) {
      const provider = await detectGitHostingProvider(repoPath, ssh, wsl)
      if (provider === 'azure') return createAzurePullRequest(repoPath, payload, ssh, wsl)
      if (provider === 'github') return createGitHubPullRequest(repoPath, payload, ssh, wsl)
      throw new Error('Could not determine Git hosting provider from the repository remotes')
    },
  }
}
