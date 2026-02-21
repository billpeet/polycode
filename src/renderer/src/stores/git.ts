import { create } from 'zustand'
import { GitStatus } from '../types/ipc'

interface GitStore {
  // Keyed by project path
  statusByPath: Record<string, GitStatus | null>
  loadingByPath: Record<string, boolean>
  commitMessageByPath: Record<string, string>
  generatingMessageByPath: Record<string, boolean>
  pushingByPath: Record<string, boolean>
  pullingByPath: Record<string, boolean>
  // Keyed by threadId
  modifiedFilesByThread: Record<string, string[]>

  fetch: (repoPath: string) => Promise<void>
  commit: (repoPath: string, message: string) => Promise<void>
  stage: (repoPath: string, filePath: string) => Promise<void>
  unstage: (repoPath: string, filePath: string) => Promise<void>
  stageAll: (repoPath: string) => Promise<void>
  unstageAll: (repoPath: string) => Promise<void>
  stageFiles: (repoPath: string, filePaths: string[]) => Promise<void>
  setCommitMessage: (repoPath: string, message: string) => void
  generateCommitMessage: (repoPath: string) => Promise<void>
  push: (repoPath: string) => Promise<void>
  pull: (repoPath: string) => Promise<void>
  fetchModifiedFiles: (threadId: string, workingDir: string) => Promise<void>
}

export const useGitStore = create<GitStore>((set, get) => ({
  statusByPath: {},
  loadingByPath: {},
  commitMessageByPath: {},
  generatingMessageByPath: {},
  pushingByPath: {},
  pullingByPath: {},
  modifiedFilesByThread: {},

  fetch: async (repoPath) => {
    if (get().loadingByPath[repoPath]) return
    set((s) => ({ loadingByPath: { ...s.loadingByPath, [repoPath]: true } }))
    try {
      const status = await window.api.invoke('git:status', repoPath)
      set((s) => ({
        statusByPath: { ...s.statusByPath, [repoPath]: status },
        loadingByPath: { ...s.loadingByPath, [repoPath]: false },
      }))
    } catch {
      set((s) => ({ loadingByPath: { ...s.loadingByPath, [repoPath]: false } }))
    }
  },

  commit: async (repoPath, message) => {
    await window.api.invoke('git:commit', repoPath, message)
    // Clear commit message and refresh status after commit
    set((s) => ({ commitMessageByPath: { ...s.commitMessageByPath, [repoPath]: '' } }))
    await get().fetch(repoPath)
  },

  stage: async (repoPath, filePath) => {
    await window.api.invoke('git:stage', repoPath, filePath)
    await get().fetch(repoPath)
  },

  unstage: async (repoPath, filePath) => {
    await window.api.invoke('git:unstage', repoPath, filePath)
    await get().fetch(repoPath)
  },

  stageAll: async (repoPath) => {
    await window.api.invoke('git:stageAll', repoPath)
    await get().fetch(repoPath)
  },

  unstageAll: async (repoPath) => {
    await window.api.invoke('git:unstageAll', repoPath)
    await get().fetch(repoPath)
  },

  stageFiles: async (repoPath, filePaths) => {
    await window.api.invoke('git:stageFiles', repoPath, filePaths)
    await get().fetch(repoPath)
  },

  setCommitMessage: (repoPath, message) => {
    set((s) => ({ commitMessageByPath: { ...s.commitMessageByPath, [repoPath]: message } }))
  },

  generateCommitMessage: async (repoPath) => {
    if (get().generatingMessageByPath[repoPath]) return
    set((s) => ({ generatingMessageByPath: { ...s.generatingMessageByPath, [repoPath]: true } }))
    try {
      const message = await window.api.invoke('git:generateCommitMessage', repoPath)
      set((s) => ({
        commitMessageByPath: { ...s.commitMessageByPath, [repoPath]: message },
        generatingMessageByPath: { ...s.generatingMessageByPath, [repoPath]: false },
      }))
    } catch {
      set((s) => ({ generatingMessageByPath: { ...s.generatingMessageByPath, [repoPath]: false } }))
    }
  },

  push: async (repoPath) => {
    if (get().pushingByPath[repoPath]) return
    set((s) => ({ pushingByPath: { ...s.pushingByPath, [repoPath]: true } }))
    try {
      await window.api.invoke('git:push', repoPath)
    } finally {
      set((s) => ({ pushingByPath: { ...s.pushingByPath, [repoPath]: false } }))
      await get().fetch(repoPath)
    }
  },

  pull: async (repoPath) => {
    if (get().pullingByPath[repoPath]) return
    set((s) => ({ pullingByPath: { ...s.pullingByPath, [repoPath]: true } }))
    try {
      await window.api.invoke('git:pull', repoPath)
    } finally {
      set((s) => ({ pullingByPath: { ...s.pullingByPath, [repoPath]: false } }))
      await get().fetch(repoPath)
    }
  },

  fetchModifiedFiles: async (threadId, workingDir) => {
    try {
      const files = await window.api.invoke('threads:getModifiedFiles', threadId, workingDir)
      set((s) => ({
        modifiedFilesByThread: { ...s.modifiedFilesByThread, [threadId]: files },
      }))
    } catch {
      // Silently ignore errors
    }
  },
}))
