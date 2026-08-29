import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/**
 * Workspace UI state: which thread is open in the main area, which projects
 * are expanded in the sidebar, and whether the sidebar drawer is open.
 * Selection/expansion persist across launches (like the desktop sidebar).
 */
/** Which list the user works from: the project tree, or the cross-project Queue. */
export type SidebarViewMode = 'tree' | 'queue'

interface UiState {
  selectedProjectId: string | null
  selectedThreadId: string | null
  expandedProjectIds: string[]
  sidebarOpen: boolean
  sidebarViewMode: SidebarViewMode

  selectThread: (projectId: string, threadId: string) => void
  clearSelection: () => void
  toggleProject: (projectId: string) => void
  expandProject: (projectId: string) => void
  setSidebarOpen: (open: boolean) => void
  setSidebarViewMode: (mode: SidebarViewMode) => void
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      selectedProjectId: null,
      selectedThreadId: null,
      expandedProjectIds: [],
      sidebarOpen: false,
      sidebarViewMode: 'tree',

      selectThread: (projectId, threadId) =>
        set({ selectedProjectId: projectId, selectedThreadId: threadId, sidebarOpen: false }),

      clearSelection: () => set({ selectedProjectId: null, selectedThreadId: null }),

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

      setSidebarOpen: (open) => set({ sidebarOpen: open }),

      setSidebarViewMode: (mode) => set({ sidebarViewMode: mode }),
    }),
    {
      name: 'polycode.ui',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({
        selectedProjectId: s.selectedProjectId,
        selectedThreadId: s.selectedThreadId,
        expandedProjectIds: s.expandedProjectIds,
        sidebarViewMode: s.sidebarViewMode,
      }),
    },
  ),
)
