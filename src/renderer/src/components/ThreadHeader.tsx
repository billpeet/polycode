import { useState, useRef, useEffect, KeyboardEvent } from 'react'
import { useRateLimitStore, RateLimitEntry } from '../stores/rateLimits'
import { useThreadStore } from '../stores/threads'
import { useProjectStore } from '../stores/projects'
import { useLocationStore } from '../stores/locations'
import { useGitStore } from '../stores/git'
import { useToastStore } from '../stores/toast'
import { useTerminalStore } from '../stores/terminal'
import { MODEL_CONTEXT_LIMITS, DEFAULT_CONTEXT_LIMIT, RepoLocation } from '../types/ipc'
import { usePlanStore } from '../stores/plans'
import ImportHistoryDialog from './ImportHistoryDialog'
import ThreadLogsModal from './ThreadLogsModal'

const EMPTY_LOCATIONS: RepoLocation[] = []
const EMPTY_RATE_LIMITS: Record<string, RateLimitEntry> = {}

// ─── Rate limit helpers ───────────────────────────────────────────────────────

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return 'soon'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function formatRateLimitType(type: string): string {
  const known: Record<string, string> = {
    default: 'rate limit',
    '5_hour': '5h window',
    '7_day': '7d window',
    requests_per_minute: 'req/min',
    requests_per_second: 'req/s',
    tokens_per_day: 'tokens/day',
    tokens_per_minute: 'tokens/min',
  }
  return known[type] ?? type.replace(/_/g, ' ')
}

function RateLimitBanner({ limit, nowSeconds }: { limit: RateLimitEntry; nowSeconds: number }) {
  const isBlocked = limit.status === 'blocked'
  const color = isBlocked ? '#f87171' : '#facc15'
  const bgColor = isBlocked ? 'rgba(239, 68, 68, 0.08)' : 'rgba(250, 204, 21, 0.08)'
  const borderColor = isBlocked ? 'rgba(239, 68, 68, 0.25)' : 'rgba(250, 204, 21, 0.25)'
  const pct = limit.utilization != null ? Math.round(limit.utilization * 100) : null
  const remaining = limit.resetsAt ? limit.resetsAt - nowSeconds : null
  const typeLabel = formatRateLimitType(limit.rateLimitType)

  return (
    <div
      className="flex items-center gap-2 text-xs px-2.5 py-1 rounded"
      style={{ background: bgColor, border: `1px solid ${borderColor}`, color }}
    >
      <span style={{ flexShrink: 0 }}>{isBlocked ? '⊘' : '⚠'}</span>
      <span>
        {isBlocked
          ? `Claude Code rate limited (${typeLabel})`
          : `Claude Code rate limit${pct != null ? ` ${pct}%` : ''} used (${typeLabel})`}
        {remaining != null && remaining > 0 && ` — resets in ${formatCountdown(remaining)}`}
      </span>
    </div>
  )
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

interface Props {
  threadId: string
}

export default function ThreadHeader({ threadId }: Props) {
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const thread = useThreadStore((s) => {
    if (!selectedProjectId) return undefined
    const threads = s.byProject[selectedProjectId]
    return threads?.find((t) => t.id === threadId)
  })
  const status = useThreadStore((s) => s.statusMap[threadId] ?? 'idle')
  const pid = useThreadStore((s) => s.pidByThread[threadId] ?? null)
  const rename = useThreadStore((s) => s.rename)

  // Look up location for this thread
  const locationId = thread?.location_id ?? null
  const location = useLocationStore((s) => {
    if (!selectedProjectId || !locationId) return null
    const locations = s.byProject[selectedProjectId]
    return locations?.find((l) => l.id === locationId) ?? null
  })
  const locationPath = location?.path ?? null

  // Ensure locations are fetched for the current project
  const fetchLocations = useLocationStore((s) => s.fetch)
  useEffect(() => {
    if (selectedProjectId && locationId && !location) {
      fetchLocations(selectedProjectId)
    }
  }, [selectedProjectId, locationId, location, fetchLocations])


  const usage = useThreadStore((s) => s.usageByThread[threadId])
  const isTerminalOpen = useTerminalStore((s) => locationId ? (s.visibleByLocation[locationId] ?? false) : false)

  const fetchGit = useGitStore((s) => s.fetch)
  const refreshRemoteGit = useGitStore((s) => s.refreshRemote)
  const gitStatus = useGitStore((s) =>
    locationPath ? (s.statusByPath[locationPath] ?? null) : null
  )
  const pushGit = useGitStore((s) => s.push)
  const pullGit = useGitStore((s) => s.pull)
  const isPushing = useGitStore((s) => locationPath ? (s.pushingByPath[locationPath] ?? false) : false)
  const isPulling = useGitStore((s) => locationPath ? (s.pullingByPath[locationPath] ?? false) : false)
  const addToast = useToastStore((s) => s.add)

  const fetchThreads = useThreadStore((s) => s.fetch)

  const threadRateLimits = useRateLimitStore((s) => s.limitsByThread[threadId] ?? EMPTY_RATE_LIMITS)
  const activeRateLimits = Object.values(threadRateLimits).filter(
    (l) => l.provider === 'claude-code' && (l.status === 'blocked' || l.status === 'allowed_warning')
  )

  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000))

  // Tick every second while rate limits are active to update countdowns and clear expired entries
  useEffect(() => {
    if (activeRateLimits.length === 0) return
    const interval = setInterval(() => {
      useRateLimitStore.getState().clearExpired(threadId)
      const now = Math.floor(Date.now() / 1000)
      setNowSeconds((prev) => (prev === now ? prev : now))
    }, 1000)
    return () => clearInterval(interval)
  }, [activeRateLimits.length, threadId])

  const hasPlan = usePlanStore((s) => !!s.planByThread[threadId])
  const planVisible = usePlanStore((s) => s.visibleByThread[threadId] ?? false)

  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.select()
    }
  }, [editing])

  // Poll git status for the thread's location
  useEffect(() => {
    if (!locationPath) return
    fetchGit(locationPath)
    const lp = locationPath
    const interval = setInterval(() => fetchGit(lp), 10_000)
    return () => clearInterval(interval)
  }, [locationPath, fetchGit])

  // Periodically fetch from remotes so ahead/behind indicators stay current.
  useEffect(() => {
    if (!locationPath) return
    const lp = locationPath
    void refreshRemoteGit(lp)
    const interval = setInterval(() => { void refreshRemoteGit(lp) }, 60_000)
    return () => clearInterval(interval)
  }, [locationPath, refreshRemoteGit])

  const statusColor =
    status === 'running'
      ? '#4ade80'
      : status === 'stopping'
        ? '#fb923c'
        : status === 'error'
          ? '#f87171'
          : status === 'stopped'
            ? '#facc15'
            : 'var(--color-text-muted)'

  function startEditing(): void {
    setEditValue(thread?.name ?? '')
    setEditing(true)
  }

  async function commitRename(): Promise<void> {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== thread?.name) {
      await rename(threadId, trimmed)
    }
    setEditing(false)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename()
    } else if (e.key === 'Escape') {
      setEditing(false)
    }
  }

  return (
    <div
      className="flex flex-col flex-shrink-0 border-b"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
    >
    <div className="flex items-center justify-between px-4 py-3">
      <div className="flex items-center gap-3 min-w-0">
        {status === 'running' || status === 'stopping' ? (
          <span className="flex items-center gap-1 flex-shrink-0">
            <span
              className="h-2.5 w-2.5 status-spinner"
              style={status === 'stopping' ? { opacity: 0.5, filter: 'hue-rotate(30deg)' } : undefined}
            />
            {pid !== null && (
              <span
                className="text-xs"
                style={{ color: 'var(--color-text-muted)', fontFamily: 'monospace', fontSize: '0.6rem' }}
                title={`Process ID: ${pid}`}
              >
                {status === 'stopping' ? 'stopping…' : `pid:${pid}`}
              </span>
            )}
          </span>
        ) : (
          <span
            className="h-2.5 w-2.5 rounded-full flex-shrink-0"
            style={{ background: statusColor }}
          />
        )}
        {editing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={commitRename}
            className="text-sm font-medium bg-transparent border-b outline-none min-w-0"
            style={{
              color: 'var(--color-text)',
              borderColor: 'var(--color-claude)',
              width: `${Math.max(editValue.length, 8)}ch`
            }}
          />
        ) : (
          <button
            onClick={startEditing}
            className="text-sm font-medium truncate text-left hover:opacity-70 transition-opacity"
            style={{ color: 'var(--color-text)' }}
            title="Click to rename"
          >
            {thread?.name ?? 'New thread'}
          </button>
        )}

        {/* Location badge */}
        {location && (
          <span
            className="text-xs px-1.5 py-0.5 rounded flex-shrink-0"
            style={{
              background: location.connection_type === 'ssh' ? 'rgba(99, 179, 237, 0.1)'
                : location.connection_type === 'wsl' ? 'rgba(251, 191, 36, 0.1)'
                : 'rgba(74, 222, 128, 0.1)',
              color: location.connection_type === 'ssh' ? '#63b3ed'
                : location.connection_type === 'wsl' ? '#fbbf24'
                : '#4ade80',
              border: `1px solid ${location.connection_type === 'ssh' ? 'rgba(99, 179, 237, 0.3)'
                : location.connection_type === 'wsl' ? 'rgba(251, 191, 36, 0.3)'
                : 'rgba(74, 222, 128, 0.3)'}`,
              fontFamily: 'monospace',
            }}
            title={`Location: ${location.label} (${location.path})`}
          >
            {location.label}
          </span>
        )}

        {/* Location quick-actions */}
        {locationPath && (
          <span className="flex items-center gap-0.5 flex-shrink-0">
            <button
              onClick={() => window.api.invoke('shell:copyPath', locationPath)}
              className="rounded p-0.5 hover:opacity-70 transition-opacity"
              style={{ color: 'var(--color-text-muted)', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}
              title={`Copy path: ${locationPath}`}
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="5" y="5" width="9" height="9" rx="1" />
                <path d="M2 11V2h9" />
              </svg>
            </button>
            <button
              onClick={() => window.api.invoke('shell:openInExplorer', locationPath)}
              className="rounded p-0.5 hover:opacity-70 transition-opacity"
              style={{ color: 'var(--color-text-muted)', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}
              title="Open in Explorer"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.586a1 1 0 0 1 .707.293L8 4.5h4.5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7z" />
              </svg>
            </button>
            <button
              onClick={() => {
                const wslConfig =
                  location?.connection_type === 'wsl' ? (location.wsl ?? null) :
                  (location?.connection_type === 'local' && thread?.use_wsl && thread.wsl_distro)
                    ? { distro: thread.wsl_distro }
                    : null
                window.api.invoke('shell:openInTerminal', locationPath, wslConfig)
              }}
              className="rounded p-0.5 hover:opacity-70 transition-opacity"
              style={{ color: 'var(--color-text-muted)', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}
              title={
                (location?.connection_type === 'wsl' || (location?.connection_type === 'local' && thread?.use_wsl))
                  ? 'Open in WSL Terminal'
                  : 'Open in Terminal'
              }
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1" y="2" width="14" height="12" rx="1.5" />
                <path d="M4 6l3 3-3 3" />
                <path d="M9 12h3" />
              </svg>
            </button>
            <button
              onClick={() => {
                if (locationId) useTerminalStore.getState().toggleVisible(locationId)
              }}
              className="rounded p-0.5 hover:opacity-70 transition-opacity"
              style={{
                color: isTerminalOpen ? 'var(--color-claude)' : 'var(--color-text-muted)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                lineHeight: 1,
              }}
              title="Toggle integrated terminal (Ctrl+`)"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                <path d="M6.646 4.646a.5.5 0 0 1 .708 0l2.5 2.5a.5.5 0 0 1 0 .708l-2.5 2.5a.5.5 0 0 1-.708-.708L8.793 7.5 6.646 5.354a.5.5 0 0 1 0-.708z" />
                <path fillRule="evenodd" d="M1 4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V4zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H3z" />
                <path d="M10 10.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 0 1h-1a.5.5 0 0 1-.5-.5z" />
              </svg>
            </button>
          </span>
        )}

        {/* Token usage + context window */}
        {usage && (() => {
          const model = thread?.model ?? 'claude-opus-4-5'
          const contextLimit = MODEL_CONTEXT_LIMITS[model] ?? DEFAULT_CONTEXT_LIMIT
          const contextPct = Math.min(usage.context_window / contextLimit, 1)
          const barColor = contextPct < 0.5 ? '#4ade80' : contextPct < 0.8 ? '#facc15' : '#f87171'
          return (
            <span
              className="flex items-center gap-2 text-xs flex-shrink-0"
              style={{ color: 'var(--color-text-muted)', fontFamily: 'monospace' }}
            >
              <span
                title={`Input: ${usage.input_tokens.toLocaleString()} tokens | Output: ${usage.output_tokens.toLocaleString()} tokens`}
              >
                ↓{formatTokenCount(usage.input_tokens)} ↑{formatTokenCount(usage.output_tokens)}
              </span>
              {usage.context_window > 0 && (
                <span
                  className="flex items-center gap-1"
                  title={`Context: ${usage.context_window.toLocaleString()} / ${contextLimit.toLocaleString()} tokens (${Math.round(contextPct * 100)}%)`}
                >
                  <span
                    style={{
                      width: 60,
                      height: 4,
                      borderRadius: 2,
                      background: 'var(--color-border)',
                      overflow: 'hidden',
                      display: 'inline-block',
                    }}
                  >
                    <span
                      style={{
                        display: 'block',
                        width: `${Math.max(contextPct * 100, 1)}%`,
                        height: '100%',
                        borderRadius: 2,
                        background: barColor,
                        transition: 'width 0.3s, background 0.3s',
                      }}
                    />
                  </span>
                  <span style={{ fontSize: '0.6rem' }}>{Math.round(contextPct * 100)}%</span>
                </span>
              )}
            </span>
          )
        })()}

        {/* Git branch + diff stats */}
        {gitStatus && (
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Branch pill */}
            <span
              className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded"
              style={{
                background: 'var(--color-surface-2)',
                color: 'var(--color-text-muted)',
                border: '1px solid var(--color-border)',
                fontFamily: 'monospace',
              }}
              title={`Branch: ${gitStatus.branch}${gitStatus.ahead > 0 ? ` ↑${gitStatus.ahead}` : ''}${gitStatus.behind > 0 ? ` ↓${gitStatus.behind}` : ''}`}
            >
              {/* Branch icon */}
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                <path d="M11.75 2.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0zm.75 2.25a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5zM4.25 13.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0zM5 15.75a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5zM4.25 2.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0zM5 4.75a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5zM5.75 8.75v-4h-1.5v4a4.25 4.25 0 0 0 3 4.04v-1.55a2.75 2.75 0 0 1-1.5-2.49zm5.5-3.54A4.25 4.25 0 0 0 8 1.16v1.55a2.75 2.75 0 0 1 1.75 2.56v2.32A2.75 2.75 0 0 1 8 10.14v1.55a4.25 4.25 0 0 0 3.25-4.14V5.21z" />
              </svg>
              <span className="max-w-[100px] truncate">{gitStatus.branch}</span>
              {gitStatus.ahead > 0 && (
                <button
                  onClick={async (e) => {
                    e.stopPropagation()
                    if (!locationPath) return
                    try {
                      await pushGit(locationPath)
                      addToast({ type: 'success', message: 'Pushed successfully', duration: 3000 })
                    } catch (err) {
                      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Push failed', duration: 0 })
                    }
                  }}
                  disabled={isPushing}
                  className="hover:opacity-70 transition-opacity disabled:opacity-40"
                  style={{ color: '#4ade80', cursor: 'pointer', background: 'none', border: 'none', padding: 0, font: 'inherit', lineHeight: 1 }}
                  title={`Push (${gitStatus.ahead} ahead)`}
                >
                  {isPushing ? (
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="animate-spin" style={{ verticalAlign: 'middle' }}>
                      <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.418A6 6 0 1 1 8 2v1z"/>
                    </svg>
                  ) : (
                    <>↑{gitStatus.ahead}</>
                  )}
                </button>
              )}
              {gitStatus.behind > 0 && (
                <button
                  onClick={async (e) => {
                    e.stopPropagation()
                    if (!locationPath) return
                    try {
                      await pullGit(locationPath)
                      addToast({ type: 'success', message: 'Pulled successfully', duration: 3000 })
                    } catch (err) {
                      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Pull failed', duration: 0 })
                    }
                  }}
                  disabled={isPulling}
                  className="hover:opacity-70 transition-opacity disabled:opacity-40"
                  style={{ color: '#f87171', cursor: 'pointer', background: 'none', border: 'none', padding: 0, font: 'inherit', lineHeight: 1 }}
                  title={`Pull (${gitStatus.behind} behind)`}
                >
                  {isPulling ? (
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="animate-spin" style={{ verticalAlign: 'middle' }}>
                      <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.418A6 6 0 1 1 8 2v1z"/>
                    </svg>
                  ) : (
                    <>↓{gitStatus.behind}</>
                  )}
                </button>
              )}
            </span>

            {/* Additions / deletions */}
            {(gitStatus.additions > 0 || gitStatus.deletions > 0) && (
              <span className="flex items-center gap-1 text-xs" style={{ fontFamily: 'monospace' }}>
                {gitStatus.additions > 0 && (
                  <span style={{ color: '#4ade80' }}>+{gitStatus.additions}</span>
                )}
                {gitStatus.deletions > 0 && (
                  <span style={{ color: '#f87171' }}>-{gitStatus.deletions}</span>
                )}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {/* View Plan button */}
        {hasPlan && (
          <button
            onClick={() => usePlanStore.getState().toggleVisible(threadId)}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors"
            style={{
              color: planVisible ? 'var(--color-claude)' : 'var(--color-text-muted)',
              background: planVisible ? 'rgba(232, 123, 95, 0.1)' : 'transparent',
              border: `1px solid ${planVisible ? 'rgba(232, 123, 95, 0.3)' : 'var(--color-border)'}`,
            }}
            title="View plan file"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="1" width="10" height="14" rx="1" />
              <path d="M6 4h4M6 7h4M6 10h2" />
            </svg>
            View Plan
          </button>
        )}

        {/* Import from CLI history — only for new threads with a location */}
        {!thread?.has_messages && location && selectedProjectId && thread?.location_id && (
          <button
            onClick={() => setImportDialogOpen(true)}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors"
            style={{
              color: 'var(--color-text-muted)',
              background: 'transparent',
              border: '1px solid var(--color-border)',
            }}
            title="Import from Claude Code CLI history"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 2v10M4 8l4 4 4-4" />
              <path d="M2 14h12" />
            </svg>
            Import history
          </button>
        )}
        <button
          onClick={() => setLogsOpen(true)}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors"
          style={{
            color: 'var(--color-text-muted)',
            background: 'transparent',
            border: '1px solid var(--color-border)',
          }}
          title="View thread logs"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 4h12M2 8h8M2 12h5" />
          </svg>
          Logs
        </button>
      </div>

      {importDialogOpen && selectedProjectId && thread?.location_id && location?.path && (
        <ImportHistoryDialog
          projectId={selectedProjectId}
          locationId={thread.location_id}
          locationPath={location.path}
          onClose={() => setImportDialogOpen(false)}
          onImported={() => fetchThreads(selectedProjectId)}
        />
      )}
      {logsOpen && (
        <ThreadLogsModal threadId={threadId} onClose={() => setLogsOpen(false)} />
      )}
    </div>

      {activeRateLimits.length > 0 && (
        <div className="flex flex-col gap-1 px-4 pb-2">
          {activeRateLimits.map((limit) => (
            <RateLimitBanner key={limit.rateLimitType} limit={limit} nowSeconds={nowSeconds} />
          ))}
        </div>
      )}
    </div>
  )
}
