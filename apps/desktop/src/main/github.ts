import { promises as fsPromises } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { GitHubPullRequest, SshConfig, WslConfig } from '../shared/types'
import { createRunner } from './driver/runner'
import { runGit } from './git-runner'
import { mapGitHubPr as mapPr, parseGitHubRemote } from './forge-parsers'
import type { GitHubPrInput as GhPullRequest } from './forge-parsers'

interface GitHubRepoContext {
  remoteName: string
  owner: string
  repo: string
}

async function git(repoPath: string, args: string[], ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<string> {
  return runGit(createRunner({ ssh: ssh ?? undefined, wsl: wsl ?? undefined }), repoPath, args)
}

async function runGh(repoPath: string, args: string[], ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<string> {
  const runner = createRunner({ ssh: ssh ?? undefined, wsl: wsl ?? undefined })
  const result = await runner.run({ binary: 'gh', args, workDir: repoPath })
  if (result.exitCode !== 0) {
    if (/ENOENT|EINVAL|not found|is not recognized/i.test(result.stderr)) {
      throw new Error('gh CLI not found. Install and authenticate it first (gh auth login).')
    }
    throw new Error(result.stderr || 'Failed to execute gh CLI')
  }
  return result.stdout.trim()
}

async function resolveRepoContext(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<GitHubRepoContext> {
  const remoteNamesRaw = await git(repoPath, ['remote'], ssh, wsl)
  const remoteNames = remoteNamesRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (remoteNames.length === 0) {
    throw new Error('No git remotes found for this repository')
  }

  const prioritized = remoteNames.includes('origin')
    ? ['origin', ...remoteNames.filter((r) => r !== 'origin')]
    : remoteNames

  const seenUrls: string[] = []
  for (const remoteName of prioritized) {
    let remoteUrl = ''
    try {
      remoteUrl = (await git(repoPath, ['remote', 'get-url', remoteName], ssh, wsl)).trim()
    } catch {
      continue
    }

    if (!remoteUrl) continue
    seenUrls.push(`${remoteName}=${remoteUrl}`)

    const parsed = parseGitHubRemote(remoteUrl)
    if (parsed) {
      return { remoteName, ...parsed }
    }
  }

  throw new Error(`No GitHub remote found. Checked: ${seenUrls.join(', ')}`)
}

function parseJson<T>(value: string, errMsg: string): T {
  try {
    return JSON.parse(value) as T
  } catch {
    throw new Error(errMsg)
  }
}

export async function listOpenGitHubPullRequests(
  repoPath: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<GitHubPullRequest[]> {
  const ctx = await resolveRepoContext(repoPath, ssh, wsl)
  const repo = `${ctx.owner}/${ctx.repo}`
  const output = await runGh(repoPath, [
    'pr', 'list',
    '--repo', repo,
    '--state', 'open',
    '--limit', '50',
    '--json', 'number,title,state,headRefName,baseRefName,author,url,createdAt',
  ], ssh, wsl)

  const raw = parseJson<unknown>(output, 'Failed to parse pull request list from gh CLI')
  if (!Array.isArray(raw)) return []

  return raw
    .map((pr) => mapPr(pr as GhPullRequest))
    .filter((pr) => pr.id > 0)
}

async function listGitHubPullRequestsForBranch(
  repoPath: string,
  branch: string,
  state: 'open' | 'merged',
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<GitHubPullRequest[]> {
  const ctx = await resolveRepoContext(repoPath, ssh, wsl)
  const repo = `${ctx.owner}/${ctx.repo}`
  const output = await runGh(repoPath, [
    'pr', 'list',
    '--repo', repo,
    '--state', state,
    '--head', branch,
    '--limit', '10',
    '--json', 'number,title,state,headRefName,baseRefName,author,url,createdAt',
  ], ssh, wsl)

  const raw = parseJson<unknown>(output, 'Failed to parse pull request list from gh CLI')
  if (!Array.isArray(raw)) return []

  return raw
    .map((pr) => mapPr(pr as GhPullRequest))
    .filter((pr) => pr.id > 0 && pr.sourceBranch === branch)
}

export async function getGitHubPullRequestsWebUrl(
  repoPath: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<string> {
  const ctx = await resolveRepoContext(repoPath, ssh, wsl)
  return `https://github.com/${ctx.owner}/${ctx.repo}/pulls`
}

export async function getGitHubRepoWebUrl(
  repoPath: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<string> {
  const ctx = await resolveRepoContext(repoPath, ssh, wsl)
  return `https://github.com/${ctx.owner}/${ctx.repo}`
}

export async function getCurrentBranchGitHubPullRequest(
  repoPath: string,
  branch: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<GitHubPullRequest | null> {
  const openPrs = await listGitHubPullRequestsForBranch(repoPath, branch, 'open', ssh, wsl)
  const openPr = openPrs[0]
  if (openPr) return openPr

  const mergedPrs = await listGitHubPullRequestsForBranch(repoPath, branch, 'merged', ssh, wsl)
  return mergedPrs[0] ?? null
}

export async function createGitHubPullRequest(
  repoPath: string,
  payload: { target: string; title: string; description?: string },
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<GitHubPullRequest> {
  const ctx = await resolveRepoContext(repoPath, ssh, wsl)
  const repo = `${ctx.owner}/${ctx.repo}`
  const source = (await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], ssh, wsl)).trim()
  if (!source || source === 'HEAD') {
    throw new Error('Cannot create pull request from detached HEAD')
  }

  const body = payload.description?.trim() || ''

  // Pass the body via a temp file for local runs. On Windows, runLocal executes gh through
  // cmd.exe (shell:true) with a joined command string, and a multi-line --body value gets
  // truncated at the first newline. `--body-file` sidesteps all shell quoting. SSH/WSL run
  // through bash single-quotes (newline-safe), so they keep the inline --body.
  const useBodyFile = !!body && !ssh && !wsl
  let bodyFile: string | null = null
  if (useBodyFile) {
    bodyFile = path.join(tmpdir(), `polycode-pr-body-${process.pid}-${randomUUID()}.md`)
    await fsPromises.writeFile(bodyFile, body, 'utf8')
  }

  const createArgs = [
    'pr', 'create',
    '--repo', repo,
    '--head', source,
    '--base', payload.target,
    '--title', payload.title,
    ...(bodyFile ? ['--body-file', bodyFile] : ['--body', body]),
  ]

  let createOutput: string
  try {
    createOutput = await runGh(repoPath, createArgs, ssh, wsl)
  } finally {
    if (bodyFile) await fsPromises.unlink(bodyFile).catch(() => undefined)
  }

  const prUrlMatch = createOutput.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/i)
  const prNumber = prUrlMatch ? parseInt(prUrlMatch[1] ?? '0', 10) : 0
  if (!prNumber) {
    throw new Error(`Unable to parse created pull request from gh output: ${createOutput}`)
  }

  const viewOutput = await runGh(repoPath, [
    'pr', 'view',
    String(prNumber),
    '--repo', repo,
    '--json', 'number,title,state,headRefName,baseRefName,author,url,createdAt',
  ], ssh, wsl)

  const raw = parseJson<GhPullRequest>(viewOutput, 'Failed to parse created pull request details from gh CLI')
  const pr = mapPr(raw)
  if (!pr.id) {
    throw new Error('GitHub did not return a valid pull request')
  }

  return pr
}

export async function checkoutGitHubPullRequestBranch(
  repoPath: string,
  prId: number,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<{ branch: string }> {
  if (!Number.isFinite(prId) || prId <= 0) {
    throw new Error('Invalid pull request id')
  }

  const ctx = await resolveRepoContext(repoPath, ssh, wsl)
  await runGh(repoPath, ['pr', 'checkout', String(prId), '--repo', `${ctx.owner}/${ctx.repo}`], ssh, wsl)
  const branch = (await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], ssh, wsl)).trim()

  return { branch }
}
