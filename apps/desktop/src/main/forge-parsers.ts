import type { AzureDevOpsPullRequest, GitHubPullRequest } from '../shared/types'

export interface GitHubRemote {
  owner: string
  repo: string
}

export interface AzureRepoContext {
  remoteName: string
  project: string | null
  repo: string
  remoteUrl: string
}

export interface GitHubPrInput {
  number?: number
  title?: string
  state?: string
  headRefName?: string
  baseRefName?: string
  author?: { login?: string; name?: string }
  url?: string
  createdAt?: string
}

export interface AzurePrInput {
  pullRequestId?: number
  title?: string
  status?: string
  sourceRefName?: string
  targetRefName?: string
  createdBy?: { displayName?: string }
  url?: string
  creationDate?: string
}

export function parseGitHubRemote(remoteUrl: string): GitHubRemote | null {
  const normalized = remoteUrl.replace(/\.git$/i, '')
  const match = normalized.match(/^https:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/?#]+)(?:[/?#].*)?$/i)
    ?? normalized.match(/^git@github\.com:([^/]+)\/([^/?#]+)(?:[/?#].*)?$/i)
    ?? normalized.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/?#]+)(?:[/?#].*)?$/i)
  return match ? { owner: decodeURIComponent(match[1] ?? ''), repo: decodeURIComponent(match[2] ?? '') } : null
}

export function mapGitHubPr(pr: GitHubPrInput): GitHubPullRequest {
  return {
    id: pr.number ?? 0,
    title: pr.title ?? '(untitled)',
    status: (pr.state ?? 'UNKNOWN').toLowerCase(),
    sourceBranch: pr.headRefName ?? '',
    targetBranch: pr.baseRefName ?? '',
    authorName: pr.author?.name ?? pr.author?.login ?? 'Unknown',
    url: pr.url ?? '',
    creationDate: pr.createdAt ?? '',
  }
}

export function normalizeAzureBranchName(branch: string, remoteName: string): string {
  const trimmed = branch.trim()
  if (!trimmed) return ''
  return trimmed
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\//, '')
    .replace(/^remotes\//, '')
    .replace(new RegExp(`^${remoteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`), '')
}

function normalizedAzureRepoUrl(remoteUrl: string): string {
  const normalized = remoteUrl.replace(/\.git$/i, '').replace(/\/+$/, '')
  const match = normalized.match(/^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)$/i)
    ?? normalized.match(/^ssh:\/\/git@ssh\.dev\.azure\.com\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/i)
  if (match) return `https://dev.azure.com/${match[1]}/${match[2]}/_git/${match[3]}`
  const legacy = normalized.match(/^git@vs-ssh\.visualstudio\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)$/i)
  if (legacy) return `https://${legacy[1]}.visualstudio.com/${legacy[2]}/_git/${legacy[3]}`
  return normalized
}

export function buildAzurePullRequestUrl(remoteUrl: string, prId: number): string {
  return `${normalizedAzureRepoUrl(remoteUrl)}/pullrequest/${prId}`
}

export function buildAzurePullRequestsUrl(remoteUrl: string): string {
  return `${normalizedAzureRepoUrl(remoteUrl)}/pullrequests`
}

export function buildAzureRepoUrl(remoteUrl: string): string {
  return normalizedAzureRepoUrl(remoteUrl)
}

export function mapAzurePr(pr: AzurePrInput, remoteUrl?: string): AzureDevOpsPullRequest {
  const id = pr.pullRequestId ?? 0
  return {
    id,
    title: pr.title ?? '(untitled)',
    status: pr.status ?? 'unknown',
    sourceBranch: pr.sourceRefName?.replace(/^refs\/heads\//, '') ?? '',
    targetBranch: pr.targetRefName?.replace(/^refs\/heads\//, '') ?? '',
    authorName: pr.createdBy?.displayName ?? 'Unknown',
    url: remoteUrl && id ? buildAzurePullRequestUrl(remoteUrl, id) : (pr.url ?? ''),
    creationDate: pr.creationDate ?? '',
  }
}

export function parseAzureRemote(remoteUrl: string): AzureRepoContext | null {
  const normalized = remoteUrl.replace(/\.git$/i, '')
  const patterns: Array<{ regex: RegExp; project: number | null; repo: number }> = [
    { regex: /^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)(?:[/?#].*)?$/i, project: 2, repo: 3 },
    { regex: /^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/_git\/([^/?#]+)(?:[/?#].*)?$/i, project: null, repo: 2 },
    { regex: /^https:\/\/([^.]+)\.visualstudio\.com\/(?:(?:DefaultCollection)\/)?([^/]+)\/_git\/([^/?#]+)(?:[/?#].*)?$/i, project: 2, repo: 3 },
    { regex: /^https:\/\/([^.]+)\.visualstudio\.com\/_git\/([^/?#]+)(?:[/?#].*)?$/i, project: null, repo: 2 },
    { regex: /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/?#]+)(?:[/?#].*)?$/i, project: 2, repo: 3 },
    { regex: /^ssh:\/\/git@ssh\.dev\.azure\.com\/v3\/([^/]+)\/([^/]+)\/([^/?#]+)(?:[/?#].*)?$/i, project: 2, repo: 3 },
    { regex: /^git@vs-ssh\.visualstudio\.com:v3\/([^/]+)\/([^/]+)\/([^/?#]+)(?:[/?#].*)?$/i, project: 2, repo: 3 },
    { regex: /^ssh:\/\/git@vs-ssh\.visualstudio\.com(?::\d+)?\/DefaultCollection\/([^/]+)\/_ssh\/([^/?#]+)(?:[/?#].*)?$/i, project: 1, repo: 2 },
  ]
  for (const pattern of patterns) {
    const match = normalized.match(pattern.regex)
    if (match) {
      return {
        remoteName: 'origin',
        project: pattern.project === null ? null : decodeURIComponent(match[pattern.project] ?? ''),
        repo: decodeURIComponent(match[pattern.repo] ?? ''),
        remoteUrl,
      }
    }
  }
  return null
}
