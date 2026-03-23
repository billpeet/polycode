import { spawn, execFile } from 'child_process'
import { promisify } from 'util'
import { AzureDevOpsPullRequest, SshConfig, WslConfig } from '../shared/types'
import { augmentWindowsPath, winQuote } from './driver/runner'
import { sshExec } from './ssh'
import { wslExec } from './wsl'

const execFileAsync = promisify(execFile)

interface AzureRepoContext {
  remoteName: string
  project: string | null
  repo: string
  remoteUrl: string
}

interface AzDevOpsPr {
  pullRequestId?: number
  title?: string
  status?: string
  sourceRefName?: string
  targetRefName?: string
  createdBy?: { displayName?: string }
  url?: string
  creationDate?: string
}

interface SpawnResult {
  stdout: string
  stderr: string
  code: number | null
}

function shortRef(ref: string | undefined): string {
  if (!ref) return ''
  return ref.replace(/^refs\/heads\//, '')
}

function normalizeBranchName(branch: string, remoteName: string): string {
  const trimmed = branch.trim()
  if (!trimmed) return ''

  return trimmed
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\//, '')
    .replace(/^remotes\//, '')
    .replace(new RegExp(`^${remoteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`), '')
}

function toHeadRef(branch: string, remoteName: string): string {
  const normalized = normalizeBranchName(branch, remoteName)
  if (!normalized) {
    throw new Error('Branch name is empty')
  }
  return `refs/heads/${normalized}`
}

function buildWebUrl(remoteUrl: string, prId: number): string {
  const normalized = remoteUrl.replace(/\.git$/i, '').replace(/\/+$/, '')

  // SSH: git@ssh.dev.azure.com:v3/org/project/repo
  const sshMatch = normalized.match(/^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)$/i)
  if (sshMatch) return `https://dev.azure.com/${sshMatch[1]}/${sshMatch[2]}/_git/${sshMatch[3]}/pullrequest/${prId}`

  // SSH: ssh://git@ssh.dev.azure.com/v3/org/project/repo
  const sshUrlMatch = normalized.match(/^ssh:\/\/git@ssh\.dev\.azure\.com\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/i)
  if (sshUrlMatch) return `https://dev.azure.com/${sshUrlMatch[1]}/${sshUrlMatch[2]}/_git/${sshUrlMatch[3]}/pullrequest/${prId}`

  // SSH: git@vs-ssh.visualstudio.com:v3/org/project/repo
  const vsSshMatch = normalized.match(/^git@vs-ssh\.visualstudio\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)$/i)
  if (vsSshMatch) return `https://${vsSshMatch[1]}.visualstudio.com/${vsSshMatch[2]}/_git/${vsSshMatch[3]}/pullrequest/${prId}`

  // HTTPS: just append /pullrequest/<id> to the repo URL
  return `${normalized}/pullrequest/${prId}`
}

function mapPr(pr: AzDevOpsPr, remoteUrl?: string): AzureDevOpsPullRequest {
  const id = pr.pullRequestId ?? 0
  const url = remoteUrl && id ? buildWebUrl(remoteUrl, id) : (pr.url ?? '')
  return {
    id,
    title: pr.title ?? '(untitled)',
    status: pr.status ?? 'unknown',
    sourceBranch: shortRef(pr.sourceRefName),
    targetBranch: shortRef(pr.targetRefName),
    authorName: pr.createdBy?.displayName ?? 'Unknown',
    url,
    creationDate: pr.creationDate ?? '',
  }
}

function parseAzureRemote(remoteUrl: string): AzureRepoContext | null {
  const normalized = remoteUrl.replace(/\.git$/i, '')

  // https://dev.azure.com/org/project/_git/repo
  // https://org@dev.azure.com/org/project/_git/repo
  const httpsMatch = normalized.match(/^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)(?:[/?#].*)?$/i)
  if (httpsMatch) {
    return {
      remoteName: 'origin',
      project: decodeURIComponent(httpsMatch[2] ?? ''),
      repo: decodeURIComponent(httpsMatch[3] ?? ''),
    }
  }

  // https://dev.azure.com/org/_git/repo (project implied by azdevops default config)
  const httpsNoProjectMatch = normalized.match(/^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/_git\/([^/?#]+)(?:[/?#].*)?$/i)
  if (httpsNoProjectMatch) {
    return {
      remoteName: 'origin',
      project: null,
      repo: decodeURIComponent(httpsNoProjectMatch[2] ?? ''),
    }
  }

  // https://org.visualstudio.com/project/_git/repo
  // https://org.visualstudio.com/DefaultCollection/project/_git/repo
  const visualStudioMatch = normalized.match(/^https:\/\/([^.]+)\.visualstudio\.com\/(?:(?:DefaultCollection)\/)?([^/]+)\/_git\/([^/?#]+)(?:[/?#].*)?$/i)
  if (visualStudioMatch) {
    return {
      remoteName: 'origin',
      project: decodeURIComponent(visualStudioMatch[2] ?? ''),
      repo: decodeURIComponent(visualStudioMatch[3] ?? ''),
    }
  }

  // https://org.visualstudio.com/_git/repo (project implied by azdevops default config)
  const visualStudioNoProjectMatch = normalized.match(/^https:\/\/([^.]+)\.visualstudio\.com\/_git\/([^/?#]+)(?:[/?#].*)?$/i)
  if (visualStudioNoProjectMatch) {
    return {
      remoteName: 'origin',
      project: null,
      repo: decodeURIComponent(visualStudioNoProjectMatch[2] ?? ''),
    }
  }

  // git@ssh.dev.azure.com:v3/org/project/repo
  const sshMatch = normalized.match(/^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/?#]+)(?:[/?#].*)?$/i)
  if (sshMatch) {
    return {
      remoteName: 'origin',
      project: decodeURIComponent(sshMatch[2] ?? ''),
      repo: decodeURIComponent(sshMatch[3] ?? ''),
    }
  }

  // ssh://git@ssh.dev.azure.com/v3/org/project/repo
  const sshUrlMatch = normalized.match(/^ssh:\/\/git@ssh\.dev\.azure\.com\/v3\/([^/]+)\/([^/]+)\/([^/?#]+)(?:[/?#].*)?$/i)
  if (sshUrlMatch) {
    return {
      remoteName: 'origin',
      project: decodeURIComponent(sshUrlMatch[2] ?? ''),
      repo: decodeURIComponent(sshUrlMatch[3] ?? ''),
    }
  }

  // git@vs-ssh.visualstudio.com:v3/org/project/repo
  const vsSshMatch = normalized.match(/^git@vs-ssh\.visualstudio\.com:v3\/([^/]+)\/([^/]+)\/([^/?#]+)(?:[/?#].*)?$/i)
  if (vsSshMatch) {
    return {
      remoteName: 'origin',
      project: decodeURIComponent(vsSshMatch[2] ?? ''),
      repo: decodeURIComponent(vsSshMatch[3] ?? ''),
    }
  }

  // ssh://git@vs-ssh.visualstudio.com:22/DefaultCollection/project/_ssh/repo
  const vsOldSshMatch = normalized.match(/^ssh:\/\/git@vs-ssh\.visualstudio\.com(?::\d+)?\/DefaultCollection\/([^/]+)\/_ssh\/([^/?#]+)(?:[/?#].*)?$/i)
  if (vsOldSshMatch) {
    return {
      remoteName: 'origin',
      project: decodeURIComponent(vsOldSshMatch[1] ?? ''),
      repo: decodeURIComponent(vsOldSshMatch[2] ?? ''),
    }
  }

  return null
}

async function runLocal(cmd: string, args: string[], cwd: string): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32'
    const proc = isWindows
      ? spawn([cmd, ...args.map(winQuote)].join(' '), [], {
        cwd,
        // On Windows, global CLIs are often .cmd shims and need shell resolution.
        shell: true,
        env: augmentWindowsPath(),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      : spawn(cmd, args, {
        cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })

    proc.on('close', (code) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code })
    })

    proc.on('error', (err) => {
      resolve({ stdout: '', stderr: err.message, code: null })
    })
  })
}

async function git(repoPath: string, args: string[], ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<string> {
  const gitCmd = `git ${args.map(a => "'" + a.replace(/'/g, "'\\''") + "'").join(' ')}`
  if (ssh) return sshExec(ssh, repoPath, gitCmd)
  if (wsl) return wslExec(wsl, repoPath, gitCmd)
  const { stdout } = await execFileAsync('git', args, { cwd: repoPath, maxBuffer: 4 * 1024 * 1024 })
  return stdout.trimEnd()
}

async function runAzDevOps(repoPath: string, args: string[], ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<string> {
  const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')

  if (ssh) {
    const output = await sshExec(ssh, repoPath, `azdevops ${quoted}`)
    return output.trim()
  }

  if (wsl) {
    const output = await wslExec(wsl, repoPath, `azdevops ${quoted}`)
    return output.trim()
  }

  const cmd = 'azdevops'
  const result = await runLocal(cmd, args, repoPath)
  if (result.code !== 0) {
    if (/ENOENT|EINVAL|not found|is not recognized/i.test(result.stderr)) {
      throw new Error('azdevops CLI not found. Install and configure it first: azdevops setup --org <org> --token <pat> --project <project>')
    }
    if (/project/i.test(result.stderr) && /required|missing|default/i.test(result.stderr)) {
      throw new Error(`${result.stderr}\nSet a default Azure project: azdevops setup --org <org> --token <pat> --project <project>`)
    }
    throw new Error(result.stderr || 'Failed to execute azdevops CLI')
  }
  return result.stdout
}

async function resolveRepoContext(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<AzureRepoContext> {
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
    const context = parseAzureRemote(remoteUrl)
    if (context) {
      context.remoteName = remoteName
      context.remoteUrl = remoteUrl
      return context
    }
  }

  throw new Error(`No Azure DevOps remote found. Checked: ${seenUrls.join(', ')}`)
}

export async function listOpenPullRequests(
  repoPath: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<AzureDevOpsPullRequest[]> {
  const ctx = await resolveRepoContext(repoPath, ssh, wsl)
  const args = [
    'pr', 'list',
    '--repo', ctx.repo,
    '--status', 'active',
    '--top', '50',
    '--format', 'json',
  ]
  if (ctx.project) {
    args.splice(4, 0, '--project', ctx.project)
  }
  const output = await runAzDevOps(repoPath, args, ssh, wsl)

  let raw: unknown
  try {
    raw = JSON.parse(output)
  } catch {
    throw new Error('Failed to parse pull request list from azdevops CLI')
  }

  if (!Array.isArray(raw)) return []

  return raw
    .map((pr) => mapPr(pr as AzDevOpsPr, ctx.remoteUrl))
    .filter((pr) => pr.id > 0)
}

export async function getCurrentBranchPullRequest(
  repoPath: string,
  branch: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<AzureDevOpsPullRequest | null> {
  const prs = await listOpenPullRequests(repoPath, ssh, wsl)
  return prs.find((pr) => pr.sourceBranch === branch) ?? null
}

export async function createPullRequest(
  repoPath: string,
  payload: { target: string; title: string; description?: string },
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<AzureDevOpsPullRequest> {
  const ctx = await resolveRepoContext(repoPath, ssh, wsl)
  const sourceBranch = (await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], ssh, wsl)).trim()
  if (!sourceBranch || sourceBranch === 'HEAD') {
    throw new Error('Cannot create pull request from detached HEAD')
  }
  const source = normalizeBranchName(sourceBranch, ctx.remoteName)
  const target = normalizeBranchName(payload.target, ctx.remoteName)

  if (!source) throw new Error('Could not determine source branch name')
  if (!target) throw new Error('Could not determine target branch name')

  const args: string[] = [
    'pr', 'create',
    '--repo', ctx.repo,
    '--source', source,
    '--target', target,
    '--title', payload.title,
    '--format', 'json',
  ]
  if (ctx.project) {
    args.splice(4, 0, '--project', ctx.project)
  }

  if (payload.description?.trim()) {
    args.push('--description', payload.description.trim())
  }

  const output = await runAzDevOps(repoPath, args, ssh, wsl)

  let raw: unknown
  try {
    raw = JSON.parse(output)
  } catch {
    throw new Error('Failed to parse create PR response from azdevops CLI')
  }

  const pr = mapPr(raw as AzDevOpsPr, ctx.remoteUrl)
  if (!pr.id) {
    throw new Error('Azure DevOps did not return a valid pull request')
  }
  return pr
}

export async function checkoutPullRequestBranch(
  repoPath: string,
  prId: number,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<{ branch: string }> {
  if (!Number.isFinite(prId) || prId <= 0) {
    throw new Error('Invalid pull request id')
  }

  const ctx = await resolveRepoContext(repoPath, ssh, wsl)
  const localPrBranch = `pr/${prId}`

  const getPrFromCli = async (subcommand: 'view' | 'show'): Promise<AzDevOpsPr | null> => {
    const args = [
      'pr', subcommand,
      '--repo', ctx.repo,
      '--id', String(prId),
      '--format', 'json',
    ]
    if (ctx.project) {
      args.splice(4, 0, '--project', ctx.project)
    }
    try {
      const output = await runAzDevOps(repoPath, args, ssh, wsl)
      const parsed = JSON.parse(output) as AzDevOpsPr
      return parsed
    } catch {
      return null
    }
  }

  let sourceRefName = ''
  const directPr = (await getPrFromCli('view')) ?? (await getPrFromCli('show'))
  if (typeof directPr?.sourceRefName === 'string') {
    sourceRefName = directPr.sourceRefName.trim()
  }

  // Some azdevops CLI versions don't support `pr view/show`.
  // Fall back to list and locate the requested PR id.
  if (!sourceRefName) {
    try {
      const listArgs = [
        'pr', 'list',
        '--repo', ctx.repo,
        '--status', 'active',
        '--top', '200',
        '--format', 'json',
      ]
      if (ctx.project) {
        listArgs.splice(4, 0, '--project', ctx.project)
      }
      const listOutput = await runAzDevOps(repoPath, listArgs, ssh, wsl)
      const prs = JSON.parse(listOutput)
      if (Array.isArray(prs)) {
        const matched = prs.find((pr) => Number((pr as AzDevOpsPr).pullRequestId) === prId) as AzDevOpsPr | undefined
        if (typeof matched?.sourceRefName === 'string') {
          sourceRefName = matched.sourceRefName.trim()
        }
      }
    } catch {
      // Fall through to direct ref fetch attempts.
    }
  }

  const fetchRefs = [
    sourceRefName,
    `refs/pull/${prId}/head`,
    `refs/pull/${prId}/merge`,
    `pull/${prId}/head`,
  ].filter(Boolean)

  const failures: string[] = []
  for (const ref of fetchRefs) {
    try {
      const sourceBranchName = sourceRefName ? normalizeBranchName(sourceRefName, ctx.remoteName) : ''
      const checkoutBranch = ref === sourceRefName && sourceBranchName ? sourceBranchName : localPrBranch
      await git(repoPath, ['fetch', ctx.remoteName, ref], ssh, wsl)
      await git(repoPath, ['checkout', '-B', checkoutBranch, 'FETCH_HEAD'], ssh, wsl)
      // Set up remote tracking so the branch stays linked to origin
      if (ref === sourceRefName && sourceBranchName) {
        try {
          await git(repoPath, ['branch', `--set-upstream-to=${ctx.remoteName}/${sourceBranchName}`, checkoutBranch], ssh, wsl)
        } catch {
          // Non-fatal: tracking setup may fail if remote ref isn't cached locally
        }
      }
      return { branch: checkoutBranch }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failures.push(`${ref}: ${message}`)
    }
  }

  throw new Error(
    `Failed to checkout PR ${prId}. Tried refs: ${fetchRefs.join(', ')}\n${failures.join('\n')}`,
  )

}
