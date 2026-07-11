import { create } from 'zustand'
import { RepoLocation, SshConfig, WslConfig, ConnectionType, LocationPool } from '../types/ipc'
import { useThreadStore } from './threads'

interface LocationStore {
  byProject: Record<string, RepoLocation[]>
  poolsByProject: Record<string, LocationPool[]>
  deletingWorktreesByProject: Record<string, number>
  fetch: (projectId: string) => Promise<void>
  fetchPools: (projectId: string) => Promise<void>
  createPool: (projectId: string, name: string) => Promise<LocationPool>
  updatePool: (id: string, projectId: string, name: string) => Promise<void>
  removePool: (id: string, projectId: string) => Promise<void>
  create: (projectId: string, label: string, connectionType: ConnectionType, path: string, poolId?: string | null, ssh?: SshConfig | null, wsl?: WslConfig | null) => Promise<RepoLocation>
  update: (id: string, projectId: string, label: string, connectionType: ConnectionType, path: string, poolId?: string | null, ssh?: SshConfig | null, wsl?: WslConfig | null) => Promise<void>
  remove: (id: string, projectId: string) => Promise<void>
  createWorktree: (parentLocationId: string, projectId: string, label?: string | null) => Promise<RepoLocation>
  removeWorktree: (id: string, projectId: string) => Promise<void>
  checkout: (id: string, projectId: string) => Promise<void>
  returnToPool: (id: string, projectId: string) => Promise<void>
}

export const useLocationStore = create<LocationStore>((set) => ({
  byProject: {},
  poolsByProject: {},
  deletingWorktreesByProject: {},

  fetch: async (projectId) => {
    const locations = await window.api.invoke('locations:list', projectId)
    set((s) => ({
      byProject: { ...s.byProject, [projectId]: locations }
    }))
  },

  fetchPools: async (projectId) => {
    try {
      const pools = await window.api.invoke('location-pools:list', projectId)
      set((s) => ({
        poolsByProject: { ...s.poolsByProject, [projectId]: pools }
      }))
    } catch {
      set((s) => ({
        poolsByProject: { ...s.poolsByProject, [projectId]: [] }
      }))
    }
  },

  createPool: async (projectId, name) => {
    const pool = await window.api.invoke('location-pools:create', projectId, name)
    set((s) => ({
      poolsByProject: { ...s.poolsByProject, [projectId]: [...(s.poolsByProject[projectId] ?? []), pool] }
    }))
    return pool
  },

  updatePool: async (id, projectId, name) => {
    await window.api.invoke('location-pools:update', id, name)
    set((s) => ({
      poolsByProject: {
        ...s.poolsByProject,
        [projectId]: (s.poolsByProject[projectId] ?? []).map((p) => (p.id === id ? { ...p, name } : p))
      }
    }))
  },

  removePool: async (id, projectId) => {
    await window.api.invoke('location-pools:delete', id)
    set((s) => ({
      poolsByProject: {
        ...s.poolsByProject,
        [projectId]: (s.poolsByProject[projectId] ?? []).filter((p) => p.id !== id)
      },
      byProject: {
        ...s.byProject,
        [projectId]: (s.byProject[projectId] ?? []).map((l) =>
          l.pool_id === id ? { ...l, pool_id: null, checked_out: false } : l
        )
      }
    }))
  },

  create: async (projectId, label, connectionType, path, poolId, ssh, wsl) => {
    const location = await window.api.invoke('locations:create', projectId, label, connectionType, path, poolId ?? null, ssh, wsl)
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: [...(s.byProject[projectId] ?? []), location]
      }
    }))
    return location
  },

  update: async (id, projectId, label, connectionType, path, poolId, ssh, wsl) => {
    await window.api.invoke('locations:update', id, label, connectionType, path, poolId ?? null, ssh, wsl)
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: (s.byProject[projectId] ?? []).map((l) =>
          l.id === id ? { ...l, label, connection_type: connectionType, path, pool_id: poolId ?? null, checked_out: poolId ? l.checked_out : false, ssh: ssh ?? null, wsl: wsl ?? null } : l
        )
      }
    }))
  },

  remove: async (id, projectId) => {
    await window.api.invoke('locations:delete', id)
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: (s.byProject[projectId] ?? []).filter((l) => l.id !== id)
      }
    }))
  },

  createWorktree: async (parentLocationId, projectId, label) => {
    const location = await window.api.invoke('locations:createWorktree', parentLocationId, label ?? null)
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: [...(s.byProject[projectId] ?? []), location]
      }
    }))
    return location
  },

  removeWorktree: async (id, projectId) => {
    const activeThreads = useThreadStore.getState().byProject[projectId] ?? []
    const worktreeThreadIds = new Set(activeThreads.filter((thread) => thread.location_id === id).map((thread) => thread.id))
    const locationsSnapshot = (useLocationStore.getState().byProject[projectId] ?? []).slice()
    const threadSnapshot = useThreadStore.getState()

    useThreadStore.setState((s) => {
      const removedThreads = (s.byProject[projectId] ?? []).filter((thread) => worktreeThreadIds.has(thread.id))
      const nextStatusMap = { ...s.statusMap }
      const nextUnreadByThread = { ...s.unreadByThread }
      const nextQueuedByThread = { ...s.queuedMessageByThread }
      const nextPlanModeByThread = { ...s.planModeByThread }
      const nextFastModeByThread = { ...s.fastModeByThread }
      const nextRunStartedAtByThread = { ...s.runStartedAtByThread }
      const nextPidByThread = { ...s.pidByThread }
      for (const threadId of worktreeThreadIds) {
        delete nextStatusMap[threadId]
        delete nextUnreadByThread[threadId]
        delete nextQueuedByThread[threadId]
        delete nextPlanModeByThread[threadId]
        delete nextFastModeByThread[threadId]
        delete nextRunStartedAtByThread[threadId]
        delete nextPidByThread[threadId]
      }
      return {
        byProject: {
          ...s.byProject,
          [projectId]: (s.byProject[projectId] ?? []).filter((thread) => !worktreeThreadIds.has(thread.id))
        },
        archivedCountByProject: {
          ...s.archivedCountByProject,
          [projectId]: (s.archivedCountByProject[projectId] ?? 0) + removedThreads.filter((thread) => thread.has_messages).length
        },
        selectedThreadId: s.selectedThreadId && worktreeThreadIds.has(s.selectedThreadId) ? null : s.selectedThreadId,
        statusMap: nextStatusMap,
        unreadByThread: nextUnreadByThread,
        queuedMessageByThread: nextQueuedByThread,
        planModeByThread: nextPlanModeByThread,
        fastModeByThread: nextFastModeByThread,
        runStartedAtByThread: nextRunStartedAtByThread,
        pidByThread: nextPidByThread,
      }
    })
    set((s) => ({
      deletingWorktreesByProject: {
        ...s.deletingWorktreesByProject,
        [projectId]: (s.deletingWorktreesByProject[projectId] ?? 0) + 1,
      },
      byProject: {
        ...s.byProject,
        [projectId]: (s.byProject[projectId] ?? []).filter((l) => l.id !== id)
      }
    }))
    try {
      await window.api.invoke('locations:removeWorktree', id)
    } catch (error) {
      useThreadStore.setState({
        byProject: threadSnapshot.byProject,
        archivedCountByProject: threadSnapshot.archivedCountByProject,
        selectedThreadId: threadSnapshot.selectedThreadId,
        statusMap: threadSnapshot.statusMap,
        unreadByThread: threadSnapshot.unreadByThread,
        queuedMessageByThread: threadSnapshot.queuedMessageByThread,
        planModeByThread: threadSnapshot.planModeByThread,
        fastModeByThread: threadSnapshot.fastModeByThread,
        runStartedAtByThread: threadSnapshot.runStartedAtByThread,
        pidByThread: threadSnapshot.pidByThread,
      })
      set((s) => ({
        byProject: { ...s.byProject, [projectId]: locationsSnapshot }
      }))
      throw error
    } finally {
      set((s) => {
        const currentCount = s.deletingWorktreesByProject[projectId] ?? 0
        const nextDeleting = { ...s.deletingWorktreesByProject }
        if (currentCount <= 1) delete nextDeleting[projectId]
        else nextDeleting[projectId] = currentCount - 1
        return { deletingWorktreesByProject: nextDeleting }
      })
    }
  },

  checkout: async (id, projectId) => {
    await window.api.invoke('locations:checkout', id)
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: (s.byProject[projectId] ?? []).map((l) => (l.id === id ? { ...l, checked_out: true } : l))
      }
    }))
  },

  returnToPool: async (id, projectId) => {
    await window.api.invoke('locations:returnToPool', id)
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: (s.byProject[projectId] ?? []).map((l) => (l.id === id ? { ...l, checked_out: false } : l))
      }
    }))
  },
}))
