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
export function refreshForge(repoPath: string, branch: string, options?: { force?: boolean }): Promise<ForgeRefreshResult> {
  const key = keyFor(repoPath)
  const force = options?.force ?? false
  const failure = failureByPath.get(key)
  if (!force && failure && (failure.deterministic || failure.retryAt > Date.now())) {
    return Promise.reject(new Error(failure.message))
  }
  const existing = inFlightByPath.get(key)
  if (existing) return existing

  const request = (async () => {
    try {
      const metadata = await getMetadata(repoPath, force)
      if (!metadata.provider) {
        failureByPath.delete(key)
        return { ...metadata, openPrs: [], current: null }
      }
      const [openPrs, current] = await Promise.all([
        window.api.invoke('forge:pr:list', repoPath),
        window.api.invoke('forge:pr:current', repoPath, branch),
      ])
      failureByPath.delete(key)
      return { ...metadata, openPrs, current }
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
  inFlightByPath.set(key, request)
  void request.finally(() => {
    if (inFlightByPath.get(key) === request) inFlightByPath.delete(key)
  }).catch(() => undefined)
  return request
}
