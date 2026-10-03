import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  ArrowDownAZ,
  ChevronDown,
  ChevronRight,
  History,
  Layers,
  PanelLeft,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  X,
} from 'lucide-react'
import { LOCAL_SOURCE_ID, type UnifiedProject, type UnifiedProjectMember } from '@polycode/shared'
import { loadUnifiedCollapsed, sectionKey, sourceKey, useUnifiedStore, type UnifiedQueueThread } from '../../stores/unified'
import { useThreadStore } from '../../stores/threads'
import { useProjectStore } from '../../stores/projects'
import { useLocationStore } from '../../stores/locations'
import { useToastStore } from '../../stores/toast'
import type { Project, QueueThread, RepoLocation, Thread, ThreadStatus } from '../../types/ipc'
import { SourcePill, sourceColor } from '../SourceBadge'
import SourceProjectFavicon from '../SourceProjectFavicon'
import ProjectTreeBody from './ProjectTreeBody'
import QueueSidebar from './QueueSidebar'
import { getThreadStatusColor, SidebarResizeHandle, ViewModeSwitch } from './shared'
import { useUiStore } from '../../stores/ui'

/**
 * The single-source tree's actions, bound to whichever source is currently active.
 * The unified view calls these for active-source members, and for other members after
 * activating their source (for actions that need the workspace or a dialog).
 */
export interface ActiveSourceActions {
  archiveThread: (thread: Thread, projectId: string) => Promise<void>
  unarchiveThread: (thread: Thread, projectId: string) => Promise<void>
  snoozeThread: (thread: Thread, projectId: string, untilIso: string) => Promise<void>
  wakeThread: (thread: Thread, projectId: string) => Promise<void>
  archiveProject: (projectId: string) => Promise<void>
  unarchiveProject: (projectId: string) => Promise<void>
  checkoutLocation: (locationId: string, projectId: string) => Promise<void>
  returnLocationToPool: (locationId: string, projectId: string) => Promise<void>
  newThread: (projectId: string, locationId: string) => void
  newWorktreeThread: (projectId: string, parentLocationId: string) => void
  removeWorktree: (location: RepoLocation, projectId: string) => Promise<void>
  editProject: (project: Project) => void
  confirmDeleteProject: (project: Project) => void
  openLocationDialog: (projectId: string) => void
  openProjectDialog: () => void
  /** The header "+" in Queue mode: a new thread wherever the current one lives. */
  openNewThreadComposer: () => Promise<void>
}

const EMPTY_SET = new Set<string>()




/** Per-member data with live overrides applied, in the shapes ProjectTreeBody expects. */
interface MemberView {
  member: UnifiedProjectMember
  active: boolean
  threads: Thread[]
  statusMap: Record<string, ThreadStatus | undefined>
  unreadByThread: Record<string, boolean | undefined>
  branchByLocation: Record<string, string>
  pathExistsByLocation: Record<string, boolean>
}

/** Per-source reachability: the view is only as complete as this row says. */
function SourceChips() {
  const snapshot = useUnifiedStore((s) => s.snapshot)
  const loading = useUnifiedStore((s) => s.loading)
  const activeSourceId = useUnifiedStore((s) => s.activeSourceId)
  const disconnected = useUnifiedStore((s) => s.disconnected)
  const sources = snapshot?.sources ?? []
  return (
    <div className="flex flex-shrink-0 flex-wrap gap-1 border-b px-3 py-1.5" style={{ borderColor: 'var(--color-border)' }}>
      {sources.length === 0 && (
        <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
          {loading ? 'Gathering sources…' : 'No sources loaded'}
        </span>
      )}
      {sources.map((source) => {
        const ok = source.status === 'ok'
        const stale = ok && disconnected[source.sourceId]
        const threadCount = source.projects.reduce((n, p) => n + p.threads.length, 0)
        const isActive = source.sourceId === activeSourceId
        return (
          <span
            key={source.sourceId}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]"
            style={{
              background: 'var(--color-surface-2)',
              border: `1px solid ${isActive ? 'var(--color-claude)' : 'var(--color-border)'}`,
              color: ok ? 'var(--color-text)' : '#f87171',
            }}
            title={!ok
              ? `${source.label} is unreachable: ${source.error ?? 'unknown error'}`
              : `${source.label}: ${source.projects.length} projects, ${threadCount} threads${isActive ? ' (active)' : ''}${stale ? ' — live updates paused, reconnecting' : ''}`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full${stale ? ' animate-pulse' : ''}`}
              style={{ background: !ok ? '#f87171' : stale ? '#fbbf24' : sourceColor(source.sourceId, sources) }}
            />
            {source.label}
            {ok && <span style={{ opacity: 0.6 }}>{threadCount}</span>}
          </span>
        )
      })}
    </div>
  )
}

function HoverButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className="rounded p-1 transition-colors hover:bg-white/10"
      style={{ color: 'var(--color-text-muted)' }}
      title={title}
    >
      {children}
    </button>
  )
}

interface UnifiedSidebarProps {
  sidebarWidth: number
  sidebarResizing: boolean
  onToggleSidebar: () => void
  onOpenSettings: () => void
  actions: ActiveSourceActions
  dialogs: ReactNode
}

export default function UnifiedSidebar({
  sidebarWidth,
  sidebarResizing,
  onToggleSidebar,
  onOpenSettings,
  actions,
  dialogs,
}: UnifiedSidebarProps) {
  const snapshot = useUnifiedStore((s) => s.snapshot)
  const projects = useUnifiedStore((s) => s.projects)
  const loading = useUnifiedStore((s) => s.loading)
  const activeSourceId = useUnifiedStore((s) => s.activeSourceId)
  const liveStatus = useUnifiedStore((s) => s.liveStatus)
  const liveUnread = useUnifiedStore((s) => s.liveUnread)
  const liveTitle = useUnifiedStore((s) => s.liveTitle)
  const expandedProjects = useUnifiedStore((s) => s.expandedProjects)
  const collapsedLocations = useUnifiedStore((s) => s.collapsedLocations)
  const expandedPools = useUnifiedStore((s) => s.expandedPools)
  const sections = useUnifiedStore((s) => s.sections)
  const branchFacts = useUnifiedStore((s) => s.branchByLocation)
  const pathFacts = useUnifiedStore((s) => s.pathExistsByLocation)
  const archivedProjectsOpen = useUnifiedStore((s) => s.archivedProjectsOpen)

  const selectedThreadId = useThreadStore((s) => s.selectedThreadId)
  const threadStatusMap = useThreadStore((s) => s.statusMap)
  const threadUnread = useThreadStore((s) => s.unreadByThread)
  const deletingWorktreesByProject = useLocationStore((s) => s.deletingWorktreesByProject)
  const sortMode = useProjectStore((s) => s.sortMode)
  const setSortMode = useProjectStore((s) => s.setSortMode)
  const addToast = useToastStore((s) => s.add)

  const viewMode = useUiStore((s) => s.sidebarViewMode)
  const setViewMode = useUiStore((s) => s.setSidebarViewMode)
  const queueBySource = useUnifiedStore((s) => s.queueBySource)
  const [query, setQuery] = useState('')
  const [newProjectMenuOpen, setNewProjectMenuOpen] = useState(false)
  // Handlers close over the stores of whichever source is active, so after activating
  // another source the *next* render's handlers are the ones to call.
  const actionsRef = useRef(actions)
  useLayoutEffect(() => {
    actionsRef.current = actions
  })

  const sources = useMemo(() => snapshot?.sources ?? [], [snapshot])
  const reachableSources = sources.filter((source) => source.status === 'ok')
  const store = useUnifiedStore.getState

  // Mutations made through the ordinary single-source path (the composer creating a
  // Thread, a project dialog saving) land in the regular stores, not here. Watch their
  // shape — ids only, so status churn does not trigger it — and resync that source.
  const activeShape = useActiveSourceShape()
  const firstShape = useRef(true)
  useEffect(() => {
    if (firstShape.current) {
      firstShape.current = false
      return
    }
    store().scheduleRefresh(activeSourceId)
  }, [activeShape, activeSourceId, store])

  const views = useMemo(() => {
    const result = new Map<string, MemberView>()
    for (const project of projects) {
      for (const member of project.members) {
        const active = member.sourceId === activeSourceId
        const sectionThreads = [
          ...(sections[sectionKey('archived', member.sourceId, member.project.id)]?.threads ?? []),
          ...(sections[sectionKey('snoozed', member.sourceId, member.project.id)]?.threads ?? []),
        ]
        const statusMap: Record<string, ThreadStatus | undefined> = {}
        const unreadByThread: Record<string, boolean | undefined> = {}
        const withTitles = (thread: Thread): Thread => {
          const key = sourceKey(member.sourceId, thread.id)
          statusMap[thread.id] = (active ? threadStatusMap[thread.id] : undefined) ?? liveStatus[key] ?? thread.status
          unreadByThread[thread.id] = (active ? threadUnread[thread.id] : undefined) ?? liveUnread[key] ?? thread.unread
          const title = liveTitle[key]
          return title ? { ...thread, name: title } : thread
        }
        const threads = member.threads.map(withTitles)
        sectionThreads.forEach(withTitles)
        const branchByLocation: Record<string, string> = {}
        const pathExistsByLocation: Record<string, boolean> = {}
        for (const location of member.locations) {
          const key = sourceKey(member.sourceId, location.id)
          if (branchFacts[key]) branchByLocation[location.id] = branchFacts[key]
          if (key in pathFacts) pathExistsByLocation[location.id] = pathFacts[key]
        }
        result.set(sourceKey(member.sourceId, member.project.id), {
          member, active, threads, statusMap, unreadByThread, branchByLocation, pathExistsByLocation,
        })
      }
    }
    return result
  }, [projects, activeSourceId, sections, threadStatusMap, threadUnread, liveStatus, liveUnread, liveTitle, branchFacts, pathFacts])

  const viewOf = (member: UnifiedProjectMember): MemberView =>
    views.get(sourceKey(member.sourceId, member.project.id))!

  function isExpanded(project: UnifiedProject): boolean {
    return expandedProjects[project.key] ?? false
  }

  // Branch names (worktrees are named after theirs) and missing-path checks, for what is visible.
  useEffect(() => {
    for (const project of projects) {
      if (!(expandedProjects[project.key] ?? false)) continue
      for (const member of project.members) {
        const visible = member.locations.filter((l) => !collapsedLocations[sourceKey(member.sourceId, l.id)])
        store().loadLocationFacts(member.sourceId, visible)
      }
    }
  }, [projects, expandedProjects, collapsedLocations, store])

  const sortedProjects = useMemo(() => {
    const list = projects.slice()
    if (sortMode === 'alphabetical') {
      list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    }
    return list // mergeUnifiedSources already orders by latest activity
  }, [projects, sortMode])

  /**
   * Run an action against a member's source. Active source → the tree's own handler.
   * Otherwise → `direct` when the action can be done remotely without the workspace,
   * else activate the source and then use the tree's handler.
   */
  async function onSource(
    sourceId: string,
    projectId: string | undefined,
    label: string,
    viaActive: (a: ActiveSourceActions) => unknown,
    direct?: () => Promise<unknown>,
  ): Promise<void> {
    try {
      if (sourceId === activeSourceId) {
        await viaActive(actionsRef.current)
      } else if (direct) {
        await direct()
      } else {
        await store().activateSource(sourceId, projectId)
        // Let React commit the newly active source so the handlers see its stores.
        await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
        await viaActive(actionsRef.current)
      }
      void store().refresh([sourceId])
    } catch (error) {
      addToast({ type: 'error', title: label, message: error instanceof Error ? error.message : String(error) })
    }
  }

  function bodyFor(project: UnifiedProject, member: UnifiedProjectMember, showBadges: boolean) {
    const view = viewOf(member)
    const { sourceId } = member
    const projectId = member.project.id
    const archived = sections[sectionKey('archived', sourceId, projectId)]
    const snoozed = sections[sectionKey('snoozed', sourceId, projectId)]
    const collapsedLocationIds = new Set(
      member.locations.filter((l) => collapsedLocations[sourceKey(sourceId, l.id)]).map((l) => l.id),
    )
    const expandedAvailablePools = new Set(
      member.pools.filter((p) => expandedPools[sourceKey(sourceId, p.id)]).map((p) => p.id),
    )
    const invokeOn = store().invokeOn
    return (
      <ProjectTreeBody
        projectId={projectId}
        isExpanded={isExpanded(project)}
        projectThreads={view.threads}
        locations={member.locations}
        pools={member.pools}
        deletingWorktreeCount={view.active ? deletingWorktreesByProject[projectId] ?? 0 : 0}
        isSnoozedExpanded={snoozed?.open ?? false}
        projectSnoozedThreads={snoozed?.threads ?? []}
        projectSnoozedCount={member.snoozedCount}
        snoozedPage={snoozed?.page ?? 0}
        isArchivedExpanded={archived?.open ?? false}
        projectArchivedThreads={archived?.threads ?? []}
        projectArchivedCount={member.archivedCount}
        archivedPage={archived?.page ?? 0}
        showRoutines={view.active}
        locationBadge={showBadges ? <SourcePill label={member.sourceLabel} color={sourceColor(sourceId, sources)} /> : undefined}
        shellAvailable={sourceId === LOCAL_SOURCE_ID}
        collapsedLocationIds={collapsedLocationIds.size ? collapsedLocationIds : EMPTY_SET}
        expandedAvailablePools={expandedAvailablePools.size ? expandedAvailablePools : EMPTY_SET}
        pathExistsByLocation={view.pathExistsByLocation}
        branchByLocation={view.branchByLocation}
        selectedThreadId={view.active ? selectedThreadId : null}
        statusMap={view.statusMap}
        unreadByThread={view.unreadByThread}
        onToggleShowSnoozed={() => void store().toggleSection('snoozed', sourceId, projectId)}
        onSetSnoozedPage={(_id, page) => store().setSectionPage('snoozed', sourceId, projectId, page)}
        onToggleShowArchived={() => void store().toggleSection('archived', sourceId, projectId)}
        onSetArchivedPage={(_id, page) => store().setSectionPage('archived', sourceId, projectId, page)}
        onOpenLocationDialog={() => void onSource(sourceId, projectId, 'Could not add location', (a) => a.openLocationDialog(projectId))}
        onTogglePoolAvailableExpanded={(poolId) => store().togglePool(sourceId, poolId)}
        onToggleLocationCollapsed={(locationId) => store().toggleLocation(sourceId, locationId)}
        onCheckoutLocation={(locationId) => onSource(sourceId, projectId, 'Checkout failed',
          (a) => a.checkoutLocation(locationId, projectId),
          () => invokeOn(sourceId, 'locations:checkout', locationId))}
        onReturnLocationToPool={(locationId) => onSource(sourceId, projectId, 'Return to pool failed',
          (a) => a.returnLocationToPool(locationId, projectId),
          () => invokeOn(sourceId, 'locations:returnToPool', locationId))}
        onNewThread={(_id, locationId) => onSource(sourceId, projectId, 'Could not start a thread',
          (a) => a.newThread(projectId, locationId))}
        onNewWorktreeThread={(_id, parentId) => onSource(sourceId, projectId, 'Could not start a worktree thread',
          (a) => a.newWorktreeThread(projectId, parentId))}
        onRemoveWorktree={(location) => onSource(sourceId, projectId, 'Remove worktree failed',
          (a) => a.removeWorktree(location, projectId),
          async () => {
            const busy = view.threads.some((t) => t.location_id === location.id
              && (view.statusMap[t.id] === 'running' || view.statusMap[t.id] === 'stopping'))
            if (busy) return
            if (!window.confirm(`Remove worktree "${location.label}" on ${member.sourceLabel}?\n\n${location.path}`)) return
            await invokeOn(sourceId, 'locations:removeWorktree', location.id)
          })}
        onSelectThread={(threadId) => void store().openThread(sourceId, projectId, threadId)}
        onArchiveThread={(thread) => onSource(sourceId, projectId, 'Archive failed',
          (a) => a.archiveThread(thread, projectId),
          () => invokeOn(sourceId, 'threads:archive', thread.id))}
        onUnarchiveThread={(thread) => onSource(sourceId, projectId, 'Unarchive failed',
          (a) => a.unarchiveThread(thread, projectId),
          () => invokeOn(sourceId, 'threads:unarchive', thread.id))}
        onSnoozeThread={(thread, _id, untilIso) => onSource(sourceId, projectId, 'Snooze failed',
          (a) => a.snoozeThread(thread, projectId, untilIso),
          () => invokeOn(sourceId, 'threads:snooze', thread.id, untilIso))}
        onWakeThread={(thread) => onSource(sourceId, projectId, 'Wake failed',
          (a) => a.wakeThread(thread, projectId),
          () => invokeOn(sourceId, 'threads:unsnooze', thread.id))}
      />
    )
  }

  function memberActions(member: UnifiedProjectMember) {
    const { sourceId, project } = member
    return (
      <>
        <HoverButton title={`Add location on ${member.sourceLabel}`} onClick={() => void onSource(sourceId, project.id, 'Could not add location', (a) => a.openLocationDialog(project.id))}>
          <Plus size={11} />
        </HoverButton>
        <HoverButton title="Edit project" onClick={() => void onSource(sourceId, project.id, 'Could not edit project', (a) => a.editProject(project))}>
          <Pencil size={11} />
        </HoverButton>
        <HoverButton
          title="Archive project"
          onClick={() => void onSource(sourceId, project.id, 'Archive project failed',
            (a) => a.archiveProject(project.id),
            () => store().invokeOn(sourceId, 'projects:archive', project.id))}
        >
          <Archive size={11} />
        </HoverButton>
        <HoverButton title="Delete project" onClick={() => void onSource(sourceId, project.id, 'Could not delete project', (a) => a.confirmDeleteProject(project))}>
          <X size={11} />
        </HoverButton>
      </>
    )
  }

  const trimmed = query.trim().toLowerCase()
  const searchResults = useMemo(() => {
    if (!trimmed) return []
    const results: Array<{ view: MemberView; thread: Thread; projectName: string }> = []
    for (const project of sortedProjects) {
      for (const member of project.members) {
        const view = views.get(sourceKey(member.sourceId, member.project.id))
        if (!view) continue
        for (const thread of view.threads) {
          if (thread.name.toLowerCase().includes(trimmed)) results.push({ view, thread, projectName: project.name })
        }
      }
    }
    return results
  }, [trimmed, sortedProjects, views])

  const archivedProjects = sources.flatMap((source) =>
    source.archivedProjects.map((project) => ({ source, project })))
  const showSourceBadges = reachableSources.length > 1

  // The Queue is only fetched while it is on screen; entering it loads every source.
  useEffect(() => {
    if (viewMode === 'queue') void store().refreshQueue()
  }, [viewMode, store])

  // One list across sources, with the same live overrides the tree applies. Live state is
  // folded into each row (status/unread/name) so bucketing and dots read it directly.
  const queue = useMemo(() => {
    const rows: UnifiedQueueThread[] = []
    const statusMap: Record<string, ThreadStatus | undefined> = {}
    const unreadMap: Record<string, boolean | undefined> = {}
    for (const source of sources) {
      const active = source.sourceId === activeSourceId
      for (const thread of queueBySource[source.sourceId] ?? []) {
        const key = sourceKey(source.sourceId, thread.id)
        const status = (active ? threadStatusMap[thread.id] : undefined) ?? liveStatus[key] ?? thread.status
        const unread = (active ? threadUnread[thread.id] : undefined) ?? liveUnread[key] ?? thread.unread
        rows.push({ ...thread, status, unread, name: liveTitle[key] ?? thread.name })
        statusMap[thread.id] = status
        unreadMap[thread.id] = unread
      }
    }
    return { rows, statusMap, unreadMap }
  }, [sources, queueBySource, activeSourceId, threadStatusMap, threadUnread, liveStatus, liveUnread, liveTitle])

  function queueSource(thread: QueueThread): string {
    return (thread as Partial<UnifiedQueueThread>).source_id ?? activeSourceId
  }

  const refreshButton = (
    <button
      onClick={() => void store().refresh()}
      className="flex items-center justify-center rounded p-1.5 opacity-60 transition-opacity hover:opacity-100"
      title="Refresh all sources"
      style={{ color: 'var(--color-text-muted)' }}
    >
      <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
    </button>
  )

  if (viewMode === 'queue') {
    const invokeOn = store().invokeOn
    return (
      <QueueSidebar
        title={<><Layers size={13} />All sources</>}
        headerActions={refreshButton}
        subHeader={<SourceChips />}
        queueThreads={queue.rows}
        statusMap={queue.statusMap}
        unreadByThread={queue.unreadMap}
        selectedThreadId={selectedThreadId}
        selectedKey={selectedThreadId ? sourceKey(activeSourceId, selectedThreadId) : null}
        rowKey={(thread) => sourceKey(queueSource(thread), thread.id)}
        renderProjectIcon={(thread) => (
          <SourceProjectFavicon
            sourceId={queueSource(thread)}
            projectId={thread.project_id}
            active={queueSource(thread) === activeSourceId}
            className="h-2.5 w-2.5"
          />
        )}
        renderRowBadge={showSourceBadges
          ? (thread) => {
            const row = thread as UnifiedQueueThread
            return <SourcePill label={row.source_label} color={sourceColor(row.source_id, sources)} />
          }
          : undefined}
        loadCollapsed={loadUnifiedCollapsed}
        sidebarWidth={sidebarWidth}
        sidebarResizing={sidebarResizing}
        onToggleSidebar={onToggleSidebar}
        onSetViewMode={setViewMode}
        onOpenSettings={onOpenSettings}
        onNewThread={() => void onSource(activeSourceId, undefined, 'Could not start a thread', (a) => a.openNewThreadComposer())}
        onSelectThread={(thread) => void store().openThread(queueSource(thread), thread.project_id, thread.id)}
        onArchiveThread={(thread) => onSource(queueSource(thread), thread.project_id, 'Archive failed',
          (a) => a.archiveThread(thread, thread.project_id),
          () => invokeOn(queueSource(thread), 'threads:archive', thread.id))}
        onUnarchiveThread={(thread) => onSource(queueSource(thread), thread.project_id, 'Unarchive failed',
          (a) => a.unarchiveThread(thread, thread.project_id),
          () => invokeOn(queueSource(thread), 'threads:unarchive', thread.id))}
        onSnoozeThread={(thread, untilIso) => onSource(queueSource(thread), thread.project_id, 'Snooze failed',
          (a) => a.snoozeThread(thread, thread.project_id, untilIso),
          () => invokeOn(queueSource(thread), 'threads:snooze', thread.id, untilIso))}
        onWakeThread={(thread) => onSource(queueSource(thread), thread.project_id, 'Wake failed',
          (a) => a.wakeThread(thread, thread.project_id),
          () => invokeOn(queueSource(thread), 'threads:unsnooze', thread.id))}
        dialogs={dialogs}
      />
    )
  }

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
          <span className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--color-claude)' }}>
            <Layers size={13} />
            All sources
          </span>
        </div>
        <div className="relative flex items-center gap-0.5">
          <button
            onClick={() => setSortMode(sortMode === 'alphabetical' ? 'lastMessage' : 'alphabetical')}
            className="flex items-center justify-center rounded p-1.5 opacity-60 transition-opacity hover:opacity-100"
            style={{ color: 'var(--color-text-muted)' }}
            title={sortMode === 'alphabetical'
              ? 'Sorted alphabetically — click to sort by last message'
              : 'Sorted by last message — click to sort alphabetically'}
          >
            {sortMode === 'alphabetical' ? <ArrowDownAZ size={14} /> : <History size={14} />}
          </button>
          {refreshButton}
          <button
            onClick={onOpenSettings}
            className="flex items-center justify-center rounded p-1.5 opacity-60 transition-opacity hover:opacity-100"
            title="Settings"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Settings size={14} />
          </button>
          <button
            onClick={() => {
              if (reachableSources.length <= 1) {
                void onSource(reachableSources[0]?.sourceId ?? activeSourceId, undefined, 'Could not create project', (a) => a.openProjectDialog())
              } else {
                setNewProjectMenuOpen((open) => !open)
              }
            }}
            className="flex items-center justify-center rounded p-1.5 opacity-60 transition-opacity hover:opacity-100"
            style={{ color: 'var(--color-text-muted)' }}
            title="New project"
          >
            <Plus size={14} />
          </button>
          {newProjectMenuOpen && (
            <div
              className="absolute right-0 top-full z-50 mt-1 min-w-[160px] rounded py-1 shadow-lg"
              style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
              onMouseLeave={() => setNewProjectMenuOpen(false)}
            >
              <div className="px-3 py-1 text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                New project on…
              </div>
              {reachableSources.map((source) => (
                <button
                  key={source.sourceId}
                  onClick={() => {
                    setNewProjectMenuOpen(false)
                    void onSource(source.sourceId, undefined, 'Could not create project', (a) => a.openProjectDialog())
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-white/5"
                  style={{ color: 'var(--color-text)' }}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: sourceColor(source.sourceId, sources) }} />
                  {source.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <SourceChips />

      <ViewModeSwitch mode="tree" onSetMode={setViewMode} />

      <div className="flex-shrink-0 border-b px-3 py-1.5" style={{ borderColor: 'var(--color-border)' }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search threads…"
          className="w-full rounded px-2 py-1 text-xs outline-none"
          style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {trimmed ? (
          searchResults.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
              No threads match &quot;{query.trim()}&quot;
            </p>
          ) : searchResults.map(({ view, thread, projectName }) => (
            <button
              key={sourceKey(view.member.sourceId, thread.id)}
              onClick={() => void store().openThread(view.member.sourceId, view.member.project.id, thread.id)}
              className="group/thread flex w-full min-w-0 items-center pl-4 pr-2 py-1 text-left text-xs transition-colors"
              style={{
                background: view.active && selectedThreadId === thread.id ? 'var(--color-border)' : 'transparent',
                color: 'var(--color-text-muted)',
              }}
            >
              <span
                className={`mr-2 h-1.5 w-1.5 flex-shrink-0 rounded-full${view.unreadByThread[thread.id] ? ' status-unread' : ''}`}
                style={{ background: getThreadStatusColor(thread, view.statusMap, view.unreadByThread) }}
              />
              <span className="min-w-0 flex-1 truncate">{thread.name}</span>
              <span className="ml-1 flex-shrink-0 text-[10px] opacity-0 transition-opacity group-hover/thread:opacity-50">
                {projectName}
              </span>
              {showSourceBadges && <SourcePill label={view.member.sourceLabel} color={sourceColor(view.member.sourceId, sources)} />}
            </button>
          ))
        ) : (
          <>
            {sortedProjects.map((project) => {
              const open = isExpanded(project)
              const multi = project.members.length > 1
              const memberViews = project.members.map(viewOf)
              const unreadCount = memberViews.reduce((n, view) => n + view.threads.filter((t) =>
                view.unreadByThread[t.id] && view.statusMap[t.id] !== 'running' && view.statusMap[t.id] !== 'stopping').length, 0)
              const lead = project.members[0]
              return (
                <div key={project.key}>
                  <div className="group relative">
                    <button
                      onClick={() => store().toggleProject(project.key, !open)}
                      className="flex w-full min-w-0 items-center px-3 py-1.5 text-left text-sm transition-colors"
                      style={{ background: open ? 'var(--color-surface-2)' : 'transparent', color: 'var(--color-text)' }}
                      title={project.gitUrl ?? 'No Git URL — not merged with other sources'}
                    >
                      {open
                        ? <ChevronDown size={12} className="mr-1.5 flex-shrink-0 opacity-50" />
                        : <ChevronRight size={12} className="mr-1.5 flex-shrink-0 opacity-50" />}
                      <SourceProjectFavicon sourceId={lead.sourceId} projectId={lead.project.id} active={lead.sourceId === activeSourceId} />
                      <span className="truncate">{project.name}</span>
                      {unreadCount > 0 && (
                        <span
                          className="ml-1.5 flex-shrink-0 rounded-full px-1.5 py-0 text-[10px] font-semibold leading-[16px]"
                          style={{ background: '#22c55e', color: '#000' }}
                        >
                          {unreadCount}
                        </span>
                      )}
                      {showSourceBadges && (
                        <span className="ml-auto flex flex-shrink-0 items-center gap-0.5 pl-1">
                          {project.members.map((member) => (
                            <span
                              key={sourceKey(member.sourceId, member.project.id)}
                              className="h-1.5 w-1.5 rounded-full"
                              style={{ background: sourceColor(member.sourceId, sources) }}
                              title={member.sourceLabel}
                            />
                          ))}
                        </span>
                      )}
                    </button>
                    {!multi && (
                      <div
                        className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                        style={{ background: open ? 'var(--color-surface-2)' : 'var(--color-surface)' }}
                      >
                        {memberActions(lead)}
                      </div>
                    )}
                  </div>

                  {project.members.map((member) => (
                    <div key={sourceKey(member.sourceId, member.project.id)}>
                      {/* A merged Project gets one labelled group per source it lives on. */}
                      {multi && open && (
                        <div className="group relative">
                          <div
                            className="flex items-center gap-1.5 pl-5 pr-2 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wider"
                            style={{ color: sourceColor(member.sourceId, sources) }}
                          >
                            <span className="h-1.5 w-1.5 rounded-full" style={{ background: sourceColor(member.sourceId, sources) }} />
                            <span className="truncate">{member.sourceLabel}</span>
                            {member.project.name !== project.name && (
                              <span className="truncate normal-case tracking-normal opacity-60">({member.project.name})</span>
                            )}
                          </div>
                          <div
                            className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                            style={{ background: 'var(--color-surface)' }}
                          >
                            {memberActions(member)}
                          </div>
                        </div>
                      )}
                      {bodyFor(project, member, showSourceBadges && !multi)}
                    </div>
                  ))}
                </div>
              )
            })}

            {loading && projects.length === 0 && (
              <div className="flex flex-col items-center gap-2 px-4 py-6" style={{ color: 'var(--color-text-muted)' }}>
                <div className="status-spinner h-3 w-3" />
                <span className="text-xs">Gathering every source…</span>
              </div>
            )}

            {!loading && projects.length === 0 && (
              <p className="px-4 py-6 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
                No projects on any reachable source.
              </p>
            )}

            {archivedProjects.length > 0 && (
              <div className="mt-1 border-t" style={{ borderColor: 'var(--color-border)' }}>
                <button
                  onClick={() => store().setArchivedProjectsOpen(!archivedProjectsOpen)}
                  className="flex w-full items-center px-3 py-1.5 text-left text-xs opacity-40 transition-opacity hover:opacity-70"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  {archivedProjectsOpen
                    ? <ChevronDown size={10} className="mr-1.5 flex-shrink-0" />
                    : <ChevronRight size={10} className="mr-1.5 flex-shrink-0" />}
                  Archived ({archivedProjects.length})
                </button>
                {archivedProjectsOpen && archivedProjects.map(({ source, project }) => (
                  <div key={sourceKey(source.sourceId, project.id)} className="group relative">
                    <div className="flex w-full min-w-0 items-center px-3 py-1.5 text-sm opacity-40" style={{ color: 'var(--color-text)' }}>
                      <span className="mr-1.5 flex-shrink-0" style={{ width: '12px' }} />
                      <SourceProjectFavicon sourceId={source.sourceId} projectId={project.id} active={source.sourceId === activeSourceId} />
                      <span className="truncate">{project.name}</span>
                      {showSourceBadges && <SourcePill label={source.label} color={sourceColor(source.sourceId, sources)} />}
                    </div>
                    <div
                      className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                      style={{ background: 'var(--color-surface)' }}
                    >
                      <HoverButton
                        title="Unarchive project"
                        onClick={() => void onSource(source.sourceId, project.id, 'Unarchive project failed',
                          (a) => a.unarchiveProject(project.id),
                          () => store().invokeOn(source.sourceId, 'projects:unarchive', project.id))}
                      >
                        <ArchiveRestore size={11} />
                      </HoverButton>
                      <HoverButton
                        title="Delete project"
                        onClick={() => void onSource(source.sourceId, project.id, 'Could not delete project', (a) => a.confirmDeleteProject(project))}
                      >
                        <X size={11} />
                      </HoverButton>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {dialogs}
      <SidebarResizeHandle />
    </aside>
  )
}

/**
 * A string that changes only when the active source's Projects, Threads or Locations are
 * added or removed — not on status or timestamp churn.
 */
function useActiveSourceShape(): string {
  const projects = useProjectStore((s) => s.projects.map((p) => `${p.id}:${p.name}`).join(','))
  const archived = useProjectStore((s) => s.archivedProjects.map((p) => p.id).join(','))
  const threads = useThreadStore((s) => Object.entries(s.byProject)
    .map(([projectId, list]) => `${projectId}=${(list ?? []).filter((t) => !t.is_pending).map((t) => t.id).join('.')}`)
    .sort()
    .join(','))
  const locations = useLocationStore((s) => Object.entries(s.byProject)
    .map(([projectId, list]) => `${projectId}=${(list ?? []).map((l) => `${l.id}${l.checked_out ? '+' : ''}`).join('.')}`)
    .sort()
    .join(','))
  return `${projects}|${archived}|${threads}|${locations}`
}
