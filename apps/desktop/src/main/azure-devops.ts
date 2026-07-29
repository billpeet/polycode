import { existsSync } from 'fs'
import * as path from 'path'
import { PullRequest, SshConfig, WslConfig } from '../shared/types'
import { createRunner } from './driver/runner'
import { runGit } from './git-runner'
import {
  buildAzurePullRequestsUrl as buildPullRequestsWebUrl,
  buildAzureRepoUrl as buildRepoWebUrl,
  mapAzurePr as mapPr,
  normalizeAzureBranchName as normalizeBranchName,
  parseAzureRemote,
} from './forge-parsers'

import type { AzureRepoContext, AzurePrInput as AzDevOpsPr } from './forge-parsers'

interface LocalCommand {
  cmd: string
  args: string[]
}

async function runLocal(cmd: string, args: string[], cwd: string) {
  const command = await resolveLocalCommand(cmd, args)
  return createRunner({}).run({ binary: command.cmd, args: command.args, workDir: cwd })
}

async function resolveLocalCommand(cmd: string, args: string[]): Promise<LocalCommand> {
  if (process.platform !== 'win32') return { cmd, args }

  if (cmd !== 'azdevops') return { cmd, args }

  const direct = await resolveWindowsAzDevOpsNodeCommand(args)
  if (direct) return direct

  return { cmd, args }
}

async function resolveWindowsAzDevOpsNodeCommand(args: string[]): Promise<LocalCommand | null> {
  try {
    const result = await createRunner({}).run({
      binary: 'where.exe',
      args: ['azdevops.cmd'],
      workDir: process.cwd(),
    })
    if (result.exitCode !== 0) return null
    const cmdPath = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    if (!cmdPath) return null

    const baseDir = path.dirname(cmdPath)
    const scriptPath = path.join(baseDir, 'node_modules', '@billpeet', 'azdevops-cli', 'bin', 'azdevops.js')
    if (!existsSync(scriptPath)) return null

    const adjacentNode = path.join(baseDir, 'node.exe')
    return {
      cmd: existsSync(adjacentNode) ? adjacentNode : 'node',
      args: [scriptPath, ...args],
    }
  } catch {
    return null
  }
}

async function git(repoPath: string, args: string[], ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<string> {
  return runGit(createRunner({ ssh: ssh ?? undefined, wsl: wsl ?? undefined }), repoPath, args)
}

async function runAzDevOps(repoPath: string, args: string[], ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<string> {
  const result = ssh || wsl
    ? await createRunner({ ssh: ssh ?? undefined, wsl: wsl ?? undefined }).run({
      binary: 'azdevops',
      args,
      workDir: repoPath,
    })
    : await runLocal('azdevops', args, repoPath)
  if (result.exitCode !== 0) {
    if (/ENOENT|EINVAL|not found|is not recognized/i.test(result.stderr)) {
      throw new Error('azdevops CLI not found. Install and configure it first: azdevops setup --org <org> --token <pat> --project <project>')
    }
    if (/project/i.test(result.stderr) && /required|missing|default/i.test(result.stderr)) {
      throw new Error(`${result.stderr}\nSet a default Azure project: azdevops setup --org <org> --token <pat> --project <project>`)
    }
    throw new Error(result.stderr || 'Failed to execute azdevops CLI')
  }
  return result.stdout.trim()
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
): Promise<PullRequest[]> {
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

async function listPullRequestsByStatus(
  repoPath: string,
  status: 'active' | 'completed',
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<PullRequest[]> {
  const ctx = await resolveRepoContext(repoPath, ssh, wsl)
  const args = [
    'pr', 'list',
    '--repo', ctx.repo,
    '--status', status,
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

export async function getPullRequestsWebUrl(
  repoPath: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<string> {
  const ctx = await resolveRepoContext(repoPath, ssh, wsl)
  return buildPullRequestsWebUrl(ctx.remoteUrl)
}

export async function getRepoWebUrl(
  repoPath: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<string> {
  const ctx = await resolveRepoContext(repoPath, ssh, wsl)
  return buildRepoWebUrl(ctx.remoteUrl)
}

export async function getCurrentBranchPullRequest(
  repoPath: string,
  branch: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<PullRequest | null> {
  const openPrs = await listPullRequestsByStatus(repoPath, 'active', ssh, wsl)
  const openPr = openPrs.find((pr) => pr.sourceBranch === branch)
  if (openPr) return openPr

  const completedPrs = await listPullRequestsByStatus(repoPath, 'completed', ssh, wsl)
  return completedPrs.find((pr) => pr.sourceBranch === branch) ?? null
}

export async function createPullRequest(
  repoPath: string,
  payload: { target: string; title: string; description?: string },
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<PullRequest> {
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
    args.push('--description', payload.description.trim().replace(/\r\n/g, '\n'))
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
