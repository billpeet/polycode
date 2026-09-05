import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/**
 * Which Queue rows are shown: everything, only unread, or one project.
 * Not persisted — a filter is a moment's intent, but it must survive a
 * round-trip into a thread and back, which is why it lives here rather than
 * in the Queue screen's local state.
 */
export type QueueFilter = 'all' | 'unread' | { projectId: string }

/**
 * Workspace UI state. Which thread is open is the navigation stack's
 * business (`/thread/[threadId]`); only tree expansion persists across
 * launches, like the desktop sidebar.
 */
interface UiState {
  expandedProjectIds: string[]
  queueFilter: QueueFilter

  toggleProject: (projectId: string) => void
  expandProject: (projectId: string) => void
  setQueueFilter: (filter: QueueFilter) => void
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      expandedProjectIds: [],
      queueFilter: 'all',

      toggleProject: (projectId) =>
        set((s) => ({
          expandedProjectIds: s.expandedProjectIds.includes(projectId)
            ? s.expandedProjectIds.filter((id) => id !== projectId)
            : [...s.expandedProjectIds, projectId],
        })),

      expandProject: (projectId) =>
        set((s) => ({
          expandedProjectIds: s.expandedProjectIds.includes(projectId)
            ? s.expandedProjectIds
            : [...s.expandedProjectIds, projectId],
        })),

      setQueueFilter: (filter) => set({ queueFilter: filter }),
    }),
    {
      name: 'polycode.ui',
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
      partialize: (s) => ({ expandedProjectIds: s.expandedProjectIds }),
      // v0 also persisted the selected thread and drawer mode; neither exists now.
      migrate: (persisted) => {
        const state = (persisted ?? {}) as { expandedProjectIds?: unknown }
        return {
          expandedProjectIds: Array.isArray(state.expandedProjectIds)
            ? state.expandedProjectIds.filter((id): id is string => typeof id === 'string')
            : [],
        } as UiState
      },
    },
  ),
)
