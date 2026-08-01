import { useEffect, useRef } from 'react'
import { useMessageStore } from '../stores/messages'
import { useProjectStore } from '../stores/projects'
import { useSessionStore } from '../stores/sessions'
import { useThreadStore } from '../stores/threads'

const DATABASE_SYNC_INTERVAL_MS = 30_000

/**
 * Reconcile renderer state with the database after another client may have
 * changed it. IPC push events are intentionally still the fast path; this is
 * the eventual-consistency safety net for events this renderer never saw.
 */
export function useDatabaseSync(): void {
  const refreshingRef = useRef(false)

  useEffect(() => {
    async function refresh(): Promise<void> {
      if (refreshingRef.current) return
      refreshingRef.current = true

      try {
        const projectState = useProjectStore.getState()
        const threadState = useThreadStore.getState()
        const projectIds = new Set(Object.keys(threadState.byProject))
        if (projectState.selectedProjectId) projectIds.add(projectState.selectedProjectId)

        await Promise.allSettled(
          [...projectIds]
            // A canonical list fetch would remove an optimistic thread before
            // threads:create has committed it to the database.
            .filter((projectId) => !(threadState.byProject[projectId] ?? []).some((thread) => thread.is_pending))
            .map((projectId) => threadState.fetch(projectId))
        )

        const latestThreadState = useThreadStore.getState()
        const archivedProjectId = latestThreadState.expandedArchivedProjectId
        if (archivedProjectId) {
          await latestThreadState.fetchArchived(
            archivedProjectId,
            latestThreadState.archivedPageByProject[archivedProjectId] ?? 0
          ).catch(() => undefined)
        }

        const threadId = latestThreadState.selectedThreadId
        if (!threadId || threadId.startsWith('pending-thread-')) return

        await useSessionStore.getState().fetch(threadId).catch(() => undefined)
        const sessionId = useSessionStore.getState().activeSessionByThread[threadId]
        if (sessionId) {
          await useMessageStore.getState().fetchBySession(sessionId).catch(() => undefined)
        } else {
          await useMessageStore.getState().fetch(threadId).catch(() => undefined)
        }
      } finally {
        refreshingRef.current = false
      }
    }

    function refreshWhenVisible(): void {
      if (document.visibilityState !== 'hidden') void refresh()
    }

    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    const interval = window.setInterval(refreshWhenVisible, DATABASE_SYNC_INTERVAL_MS)

    return () => {
      window.removeEventListener('focus', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      window.clearInterval(interval)
    }
  }, [])
}
