import { useRouter } from 'expo-router'
import { useMemo } from 'react'
import { sourceKey, type QueueThread, type UnifiedQueueThread } from '@polycode/shared'
import { openSourceThread, openThread } from '@/lib/navigation'
import { useHostsStore } from '@/stores/hosts'
import { QUEUE_PAGE_SIZE, useThreadsStore } from '@/stores/threads'
import { loadUnifiedCollapsed, useUnifiedStore } from '@/stores/unified'

export type QueueCollapsedVariant = 'snoozed' | 'archived'

/**
 * One page of the Snoozed or Archived section. `offset` is the number of rows already
 * shown (0 restarts the section). `hasMore` is the loader's call because a page merged
 * from several hosts can be longer than the page size and still not be the end.
 */
export type QueueCollapsedLoader = (
  variant: QueueCollapsedVariant,
  search: string | null,
  offset: number,
) => Promise<{ rows: QueueThread[]; hasMore: boolean }>

/**
 * Everything the Queue screen needs from wherever its rows come from: the active host's
 * Queue, or — in the unified ("All") view — every host's. The screen renders and filters
 * rows; which host a row belongs to, and how to act on it there, is decided here.
 */
export interface QueueModel {
  unified: boolean
  /**
   * Names where the rows come from: `all`, or the active host. Rows paged in under one
   * scope mean nothing under another, so the collapsed sections reset when it changes.
   */
  scope: string
  threads: QueueThread[]
  loading: boolean
  refresh: () => void
  /** Row identity. Thread ids are only unique per host, so the unified view prefixes the host. */
  rowKey: (thread: QueueThread) => string
  /**
   * What a Project filter chip matches on: one chip per repository across hosts. Null
   * until the row's Project has been seen in a snapshot — its merged identity is not
   * known before then, and a chip keyed on a guess would stop matching once it is.
   */
  projectKey: (thread: QueueThread) => string | null
  /** The host a row belongs to, when that is worth showing. */
  source: (thread: QueueThread) => { id: string; label: string } | null
  open: (thread: QueueThread) => void
  snooze: (thread: QueueThread, untilIso: string) => Promise<void>
  wake: (thread: QueueThread) => Promise<void>
  archive: (thread: QueueThread) => Promise<void>
  unarchive: (thread: QueueThread) => Promise<void>
  /** Stable across renders: it sits in the collapsed sections' fetch effect dependencies. */
  loadCollapsed: QueueCollapsedLoader
}

const loadActiveCollapsed: QueueCollapsedLoader = async (variant, search, offset) => {
  const store = useThreadsStore.getState()
  const rows = await (variant === 'snoozed'
    ? store.listQueueSnoozed(search, offset)
    : store.listQueueArchived(search, offset))
  return { rows, hasMore: rows.length === QUEUE_PAGE_SIZE }
}

const loadAllCollapsed: QueueCollapsedLoader = (variant, search, offset) =>
  loadUnifiedCollapsed(variant, search, offset, QUEUE_PAGE_SIZE)

/** Every row in the unified Queue — live or paged in — carries its host. */
function hostOf(thread: QueueThread): string {
  return (thread as UnifiedQueueThread).source_id
}

const threadId = (thread: QueueThread): string => thread.id
const projectId = (thread: QueueThread): string => thread.project_id
const noSource = (): null => null

export function useQueueModel(): QueueModel {
  const router = useRouter()
  const unified = useUnifiedStore((s) => s.enabled)
  const activeThreads = useThreadsStore((s) => s.queueThreads)
  const activeLoading = useThreadsStore((s) => s.queueLoading)
  const queueBySource = useUnifiedStore((s) => s.queueBySource)
  const unifiedLoading = useUnifiedStore((s) => s.queueLoading)
  const projectKeys = useUnifiedStore((s) => s.projectKeys)
  const activeHostId = useHostsStore((s) => s.activeHostId)

  const active = useMemo<QueueModel>(() => {
    const store = (): ReturnType<typeof useThreadsStore.getState> => useThreadsStore.getState()
    return {
      unified: false,
      scope: `host:${activeHostId ?? ''}`,
      threads: activeThreads,
      loading: activeLoading,
      refresh: () => void store().fetchQueue(),
      rowKey: threadId,
      projectKey: projectId,
      source: noSource,
      open: (thread) => openThread(router, thread),
      snooze: (thread, untilIso) => store().snooze(thread.project_id, thread.id, untilIso),
      wake: (thread) => store().wake(thread.project_id, thread.id),
      archive: (thread) => store().archive(thread.project_id, thread.id),
      unarchive: (thread) => store().unarchive(thread.project_id, thread.id),
      loadCollapsed: loadActiveCollapsed,
    }
  }, [router, activeThreads, activeLoading, activeHostId])

  const all = useMemo<QueueModel>(() => {
    const store = (): ReturnType<typeof useUnifiedStore.getState> => useUnifiedStore.getState()
    return {
      unified: true,
      scope: 'all',
      threads: Object.values(queueBySource).flat(),
      loading: unifiedLoading,
      refresh: () => void store().refresh(),
      rowKey: (thread) => sourceKey(hostOf(thread), thread.id),
      // Projects merged across hosts share a key, so one chip filters all their copies.
      projectKey: (thread) => projectKeys[sourceKey(hostOf(thread), thread.project_id)] ?? null,
      source: (thread) => ({ id: hostOf(thread), label: (thread as UnifiedQueueThread).source_label }),
      open: (thread) => openSourceThread(router, hostOf(thread), thread),
      snooze: (thread, untilIso) => store().snoozeThread(hostOf(thread), thread.id, untilIso),
      wake: (thread) => store().wakeThread(hostOf(thread), thread.id),
      archive: (thread) => store().archiveThread(hostOf(thread), thread.id),
      unarchive: (thread) => store().unarchiveThread(hostOf(thread), thread.id),
      loadCollapsed: loadAllCollapsed,
    }
  }, [router, queueBySource, unifiedLoading, projectKeys])

  return unified ? all : active
}
