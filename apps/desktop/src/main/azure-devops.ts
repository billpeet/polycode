import { resolveForgeRepoContext } from './forge-context'
import { PullRequest, SshConfig, WslConfig } from '../shared/types'
import { azureRequest } from './azure-devops-client'
import { createRunner } from './driver/runner'
import { runGit } from './git-runner'
import {
  buildAzurePullRequestsUrl as buildPullRequestsWebUrl,
  buildAzureRepoUrl as buildRepoWebUrl,
  mapAzurePr as mapPr,
  normalizeAzureBranchName as normalizeBranchName,
} from './forge-parsers'

import type { AzureRepoContext, AzurePrInput } from './forge-parsers'

async function git(repoPath: string, args: string[], ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<string> {
  return runGit(createRunner({ ssh: ssh ?? undefined, wsl: wsl ?? undefined }), repoPath, args)
}

async function enrichPullRequest(
  ctx: AzureRepoContext,
  pr: PullRequest,
): Promise<PullRequest> {
  try {
    const threads = await azureRequest<{ value: Array<{ status: number | string; isDeleted?: boolean }> }>(ctx, `pullrequests/${pr.id}/threads`)
    return { ...pr, unresolvedCommentCount: threads.value.filter((thread) => !thread.isDeleted && (thread.status === 1 || thread.status === 'active')).length }
  } catch {
    // Comment metadata is optional; keep the base PR usable during transient failures.
    return pr
  }
}

async function enrichPullRequests(
  ctx: AzureRepoContext,
  prs: PullRequest[],
): Promise<PullRequest[]> {
  const enriched: PullRequest[] = []
  for (let index = 0; index < prs.length; index += 5) {
    enriched.push(...await Promise.all(
      prs.slice(index, index + 5).map((pr) => enrichPullRequest(ctx, pr)),
    ))
  }
  return enriched
}

async function resolveRepoContext(repoPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<AzureRepoContext> {
  const context = await resolveForgeRepoContext(repoPath, ssh, wsl)
  if (context?.provider !== 'azure') throw new Error('No Azure DevOps remote found for this repository')
  return context
}

export async function listOpenPullRequests(
  repoPath: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<PullRequest[]> {
  return listPullRequestsByStatus(repoPath, 'active', ssh, wsl)
}

export async function enrichOpenPullRequests(
  repoPath: string,
  prs: PullRequest[],
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<PullRequest[]> {
  const ctx = await resolveRepoContext(repoPath, ssh, wsl)
  return enrichPullRequests(ctx, prs)
}

async function listPullRequestsByStatus(
  repoPath: string,
  status: 'active' | 'completed',
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
  branch?: string,
): Promise<PullRequest[]> {
  const ctx = await resolveRepoContext(repoPath, ssh, wsl)
  const raw = await azureRequest<{ value: AzurePrInput[] }>(ctx, 'pullrequests', {
    'searchCriteria.status': status, '$top': '50',
    ...(branch ? { 'searchCriteria.sourceRefName': `refs/heads/${branch}` } : {}),
  })
  return raw.value.map((pr) => mapPr(pr, ctx.remoteUrl)).filter((pr) => pr.id > 0)
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
  const openPrs = await listPullRequestsByStatus(repoPath, 'active', ssh, wsl, branch)
  const openPr = openPrs.find((pr) => pr.sourceBranch === branch)
  if (openPr) return (await enrichOpenPullRequests(repoPath, [openPr], ssh, wsl))[0] ?? openPr

  const completedPrs = await listPullRequestsByStatus(repoPath, 'completed', ssh, wsl, branch)
  const completedPr = completedPrs.find((pr) => pr.sourceBranch === branch)
  if (!completedPr) return null
  return (await enrichOpenPullRequests(repoPath, [completedPr], ssh, wsl))[0] ?? completedPr
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

  const raw = await azureRequest<AzurePrInput>(ctx, 'pullrequests', {}, {
    sourceRefName: `refs/heads/${source}`,
    targetRefName: `refs/heads/${target}`,
    title: payload.title,
    description: payload.description?.trim().replace(/\r\n/g, '\n') ?? '',
  })

  const pr = mapPr(raw, ctx.remoteUrl)
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

  const directPr = await azureRequest<AzurePrInput>(ctx, `pullrequests/${prId}`)
  const sourceRefName = directPr.sourceRefName?.trim() ?? ''

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
