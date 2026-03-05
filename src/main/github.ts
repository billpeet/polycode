import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { GitHubPullRequest, SshConfig, WslConfig } from '../shared/types'
import { sshExec } from './ssh'
import { wslExec } from './wsl'

const execFileAsync = promisify(execFile)

interface GitHubRepoContext {
  remoteName: string
  owner: string
  repo: string
}

interface GhAuthor {
  login?: string
  name?: string
}

interface GhPullRequest {
  number?: number
  title?: string
  state?: string
  headRefName?: string
  baseRefName?: string
  author?: GhAuthor
  url?: string
  createdAt?: string
}

interface SpawnResult {
  stdout: string
  stderr: string
  code: number | null
}

function mapPr(pr: GhPullRequest): GitHubPullRequest {
  const statusRaw = pr.state ?? 'UNKNOWN'
  return {
    id: pr.number ?? 0,
    title: pr.title ?? '(untitled)',
    status: statusRaw.toLowerCase(),
    sourceBranch: pr.headRefName ?? '',
    targetBranch: pr.baseRefName ?? '',
    authorName: pr.author?.name ?? pr.author?.login ?? 'Unknown',
    url: pr.url ?? '',
    creationDate: pr.createdAt ?? '',
  }
}

function parseGitHubRemote(remoteUrl: string): Omit<GitHubRepoContext, 'remoteName'> | null {
  const normalized = remoteUrl.replace(/\.git$/i, '')

  const https = normalized.match(/^https:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/?#]+)(?:[/?#].*)?$/i)
  if (https) {
    return {
      owner: decodeURIComponent(https[1] ?? ''),
      repo: decodeURIComponent(https[2] ?? ''),
    }
  }

  const ssh = normalized.match(/^git@github\.com:([^/]+)\/([^/?#]+)(?:[/?#].*)?$/i)
  if (ssh) {
    return {
      owner: decodeURIComponent(ssh[1] ?? ''),
      repo: decodeURIComponent(ssh[2] ?? ''),
    }
  }

  const sshUrl = normalized.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/?#]+)(?:[/?#].*)?$/i)
  if (sshUrl) {
    return {
      owner: decodeURIComponent(sshUrl[1] ?? ''),
      repo: decodeURIComponent(sshUrl[2] ?? ''),
    }
  }

  return null
}

async function runLocal(cmd: string, args: string[], cwd: string): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })

    proc.on('close', (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code }))
    proc.on('error', (err) => resolve({ stdout: '', stderr: err.message, code: null }))
  })
}

async function git(repoPath: string, args: string[], ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<string> {
  const gitCmd = `git ${args.map(a => "'" + a.replace(/'/g, "'\\''") + "'").join(' ')}`
  if (ssh) return sshExec(ssh, repoPath, gitCmd)
  if (wsl) return wslExec(wsl, repoPath, gitCmd)
  const { stdout } = await execFileAsync('git', args, { cwd: repoPath, maxBuffer: 4 * 1024 * 1024 })
  return stdout.trimEnd()
}

async function runGh(repoPath: string, args: string[], ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<string> {
  const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')

  if (ssh) return (await sshExec(ssh, repoPath, `gh ${quoted}`)).trim()
  if (wsl) return (await wslExec(wsl, repoPath, `gh ${quoted}`)).trim()

  const result = await runLocal('gh', args, repoPath)
  if (result.code !== 0) {
    if (/ENOENT|EINVAL|not found|is not recognized/i.test(result.stderr)) {
      throw new Error('gh CLI not found. Install and authenticate it first (gh auth login).')
    }
    throw new Error(result.stderr || 'Failed to execute gh CLI')
  }
  return result.stdout
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

export async function getCurrentBranchGitHubPullRequest(
  repoPath: string,
  branch: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<GitHubPullRequest | null> {
  const prs = await listOpenGitHubPullRequests(repoPath, ssh, wsl)
  return prs.find((pr) => pr.sourceBranch === branch) ?? null
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

  const createArgs = [
    'pr', 'create',
    '--repo', repo,
    '--head', source,
    '--base', payload.target,
    '--title', payload.title,
    '--body', payload.description?.trim() || '',
  ]

  const createOutput = await runGh(repoPath, createArgs, ssh, wsl)
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
