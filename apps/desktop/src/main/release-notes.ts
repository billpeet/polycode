import { app } from 'electron'
import type { CommitLogEntry, UpdateReleaseNotes } from '@polycode/shared'
import { getUpdateState } from './updater'

/**
 * Release notes for a pending update: the commits between the running version's
 * tag and the pending version's tag, fetched from the forge the updater publishes
 * to (GitHub Releases — see the `publish` block in apps/desktop/package.json).
 *
 * The renderer asks for this when the user is about to install an update, so the
 * commit list can be reviewed before the restart. A failed fetch never blocks
 * installation: the notes degrade to an empty commit list plus a release-page URL.
 */

// Mirrors electron-builder's publish config; kept as constants because the
// packaged app cannot reach package.json's `build` section at runtime.
const GITHUB_OWNER = 'billpeet'
const GITHUB_REPO = 'polycode'
const FETCH_TIMEOUT_MS = 10_000

/** electron-builder tags each release `v<version>` by default. */
const tagFor = (version: string): string => `v${version}`

interface Cache {
  version: string
  notes: UpdateReleaseNotes
}

let cache: Cache | null = null

interface GithubCompareCommit {
  sha: string
  parents?: Array<{ sha: string }>
  commit?: {
    message?: string
    author?: { name?: string | null; email?: string | null; date?: string } | null
  }
}

interface GithubCompareResponse {
  commits?: GithubCompareCommit[]
}

function toCommitLogEntry(c: GithubCompareCommit): CommitLogEntry {
  return {
    sha: c.sha,
    shortSha: c.sha.slice(0, 7),
    subject: (c.commit?.message ?? '').split('\n', 1)[0] ?? '',
    authorName: c.commit?.author?.name ?? 'Unknown',
    authorEmail: c.commit?.author?.email ?? '',
    authorDate: c.commit?.author?.date ?? '',
    parents: (c.parents ?? []).map((p) => p.sha),
  }
}

/** Commits reachable from `toTag` but not `fromTag`, oldest first. */
async function fetchCommits(fromTag: string, toTag: string): Promise<CommitLogEntry[]> {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/compare/${fromTag}...${toTag}`
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`GitHub compare API returned ${response.status} for ${fromTag}...${toTag}`)
  }
  const body = (await response.json()) as GithubCompareResponse
  // The compare endpoint's ordering is undocumented; sort so the changelog always
  // reads chronologically regardless of what the API returns.
  return (body.commits ?? [])
    .map(toCommitLogEntry)
    .sort((a, b) => a.authorDate.localeCompare(b.authorDate))
}

/**
 * Notes for the pending update, or `null` when no update version is known.
 * Cached per pending version so reopening the dialog does not refetch.
 */
export async function getUpdateReleaseNotes(): Promise<UpdateReleaseNotes | null> {
  const version = getUpdateState().version
  if (!version) return null
  if (cache?.version === version) return cache.notes

  const notes: UpdateReleaseNotes = {
    version,
    commits: [],
    releaseUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/${tagFor(version)}`,
  }
  try {
    notes.commits = await fetchCommits(tagFor(app.getVersion()), tagFor(version))
  } catch (err) {
    console.warn('[release-notes] commit fetch failed:', err instanceof Error ? err.message : err)
  }
  cache = { version, notes }
  return notes
}
