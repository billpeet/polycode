import type { PullRequest } from '../types/ipc'

const METADATA_TTL_MS = 30 * 60_000
const BASE_BACKOFF_MS = 30_000
const MAX_BACKOFF_MS = 15 * 60_000

export type ForgeRefreshResult = {
  provider: 'azure' | 'github' | null
  defaultBranch: string
  pageUrl: string | null
  openPrs: PullRequest[]
  current: PullRequest | null
}

type Metadata = Pick<ForgeRefreshResult, 'provider' | 'defaultBranch' | 'pageUrl'> & { expiresAt: number }
type Failure = { attempts: number; retryAt: number; deterministic: boolean; message: string }

const metadataByPath = new Map<string, Metadata>()
const failureByPath = new Map<string, Failure>()
const inFlightByPath = new Map<string, Promise<ForgeRefreshResult>>()
const resultByPath = new Map<string, ForgeRefreshResult & { branch: string }>()

function keyFor(repoPath: string): string {
  const normalized = repoPath.replace(/\\/g, '/').replace(/\/+$/, '')
  return navigator.platform.startsWith('Win') ? normalized.toLowerCase() : normalized
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isDeterministicForgeError(error: unknown): boolean {
  return /unknown json field|invalid json field|reviewthreads|gh cli not found|not authenticated|authentication required|gh auth login|http 401|http 403|could not determine git hosting provider|no github remote|no git remotes|azure devops.*(login|authentication)|not a git repository/i.test(errorMessage(error))
}

export function getForgeRetryState(repoPath: string): Failure | null {
  return failureByPath.get(keyFor(repoPath)) ?? null
}

/** Return project-scoped PR data synchronously so remounts can paint before refreshing. */
export function getCachedForge(repoPath: string, branch: string): ForgeRefreshResult | null {
  const cached = resultByPath.get(keyFor(repoPath))
  if (!cached) return null
  return { ...cached, current: cached.branch === branch ? cached.current : null }
}

async function getMetadata(repoPath: string, force: boolean): Promise<Metadata> {
  const key = keyFor(repoPath)
  const cached = metadataByPath.get(key)
  if (!force && cached && cached.expiresAt > Date.now()) return cached

  const [provider, defaultBranch] = await Promise.all([
    window.api.invoke('git:hostingProvider', repoPath),
    window.api.invoke('git:defaultBranch', repoPath),
  ])
  const pageUrl = provider ? await window.api.invoke('forge:pr:webUrl', repoPath) : null
  const metadata = { provider, defaultBranch, pageUrl, expiresAt: Date.now() + METADATA_TTL_MS }
  metadataByPath.set(key, metadata)
  return metadata
}

/** Refresh PR data. Automatic calls honor backoff; a manual call forces an immediate retry. */
export function refreshForge(
  repoPath: string,
  branch: string,
  options?: { force?: boolean; onList?: (result: ForgeRefreshResult) => void },
): Promise<ForgeRefreshResult> {
  const key = keyFor(repoPath)
  const requestKey = `${key}::${branch}`
  const force = options?.force ?? false
  const failure = failureByPath.get(key)
  if (!force && failure && (failure.deterministic || failure.retryAt > Date.now())) {
    return Promise.reject(new Error(failure.message))
  }
  const existing = inFlightByPath.get(requestKey)
  if (existing) return existing

  const request = (async () => {
    try {
      const metadata = await getMetadata(repoPath, force)
      if (!metadata.provider) {
        failureByPath.delete(key)
        const result = { ...metadata, openPrs: [], current: null }
        resultByPath.set(key, { ...result, branch })
        options?.onList?.(result)
        return result
      }
      const openPrs = await window.api.invoke('forge:pr:list', repoPath)
      const previous = resultByPath.get(key)
      const listed = {
        ...metadata,
        openPrs,
        current: previous?.branch === branch ? previous.current : null,
      }
      resultByPath.set(key, { ...listed, branch })
      options?.onList?.(listed)

      // Merge/check/comment state and the current-branch lookup are deliberately
      // second-phase work: neither can delay rendering the newly fetched list.
      const enrichment = window.api.invoke('forge:pr:enrich', repoPath, openPrs).catch(() => openPrs)
      const hasOpenCurrent = openPrs.some((pr) => pr.sourceBranch === branch)
      const currentRequest = hasOpenCurrent
        ? enrichment.then((prs) => prs.find((pr) => pr.sourceBranch === branch) ?? listed.current)
        : window.api.invoke('forge:pr:current', repoPath, branch).catch(() => listed.current)
      const [enrichedPrs, current] = await Promise.all([enrichment, currentRequest])
      failureByPath.delete(key)
      const result = { ...metadata, openPrs: enrichedPrs, current }
      resultByPath.set(key, { ...result, branch })
      return result
    } catch (error) {
      const previousAttempts = failureByPath.get(key)?.attempts ?? 0
      const attempts = previousAttempts + 1
      const deterministic = isDeterministicForgeError(error)
      const retryDelay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempts - 1))
      failureByPath.set(key, {
        attempts,
        deterministic,
        retryAt: deterministic ? Number.POSITIVE_INFINITY : Date.now() + retryDelay,
        message: errorMessage(error),
      })
      throw error
    }
  })()
  inFlightByPath.set(requestKey, request)
  void request.finally(() => {
    if (inFlightByPath.get(requestKey) === request) inFlightByPath.delete(requestKey)
  }).catch(() => undefined)
  return request
}
