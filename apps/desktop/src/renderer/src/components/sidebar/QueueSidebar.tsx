import { type ReactNode, useEffect, useState } from 'react'
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, Inbox, PanelLeft, Plus, Settings } from 'lucide-react'
import { SidebarViewMode } from '../../stores/ui'
import { QueueThread, ThreadStatus } from '../../types/ipc'
import { bucketQueueThreads } from '../../lib/queueBuckets'
import { getThreadStatusColor, relativeTime, SidebarResizeHandle, ViewModeSwitch } from './shared'
import ProjectFavicon from '../ProjectFavicon'

interface QueueSidebarProps {
  queueThreads: QueueThread[]
  statusMap: Record<string, ThreadStatus | undefined>
  unreadByThread: Record<string, boolean | undefined>
  selectedThreadId: string | null
  sidebarWidth: number
  sidebarResizing: boolean
  onToggleSidebar: () => void
  onSetViewMode: (mode: SidebarViewMode) => void
  onOpenSettings: () => void
  onNewThread: () => void
  onSelectThread: (thread: QueueThread) => void
  onArchiveThread: (thread: QueueThread) => void | Promise<void>
  onUnarchiveThread: (thread: QueueThread) => void | Promise<void>
  dialogs: ReactNode
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div
      className="flex items-center justify-between px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider"
      style={{ color: 'var(--color-text-muted)' }}
    >
      <span>{label}</span>
      <span className="opacity-60">{count}</span>
    </div>
  )
}

function QueueRow({
  thread,
  statusMap,
  unreadByThread,
  isSelected,
  sortTimestamp,
  isArchived = false,
  onSelect,
  onArchive,
}: {
  thread: QueueThread
  statusMap: Record<string, ThreadStatus | undefined>
  unreadByThread: Record<string, boolean | undefined>
  isSelected: boolean
  sortTimestamp: string | null
  isArchived?: boolean
  onSelect: () => void
  onArchive: () => void
}) {
  const status = statusMap[thread.id] ?? thread.status
  const isRunning = status === 'running' || status === 'stopping'
  const isEscalated = thread.run_state === 'escalated'
  const locationHint = [
    thread.location_label,
    thread.git_branch ? `⎇ ${thread.git_branch}` : null,
  ].filter(Boolean).join(' · ')

  return (
    <div className="group/thread relative" style={{ opacity: isArchived ? 0.6 : 1 }}>
      <button
        onClick={onSelect}
        className="flex w-full min-w-0 flex-col gap-0.5 px-3 py-1.5 text-left text-xs transition-colors"
        style={{
          background: isSelected ? 'var(--color-border)' : 'transparent',
          color: 'var(--color-text-muted)',
        }}
      >
        <span className="flex w-full min-w-0 items-center">
          {isRunning ? (
            <span
              className="mr-2 h-1.5 w-1.5 flex-shrink-0 status-spinner"
              style={status === 'stopping' ? { opacity: 0.5, filter: 'hue-rotate(30deg)' } : undefined}
            />
          ) : (
            <span
              className={`mr-2 h-1.5 w-1.5 flex-shrink-0 rounded-full${(unreadByThread[thread.id] ?? !!thread.unread) ? ' status-unread' : ''}`}
              style={{ background: isEscalated ? '#f87171' : getThreadStatusColor(thread, statusMap, unreadByThread) }}
            />
          )}
          <span className="truncate min-w-0" style={{ color: 'var(--color-text)' }}>{thread.name}</span>
        </span>
        <span className="flex w-full min-w-0 items-center gap-1 pl-3.5 text-[10px]" style={{ opacity: 0.75 }}>
          <span
            className="flex flex-shrink-0 items-center gap-1 rounded px-1"
            style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
          >
            <ProjectFavicon projectId={thread.project_id} className="h-2.5 w-2.5" />
            {thread.project_name}
          </span>
          {locationHint && <span className="truncate min-w-0">{locationHint}</span>}
          {isEscalated && (
            <span className="flex-shrink-0 rounded px-1 font-semibold" style={{ background: 'rgba(248, 113, 113, 0.15)', color: '#f87171' }}>
              escalated
            </span>
          )}
        </span>
      </button>

      <div
        className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/thread:opacity-100"
        style={{ background: isSelected ? 'color-mix(in srgb, var(--color-border) 80%, transparent)' : 'color-mix(in srgb, var(--color-surface) 80%, transparent)' }}
      >
        <span className="px-1 text-[10px]" style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>
          {relativeTime(sortTimestamp ?? thread.updated_at)}
        </span>
        <button
          onClick={onArchive}
          className="rounded p-1 transition-colors hover:bg-white/10"
          style={{ color: 'var(--color-text-muted)' }}
          title={isArchived ? 'Unarchive thread' : 'Archive thread'}
        >
          {isArchived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
        </button>
      </div>
    </div>
  )
}

const ARCHIVED_PAGE_SIZE = 30

/**
 * Collapsed-by-default Archived section at the bottom of the Queue:
 * cross-project, searchable (server-side name filter), paged. Data is
 * fetched on expand and kept fresh when the live queue changes (archiving a
 * thread refreshes the queue, which re-triggers this fetch).
 */
function ArchivedSection({
  statusMap,
  unreadByThread,
  selectedThreadId,
  queueThreads,
  onSelectThread,
  onUnarchiveThread,
}: {
  statusMap: Record<string, ThreadStatus | undefined>
  unreadByThread: Record<string, boolean | undefined>
  selectedThreadId: string | null
  queueThreads: QueueThread[]
  onSelectThread: (thread: QueueThread) => void
  onUnarchiveThread: (thread: QueueThread) => void | Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [threads, setThreads] = useState<QueueThread[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)

  async function load(search: string, offset: number, append: boolean): Promise<void> {
    setLoading(true)
    try {
      const rows = await window.api.invoke(
        'threads:listQueueArchived',
        search.trim() || null,
        ARCHIVED_PAGE_SIZE,
        offset
      )
      setThreads((prev) => append ? [...prev, ...rows] : rows)
      setHasMore(rows.length === ARCHIVED_PAGE_SIZE)
    } catch (err) {
      console.error('Failed to fetch archived queue threads', err)
    } finally {
      setLoading(false)
    }
  }

  // Debounced (re)load on expand, search, or live-queue changes.
  useEffect(() => {
    if (!expanded) return
    const timeoutId = window.setTimeout(() => void load(query, 0, false), 200)
    return () => window.clearTimeout(timeoutId)
  }, [expanded, query, queueThreads])

  return (
    <div className="border-t" style={{ borderColor: 'var(--color-border)' }}>
      <button
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-1 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider transition-colors hover:bg-white/5"
        style={{ color: 'var(--color-text-muted)' }}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>Archived</span>
      </button>

      {expanded && (
        <>
          <div className="px-3 pb-1.5">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search archived…"
              className="w-full rounded px-2 py-1 text-xs outline-none"
              style={{
                background: 'var(--color-surface-2)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-text)',
              }}
            />
          </div>

          {threads.map((thread) => (
            <QueueRow
              key={thread.id}
              thread={thread}
              statusMap={statusMap}
              unreadByThread={unreadByThread}
              isSelected={selectedThreadId === thread.id}
              sortTimestamp={thread.last_turn_completed_at}
              isArchived
              onSelect={() => onSelectThread(thread)}
              onArchive={() => void onUnarchiveThread(thread)}
            />
          ))}

          {!loading && threads.length === 0 && (
            <p className="px-3 pb-3 pt-1 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {query.trim() ? `No archived threads match "${query.trim()}"` : 'No archived threads'}
            </p>
          )}

          {hasMore && (
            <button
              onClick={() => void load(query, threads.length, true)}
              disabled={loading}
              className="w-full px-3 py-1.5 text-center text-[10px] transition-colors hover:bg-white/5 disabled:opacity-50"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {loading ? 'Loading…' : 'Show more'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

/**
 * The Queue: cross-project threads ordered by need for attention. Threads
 * awaiting the user come first (most recent completed Turn at top), then
 * running threads; never-run threads sink to the bottom. Everything else
 * (routines, per-location actions) lives in the tree view; archived threads
 * sit in the collapsed Archived section below.
 */
export default function QueueSidebar({
  queueThreads,
  statusMap,
  unreadByThread,
  selectedThreadId,
  sidebarWidth,
  sidebarResizing,
  onToggleSidebar,
  onSetViewMode,
  onOpenSettings,
  onNewThread,
  onSelectThread,
  onArchiveThread,
  onUnarchiveThread,
  dialogs,
}: QueueSidebarProps) {
  const { attention, running, fresh } = bucketQueueThreads(queueThreads, statusMap)
  const isEmpty = attention.length === 0 && running.length === 0 && fresh.length === 0

  const [searchQuery, setSearchQuery] = useState('')
  const [archivedMatches, setArchivedMatches] = useState<QueueThread[]>([])
  const trimmedQuery = searchQuery.trim()

  // Search covers ALL threads: active matches filter client-side; archived
  // matches come from the server (debounced), since they aren't loaded.
  useEffect(() => {
    if (!trimmedQuery) {
      queueMicrotask(() => setArchivedMatches([]))
      return
    }
    const timeoutId = window.setTimeout(() => {
      window.api.invoke('threads:listQueueArchived', trimmedQuery, ARCHIVED_PAGE_SIZE, 0)
        .then(setArchivedMatches)
        .catch((err) => console.error('Failed to search archived queue threads', err))
    }, 200)
    return () => window.clearTimeout(timeoutId)
  }, [trimmedQuery, queueThreads])

  const activeMatches = trimmedQuery
    ? queueThreads.filter((t) => t.name.toLowerCase().includes(trimmedQuery.toLowerCase()))
    : []

  return (
    <aside
      className="sidebar-transition relative flex flex-shrink-0 flex-col overflow-hidden border-r"
      style={{
        width: `${sidebarWidth}px`,
        transition: sidebarResizing ? 'none' : undefined,
        background: 'var(--color-surface)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div
        className="flex flex-shrink-0 items-center justify-between border-b px-3 py-2"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="flex items-center gap-2">
          <button
            onClick={onToggleSidebar}
            className="flex items-center justify-center rounded p-1 opacity-60 transition-opacity hover:opacity-100"
            style={{ color: 'var(--color-text-muted)' }}
            title="Collapse sidebar"
          >
            <PanelLeft size={16} />
          </button>
          <span className="text-sm font-semibold" style={{ color: 'var(--color-claude)' }}>
            PolyCode
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={onOpenSettings}
            className="flex items-center justify-center rounded p-1.5 opacity-60 transition-opacity hover:opacity-100"
            title="Settings"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Settings size={14} />
          </button>
          <button
            onClick={onNewThread}
            className="flex items-center justify-center rounded p-1.5 opacity-60 transition-opacity hover:opacity-100"
            style={{ color: 'var(--color-text-muted)' }}
            title="New thread"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      <ViewModeSwitch mode="queue" onSetMode={onSetViewMode} />

      <div className="border-b px-3 py-1.5 flex-shrink-0" style={{ borderColor: 'var(--color-border)' }}>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search threads…"
          className="w-full rounded px-2 py-1 text-xs outline-none"
          style={{
            background: 'var(--color-surface-2)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text)',
          }}
        />
      </div>

      <div className="flex-1 overflow-y-auto pb-2">
        {trimmedQuery ? (
          <>
            {activeMatches.map((thread) => (
              <QueueRow
                key={thread.id}
                thread={thread}
                statusMap={statusMap}
                unreadByThread={unreadByThread}
                isSelected={selectedThreadId === thread.id}
                sortTimestamp={thread.last_turn_completed_at}
                onSelect={() => onSelectThread(thread)}
                onArchive={() => onArchiveThread(thread)}
              />
            ))}
            {archivedMatches.length > 0 && (
              <>
                <SectionHeader label="Archived" count={archivedMatches.length} />
                {archivedMatches.map((thread) => (
                  <QueueRow
                    key={thread.id}
                    thread={thread}
                    statusMap={statusMap}
                    unreadByThread={unreadByThread}
                    isSelected={selectedThreadId === thread.id}
                    sortTimestamp={thread.last_turn_completed_at}
                    isArchived
                    onSelect={() => onSelectThread(thread)}
                    onArchive={() => void onUnarchiveThread(thread)}
                  />
                ))}
              </>
            )}
            {activeMatches.length === 0 && archivedMatches.length === 0 && (
              <p className="px-4 py-6 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
                No threads match &quot;{trimmedQuery}&quot;
              </p>
            )}
          </>
        ) : isEmpty ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <Inbox size={20} style={{ color: 'var(--color-text-muted)', opacity: 0.5 }} />
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              Nothing needs your attention.
            </p>
          </div>
        ) : (
          <>
            {attention.length > 0 && (
              <>
                <SectionHeader label="Needs attention" count={attention.length} />
                {attention.map((thread) => (
                  <QueueRow
                    key={thread.id}
                    thread={thread}
                    statusMap={statusMap}
                    unreadByThread={unreadByThread}
                    isSelected={selectedThreadId === thread.id}
                    sortTimestamp={thread.last_turn_completed_at}
                    onSelect={() => onSelectThread(thread)}
                    onArchive={() => onArchiveThread(thread)}
                  />
                ))}
              </>
            )}
            {running.length > 0 && (
              <>
                <SectionHeader label="Running" count={running.length} />
                {running.map((thread) => (
                  <QueueRow
                    key={thread.id}
                    thread={thread}
                    statusMap={statusMap}
                    unreadByThread={unreadByThread}
                    isSelected={selectedThreadId === thread.id}
                    sortTimestamp={thread.last_turn_started_at}
                    onSelect={() => onSelectThread(thread)}
                    onArchive={() => onArchiveThread(thread)}
                  />
                ))}
              </>
            )}
            {fresh.length > 0 && (
              <>
                <SectionHeader label="New" count={fresh.length} />
                {fresh.map((thread) => (
                  <QueueRow
                    key={thread.id}
                    thread={thread}
                    statusMap={statusMap}
                    unreadByThread={unreadByThread}
                    isSelected={selectedThreadId === thread.id}
                    sortTimestamp={thread.created_at}
                    onSelect={() => onSelectThread(thread)}
                    onArchive={() => onArchiveThread(thread)}
                  />
                ))}
              </>
            )}
          </>
        )}

        {!trimmedQuery && (
          <ArchivedSection
            statusMap={statusMap}
            unreadByThread={unreadByThread}
            selectedThreadId={selectedThreadId}
            queueThreads={queueThreads}
            onSelectThread={onSelectThread}
            onUnarchiveThread={onUnarchiveThread}
          />
        )}
      </div>

      {dialogs}
      <SidebarResizeHandle />
    </aside>
  )
}
