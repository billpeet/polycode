import { useCallback, useEffect, useMemo, useState } from 'react'
import { useFilesStore } from '../../stores/files'
import { useToastStore } from '../../stores/toast'
import { CommitLogEntry, GitFileChange } from '../../types/ipc'
import { useGitErrorReporter } from '../../lib/gitErrorToast'

/** Format an ISO timestamp as a short relative-age label (e.g. "2h ago"). Matches StashSection's style. */
function shortRelativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}

/** Colour-coded status badge, mirroring the palette used by FileGroup. */
function statusColour(status: GitFileChange['status']): string {
  switch (status) {
    case 'A': return '#4ade80'   // green — added
    case 'M': return '#60a5fa'   // blue — modified
    case 'D': return '#f87171'   // red — deleted
    case 'R': return '#c084fc'   // purple — renamed
    case 'U': return '#fbbf24'   // amber — unmerged
    case '?': return 'var(--color-text-muted)'
    default:  return 'var(--color-text-muted)'
  }
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

interface CommitLogSectionProps {
  projectPath: string
  /** Git revision range passed to `git log` — e.g. `HEAD` or `origin/main..HEAD`. */
  range: string
  /** Section heading ("Commit Log", "Commits vs Base", etc). */
  label: string
  /** Cap on commits fetched in one pass. */
  limit?: number
  /** Starts collapsed by default; pass false to start open. */
  defaultCollapsed?: boolean
  /** Caller signal used to re-fetch when range semantics change (e.g. base ref switched, or after a commit). */
  refreshKey?: string | number
  /** Render a subtle top border. Useful when the section is stacked below another block. */
  topBorder?: boolean
}

/**
 * Collapsible commit history section. On first expand it fetches the commit list for `range`.
 * Each commit can be individually expanded to reveal its file list; clicking a file opens the diff
 * for that file at that commit in the shared diff viewer.
 */
export function CommitLogSection({
  projectPath,
  range,
  label,
  limit = 50,
  defaultCollapsed = true,
  refreshKey,
  topBorder = false,
}: CommitLogSectionProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const [commits, setCommits] = useState<CommitLogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [expandedSha, setExpandedSha] = useState<string | null>(null)
  // Cache files per SHA so collapsing + re-expanding a commit is instant.
  const [filesBySha, setFilesBySha] = useState<Record<string, GitFileChange[]>>({})
  const [loadingFilesForSha, setLoadingFilesForSha] = useState<string | null>(null)

  const selectCommitDiff = useFilesStore((s) => s.selectCommitDiff)
  const currentDiffKey = useFilesStore((s) => {
    const d = s.diffView
    return d && d.commitSha ? `${d.commitSha}::${d.filePath}` : null
  })
  const addToast = useToastStore((s) => s.add)
  const reportGitError = useGitErrorReporter(projectPath)

  const fetchCommits = useCallback(async () => {
    if (!projectPath) return
    setLoading(true)
    try {
      const list = await window.api.invoke('git:log', projectPath, { range, limit }) as CommitLogEntry[]
      setCommits(list)
      setLoaded(true)
    } catch (err) {
      reportGitError(err, `Failed to load commit log (${range})`)
    } finally {
      setLoading(false)
    }
  }, [projectPath, range, limit, reportGitError])

  // Initial fetch on first expand, plus re-fetch when the section is already open and refreshKey changes.
  useEffect(() => {
    if (collapsed) return
    void fetchCommits()
    // Collapse any open commit so stale file lists don't leak across refreshes.
    setExpandedSha(null)
  }, [collapsed, refreshKey, fetchCommits])

  const toggleCommit = useCallback(async (sha: string) => {
    // Collapse if already open.
    if (expandedSha === sha) {
      setExpandedSha(null)
      return
    }
    setExpandedSha(sha)
    if (filesBySha[sha]) return
    setLoadingFilesForSha(sha)
    try {
      const files = await window.api.invoke('git:commitFiles', projectPath, sha) as GitFileChange[]
      setFilesBySha((prev) => ({ ...prev, [sha]: files }))
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to load commit files', duration: 4000 })
      // Collapse on failure so the user can retry.
      setExpandedSha((curr) => (curr === sha ? null : curr))
    } finally {
      setLoadingFilesForSha((curr) => (curr === sha ? null : curr))
    }
  }, [projectPath, expandedSha, filesBySha, addToast])

  const handleFileClick = useCallback((commit: CommitLogEntry, file: GitFileChange) => {
    // Deleted files don't exist at the commit anymore, but `git show` still produces a deletion diff — that's fine.
    void selectCommitDiff(projectPath, commit.sha, commit.shortSha, file.path)
  }, [projectPath, selectCommitDiff])

  const countBadge = useMemo(() => {
    if (!loaded) return null
    return commits.length >= limit ? `${commits.length}+` : String(commits.length)
  }, [loaded, commits.length, limit])

  return (
    <div className="py-1" style={topBorder ? { borderTop: '1px solid var(--color-border)' } : undefined}>
      <div className="flex w-full items-center gap-1 px-3 py-1.5 hover:bg-white/5 transition-colors group" style={{ color: 'var(--color-text-muted)' }}>
        <button onClick={() => setCollapsed((c) => !c)} className="flex items-center gap-1 flex-1 text-left">
          <svg width="7" height="7" viewBox="0 0 8 8" fill="currentColor" style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0 }}>
            <path d="M0 2l4 4 4-4z" />
          </svg>
          <span className="text-[10px] font-semibold uppercase tracking-wider">{label}</span>
          {countBadge && (
            <span className="ml-1 text-[10px] rounded-full px-1.5" style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-muted)' }}>{countBadge}</span>
          )}
        </button>
        {!collapsed && (
          <button
            onClick={(e) => { e.stopPropagation(); void fetchCommits() }}
            className="rounded p-0.5 hover:bg-white/10 transition-colors disabled:opacity-40"
            title="Refresh commit log"
            disabled={loading}
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className={loading ? 'animate-spin' : ''}>
              <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.418A6 6 0 1 1 8 2v1z" />
            </svg>
          </button>
        )}
      </div>
      {!collapsed && (
        loading && commits.length === 0 ? (
          <p className="px-4 py-2 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>Loading commits…</p>
        ) : commits.length === 0 ? (
          <p className="px-4 py-2 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
            {range === 'HEAD' ? 'No commits.' : `No commits in ${range}.`}
          </p>
        ) : (
          <ul>
            {commits.map((commit) => {
              const isExpanded = expandedSha === commit.sha
              const files = filesBySha[commit.sha]
              const loadingFiles = loadingFilesForSha === commit.sha
              const isMerge = commit.parents.length > 1
              const age = shortRelativeTime(commit.authorDate)
              return (
                <li key={commit.sha} style={{ borderTop: '1px solid transparent' }}>
                  <button
                    onClick={() => void toggleCommit(commit.sha)}
                    className="w-full flex items-center gap-2 px-4 py-1 hover:bg-white/5 transition-colors text-left"
                    title={`${commit.shortSha}${isMerge ? ' (merge)' : ''}\n${commit.authorName} <${commit.authorEmail}>\n${new Date(commit.authorDate).toLocaleString()}\n\n${commit.subject}`}
                  >
                    <svg width="7" height="7" viewBox="0 0 8 8" fill="currentColor" style={{ transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s', flexShrink: 0, color: 'var(--color-text-muted)' }}>
                      <path d="M0 2l4 4 4-4z" />
                    </svg>
                    <span className="text-[10px] font-mono flex-shrink-0" style={{ color: isMerge ? 'var(--color-claude)' : 'var(--color-text-muted)', width: 54 }}>
                      {commit.shortSha}
                    </span>
                    <span className="text-xs truncate min-w-0 flex-1" style={{ color: 'var(--color-text)' }}>
                      {commit.subject || '(no subject)'}
                    </span>
                    {age && <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>{age}</span>}
                  </button>
                  {isExpanded && (
                    <div className="px-2 pb-1" style={{ background: 'rgba(255,255,255,0.02)' }}>
                      <div className="px-2 py-0.5 text-[10px] truncate" style={{ color: 'var(--color-text-muted)' }} title={commit.authorName}>
                        {commit.authorName}{isMerge ? ' · merge' : ''}
                      </div>
                      {loadingFiles && !files ? (
                        <p className="px-2 py-1 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>Loading files…</p>
                      ) : !files || files.length === 0 ? (
                        <p className="px-2 py-1 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>No files changed.</p>
                      ) : (
                        <ul>
                          {files.map((file) => {
                            const fileKey = `${commit.sha}::${file.path}`
                            const isCurrent = currentDiffKey === fileKey
                            return (
                              <li key={file.path + (file.oldPath ?? '')}>
                                <button
                                  onClick={() => handleFileClick(commit, file)}
                                  className="w-full flex items-center gap-2 px-2 py-0.5 hover:bg-white/5 transition-colors text-left rounded"
                                  style={{ background: isCurrent ? 'rgba(232, 123, 95, 0.08)' : undefined }}
                                  title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                                >
                                  <span className="text-[9px] font-mono flex-shrink-0 w-3" style={{ color: statusColour(file.status) }}>
                                    {file.status}
                                  </span>
                                  <span className="text-[11px] truncate" style={{ color: 'var(--color-text)' }}>
                                    {basename(file.path)}
                                  </span>
                                  <span className="text-[10px] truncate min-w-0 flex-1" style={{ color: 'var(--color-text-muted)' }}>
                                    {file.path}
                                  </span>
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )
      )}
    </div>
  )
}
