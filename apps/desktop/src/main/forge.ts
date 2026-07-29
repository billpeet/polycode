import type { PullRequest, SshConfig, WslConfig } from '../shared/types'
import {
  checkoutPullRequestBranch as checkoutAzurePullRequest,
  createPullRequest as createAzurePullRequest,
  getCurrentBranchPullRequest as getCurrentAzurePullRequest,
  getPullRequestsWebUrl as getAzurePullRequestsWebUrl,
  getRepoWebUrl as getAzureRepoWebUrl,
  listOpenPullRequests as listAzurePullRequests,
} from './azure-devops'
import { detectGitHostingProviderCached } from './git'
import {
  checkoutGitHubPullRequestBranch as checkoutGitHubPullRequest,
  createGitHubPullRequest,
  getCurrentBranchGitHubPullRequest,
  getGitHubPullRequestsWebUrl,
  getGitHubRepoWebUrl,
  listOpenGitHubPullRequests,
} from './github'

export interface Forge {
  listPullRequests(): Promise<PullRequest[]>
  getCurrentBranchPullRequest(branch: string): Promise<PullRequest | null>
  createPullRequest(payload: {
    target: string
    title: string
    description?: string
  }): Promise<PullRequest>
  checkoutPullRequest(prId: number): Promise<{ branch: string }>
  getPullRequestsWebUrl(): Promise<string>
  getRepoWebUrl(): Promise<string>
}

interface ForgeAdapter {
  listPullRequests(
    repoPath: string,
    ssh?: SshConfig | null,
    wsl?: WslConfig | null,
  ): Promise<PullRequest[]>
  getCurrentBranchPullRequest(
    repoPath: string,
    branch: string,
    ssh?: SshConfig | null,
    wsl?: WslConfig | null,
  ): Promise<PullRequest | null>
  createPullRequest(
    repoPath: string,
    payload: { target: string; title: string; description?: string },
    ssh?: SshConfig | null,
    wsl?: WslConfig | null,
  ): Promise<PullRequest>
  checkoutPullRequest(
    repoPath: string,
    prId: number,
    ssh?: SshConfig | null,
    wsl?: WslConfig | null,
  ): Promise<{ branch: string }>
  getPullRequestsWebUrl(
    repoPath: string,
    ssh?: SshConfig | null,
    wsl?: WslConfig | null,
  ): Promise<string>
  getRepoWebUrl(
    repoPath: string,
    ssh?: SshConfig | null,
    wsl?: WslConfig | null,
  ): Promise<string>
}

export interface ForgeDependencies {
  detectProvider: typeof detectGitHostingProviderCached
  azure: ForgeAdapter
  github: ForgeAdapter
}

const defaultDependencies: ForgeDependencies = {
  // Cached: createForge runs per operation, and GitSection fires three forge
  // calls at once. The uncached probe costs 2+ git subprocesses each time,
  // over SSH for remote locations.
  detectProvider: detectGitHostingProviderCached,
  azure: {
    listPullRequests: listAzurePullRequests,
    getCurrentBranchPullRequest: getCurrentAzurePullRequest,
    createPullRequest: createAzurePullRequest,
    checkoutPullRequest: checkoutAzurePullRequest,
    getPullRequestsWebUrl: getAzurePullRequestsWebUrl,
    getRepoWebUrl: getAzureRepoWebUrl,
  },
  github: {
    listPullRequests: listOpenGitHubPullRequests,
    getCurrentBranchPullRequest: getCurrentBranchGitHubPullRequest,
    createPullRequest: createGitHubPullRequest,
    checkoutPullRequest: checkoutGitHubPullRequest,
    getPullRequestsWebUrl: getGitHubPullRequestsWebUrl,
    getRepoWebUrl: getGitHubRepoWebUrl,
  },
}

function bindForge(
  adapter: ForgeAdapter,
  repoPath: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Forge {
  return {
    listPullRequests: () => adapter.listPullRequests(repoPath, ssh, wsl),
    getCurrentBranchPullRequest: (branch) => adapter.getCurrentBranchPullRequest(repoPath, branch, ssh, wsl),
    createPullRequest: (payload) => adapter.createPullRequest(repoPath, payload, ssh, wsl),
    checkoutPullRequest: (prId) => adapter.checkoutPullRequest(repoPath, prId, ssh, wsl),
    getPullRequestsWebUrl: () => adapter.getPullRequestsWebUrl(repoPath, ssh, wsl),
    getRepoWebUrl: () => adapter.getRepoWebUrl(repoPath, ssh, wsl),
  }
}

export async function createForge(
  repoPath: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
  dependencies: ForgeDependencies = defaultDependencies,
): Promise<Forge> {
  const provider = await dependencies.detectProvider(repoPath, ssh, wsl)
  if (provider === 'azure') return bindForge(dependencies.azure, repoPath, ssh, wsl)
  if (provider === 'github') return bindForge(dependencies.github, repoPath, ssh, wsl)
  throw new Error('Could not determine Git hosting provider from the repository remotes')
}
