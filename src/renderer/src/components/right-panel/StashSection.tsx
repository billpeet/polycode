import { useCallback, useEffect, useRef, useState } from 'react'
import { useGitStore } from '../../stores/git'
import { useToastStore } from '../../stores/toast'
import { useGitErrorReporter } from '../../lib/gitErrorToast'
import { StashEntry } from '../../types/ipc'

/** Format an ISO timestamp as a short relative-age label (e.g. "2h ago"). */
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
  return `${d}d ago`
}

const EMPTY: StashEntry[] = []

export function StashSection({ projectPath }: { projectPath: string }) {
  const stashes = useGitStore((s) => s.stashesByPath[projectPath] ?? EMPTY)
  const isBusy = useGitStore((s) => s.stashBusyByPath[projectPath] ?? false)
  const isLoading = useGitStore((s) => s.stashLoadingByPath[projectPath] ?? false)
  const fetchStashes = useGitStore((s) => s.fetchStashes)
  const createStashAction = useGitStore((s) => s.createStash)
  const applyStashAction = useGitStore((s) => s.applyStash)
  const popStashAction = useGitStore((s) => s.popStash)
  const dropStashAction = useGitStore((s) => s.dropStash)
  const addToast = useToastStore((s) => s.add)
  const reportGitError = useGitErrorReporter(projectPath)

  const [collapsed, setCollapsed] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newMessage, setNewMessage] = useState('')
  const [includeUntracked, setIncludeUntracked] = useState(true)
  const createPopoverRef = useRef<HTMLDivElement | null>(null)

  // Fetch the stash list the first time the section expands, so an empty repo pays no cost.
  useEffect(() => {
    if (!collapsed && projectPath) void fetchStashes(projectPath)
  }, [collapsed, projectPath, fetchStashes])

  // Close the "Stash" popover on outside-click / Escape.
  useEffect(() => {
    if (!showCreate) return
    function onMouseDown(e: MouseEvent) {
      if (!createPopoverRef.current) return
      if (e.target instanceof Node && createPopoverRef.current.contains(e.target)) return
      setShowCreate(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setShowCreate(false)
    }
    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [showCreate])

  const handleCreate = useCallback(async () => {
    if (!projectPath) return
    try {
      await createStashAction(projectPath, { message: newMessage, includeUntracked })
      addToast({ type: 'success', message: 'Stashed local changes', duration: 3000 })
      setNewMessage('')
      setShowCreate(false)
      if (collapsed) setCollapsed(false)
    } catch (err) {
      reportGitError(err, 'Failed to stash')
    }
  }, [projectPath, newMessage, includeUntracked, createStashAction, addToast, collapsed, reportGitError])

  const handleApply = useCallback(async (entry: StashEntry) => {
    if (!projectPath) return
    try {
      await applyStashAction(projectPath, entry.ref)
      addToast({ type: 'success', message: `Applied ${entry.ref}`, duration: 3000 })
    } catch (err) {
      reportGitError(err, 'Failed to apply stash')
    }
  }, [projectPath, applyStashAction, addToast, reportGitError])

  const handlePop = useCallback(async (entry: StashEntry) => {
    if (!projectPath) return
    try {
      await popStashAction(projectPath, entry.ref)
      addToast({ type: 'success', message: `Popped ${entry.ref}`, duration: 3000 })
    } catch (err) {
      reportGitError(err, 'Failed to pop stash')
    }
  }, [projectPath, popStashAction, addToast, reportGitError])

  const handleDrop = useCallback(async (entry: StashEntry) => {
    if (!projectPath) return
    const label = entry.message ? `"${entry.message}"` : entry.ref
    if (!window.confirm(`Drop stash ${label}?\n\nThis permanently removes the stash entry and cannot be undone.`)) return
    try {
      await dropStashAction(projectPath, entry.ref)
      addToast({ type: 'success', message: `Dropped ${entry.ref}`, duration: 3000 })
    } catch (err) {
      reportGitError(err, 'Failed to drop stash')
    }
  }, [projectPath, dropStashAction, addToast, reportGitError])

  return (
    <div className="py-1" style={{ borderBottom: '1px solid var(--color-border)' }}>
      <div className="flex w-full items-center gap-1 px-3 py-1.5 hover:bg-white/5 transition-colors group" style={{ color: 'var(--color-text-muted)' }}>
        <button onClick={() => setCollapsed((c) => !c)} className="flex items-center gap-1 flex-1 text-left">
          <svg width="7" height="7" viewBox="0 0 8 8" fill="currentColor" style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0 }}>
            <path d="M0 2l4 4 4-4z" />
          </svg>
          <span className="text-[10px] font-semibold uppercase tracking-wider">Stashes</span>
          {stashes.length > 0 && <span className="ml-1 text-[10px] rounded-full px-1.5" style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-muted)' }}>{stashes.length}</span>}
        </button>
        <div className="relative">
          <button
            onClick={(e) => { e.stopPropagation(); setShowCreate((v) => !v) }}
            className="rounded p-0.5 hover:bg-white/10 transition-colors disabled:opacity-40"
            title="Stash local changes"
            disabled={isBusy}
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z" /></svg>
          </button>
          {showCreate && (
            <div
              ref={createPopoverRef}
              className="absolute right-0 top-full mt-1 z-50 rounded p-2 shadow-lg"
              style={{ minWidth: 240, background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
            >
              <input
                type="text"
                autoFocus
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate() }}
                placeholder="Optional stash message"
                className="w-full rounded px-2 py-1.5 text-xs outline-none"
                style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
              />
              <label className="mt-2 flex items-center gap-1.5 text-[11px] cursor-pointer" style={{ color: 'var(--color-text)' }}>
                <input
                  type="checkbox"
                  checked={includeUntracked}
                  onChange={(e) => setIncludeUntracked(e.target.checked)}
                  style={{ accentColor: 'var(--color-claude)' }}
                />
                Include untracked files
              </label>
              <div className="mt-2 flex gap-1.5">
                <button
                  onClick={() => void handleCreate()}
                  disabled={isBusy}
                  className="flex-1 rounded py-1.5 text-xs font-medium transition-opacity disabled:opacity-40"
                  style={{ background: 'var(--color-claude)', color: '#fff' }}
                >
                  {isBusy ? 'Stashing…' : 'Stash'}
                </button>
                <button
                  onClick={() => { setShowCreate(false); setNewMessage('') }}
                  disabled={isBusy}
                  className="flex-1 rounded py-1.5 text-xs font-medium transition-opacity disabled:opacity-40"
                  style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      {!collapsed && (
        isLoading && stashes.length === 0 ? (
          <p className="px-4 py-2 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>Loading stashes…</p>
        ) : stashes.length === 0 ? (
          <p className="px-4 py-2 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>No stashes.</p>
        ) : (
          <ul>
            {stashes.map((entry) => {
              const age = shortRelativeTime(entry.createdAt)
              const tooltip = `${entry.ref}${entry.branch ? ` (${entry.branch})` : ''}\n${entry.message}\n${new Date(entry.createdAt).toLocaleString()}`
              return (
                <li
                  key={entry.ref}
                  className="flex items-center gap-2 px-4 py-1 hover:bg-white/5 transition-colors group"
                  title={tooltip}
                >
                  <span className="text-[10px] font-mono flex-shrink-0" style={{ color: 'var(--color-text-muted)', width: 30 }}>
                    {`@{${entry.index}}`}
                  </span>
                  <span className="text-xs truncate min-w-0 flex-1" style={{ color: entry.autoGenerated ? 'var(--color-text-muted)' : 'var(--color-text)' }}>
                    {entry.message || '(no message)'}
                  </span>
                  {age && <span className="text-[10px] flex-shrink-0 group-hover:hidden" style={{ color: 'var(--color-text-muted)' }}>{age}</span>}
                  <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1 transition-opacity">
                    <button
                      onClick={() => void handleApply(entry)}
                      disabled={isBusy}
                      className="rounded px-1.5 py-0.5 text-[10px] hover:bg-white/10 disabled:opacity-40"
                      title="Apply (keep stash)"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      Apply
                    </button>
                    <button
                      onClick={() => void handlePop(entry)}
                      disabled={isBusy}
                      className="rounded px-1.5 py-0.5 text-[10px] hover:bg-white/10 disabled:opacity-40"
                      title="Pop (apply and drop)"
                      style={{ color: 'var(--color-claude)' }}
                    >
                      Pop
                    </button>
                    <button
                      onClick={() => void handleDrop(entry)}
                      disabled={isBusy}
                      className="rounded px-1.5 py-0.5 text-[10px] hover:bg-white/10 disabled:opacity-40"
                      title="Drop (delete stash)"
                      style={{ color: '#f87171' }}
                    >
                      Drop
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )
      )}
    </div>
  )
}
