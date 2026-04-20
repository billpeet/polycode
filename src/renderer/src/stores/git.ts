import { create } from 'zustand'
import { GitStatus, GitBranches, LastCommitInfo, StashEntry, PullResult } from '../types/ipc'
import { useFilesStore } from './files'

type DiscardTarget = { path: string; oldPath?: string | null }

/** Close the diff panel if it's currently showing one of the discarded paths. */
function clearDiffIfMatches(repoPath: string, paths: string[]): void {
  const diffView = useFilesStore.getState().diffView
  if (!diffView || diffView.repoPath !== repoPath) return
  if (paths.includes(diffView.filePath)) {
    useFilesStore.getState().clearDiff()
  }
}

interface GitStore {
  // Keyed by project path
  statusByPath: Record<string, GitStatus | null>
  loadingByPath: Record<string, boolean>
  /** true = confirmed not a git repo (after a fetch returned null) */
  notRepoByPath: Record<string, boolean>
  commitMessageByPath: Record<string, string>
  generatingMessageByPath: Record<string, boolean>
  pushingByPath: Record<string, boolean>
  pullingByPath: Record<string, boolean>
  refreshingRemoteByPath: Record<string, boolean>
  branchesByPath: Record<string, GitBranches | null>
  branchLoadingByPath: Record<string, boolean>
  initializingByPath: Record<string, boolean>
  lastCommitByPath: Record<string, LastCommitInfo | null>
  amendingByPath: Record<string, boolean>
  undoingCommitByPath: Record<string, boolean>
  stashesByPath: Record<string, StashEntry[]>
  stashLoadingByPath: Record<string, boolean>
  stashBusyByPath: Record<string, boolean>
  // Keyed by threadId
  modifiedFilesByThread: Record<string, string[]>

  fetch: (repoPath: string) => Promise<void>
  initRepo: (repoPath: string) => Promise<void>
  commit: (repoPath: string, message: string) => Promise<void>
  amendCommit: (repoPath: string, message?: string | null) => Promise<void>
  undoLastCommit: (repoPath: string) => Promise<void>
  fetchLastCommit: (repoPath: string) => Promise<void>
  stage: (repoPath: string, filePath: string) => Promise<void>
  unstage: (repoPath: string, filePath: string) => Promise<void>
  stageAll: (repoPath: string) => Promise<void>
  unstageAll: (repoPath: string) => Promise<void>
  stageFiles: (repoPath: string, filePaths: string[]) => Promise<void>
  discardFile: (repoPath: string, file: DiscardTarget) => Promise<void>
  discardFiles: (repoPath: string, files: DiscardTarget[]) => Promise<void>
  discardAll: (repoPath: string) => Promise<void>
  setCommitMessage: (repoPath: string, message: string) => void
  generateCommitMessage: (repoPath: string) => Promise<void>
  generateCommitMessageWithContext: (repoPath: string, filePaths: string[], context: string) => Promise<void>
  push: (repoPath: string) => Promise<void>
  pushSetUpstream: (repoPath: string, branch: string) => Promise<void>
  pull: (repoPath: string, autoStash?: boolean) => Promise<PullResult | void>
  pullOrigin: (repoPath: string) => Promise<void>
  fetchStashes: (repoPath: string) => Promise<void>
  createStash: (repoPath: string, opts: { message?: string; includeUntracked?: boolean }) => Promise<void>
  applyStash: (repoPath: string, ref: string) => Promise<void>
  popStash: (repoPath: string, ref: string) => Promise<void>
  dropStash: (repoPath: string, ref: string) => Promise<void>
  forceUnlock: (repoPath: string) => Promise<{ removed: string[] }>
  refreshRemote: (repoPath: string) => Promise<void>
  fetchModifiedFiles: (threadId: string) => Promise<void>
  fetchBranches: (repoPath: string) => Promise<void>
  checkout: (repoPath: string, branch: string) => Promise<void>
  createBranch: (repoPath: string, name: string, base: string, pullFirst: boolean) => Promise<void>
  merge: (repoPath: string, source: string) => Promise<void>
  findMergedBranches: (repoPath: string) => Promise<string[]>
  deleteBranches: (repoPath: string, branches: string[]) => Promise<{ deleted: string[]; failed: Array<{ branch: string; error: string }> }>
}

export const useGitStore = create<GitStore>((set, get) => ({
  statusByPath: {},
  loadingByPath: {},
  notRepoByPath: {},
  commitMessageByPath: {},
  generatingMessageByPath: {},
  pushingByPath: {},
  pullingByPath: {},
  refreshingRemoteByPath: {},
  branchesByPath: {},
  branchLoadingByPath: {},
  initializingByPath: {},
  lastCommitByPath: {},
  amendingByPath: {},
  undoingCommitByPath: {},
  stashesByPath: {},
  stashLoadingByPath: {},
  stashBusyByPath: {},
  modifiedFilesByThread: {},

  fetch: async (repoPath) => {
    if (get().loadingByPath[repoPath]) return
    set((s) => ({ loadingByPath: { ...s.loadingByPath, [repoPath]: true } }))
    try {
      const isRepo = await window.api.invoke('git:isRepo', repoPath)
      if (!isRepo) {
        set((s) => ({
          statusByPath: { ...s.statusByPath, [repoPath]: null },
          lastCommitByPath: { ...s.lastCommitByPath, [repoPath]: null },
          notRepoByPath: { ...s.notRepoByPath, [repoPath]: true },
          loadingByPath: { ...s.loadingByPath, [repoPath]: false },
        }))
        return
      }
      const [status, lastCommit] = await Promise.all([
        window.api.invoke('git:status', repoPath),
        window.api.invoke('git:lastCommit', repoPath),
      ])
      set((s) => ({
        statusByPath: { ...s.statusByPath, [repoPath]: status },
        lastCommitByPath: { ...s.lastCommitByPath, [repoPath]: lastCommit },
        notRepoByPath: { ...s.notRepoByPath, [repoPath]: false },
        loadingByPath: { ...s.loadingByPath, [repoPath]: false },
      }))
    } catch {
      set((s) => ({ loadingByPath: { ...s.loadingByPath, [repoPath]: false } }))
    }
  },

  fetchLastCommit: async (repoPath) => {
    try {
      const lastCommit = await window.api.invoke('git:lastCommit', repoPath)
      set((s) => ({ lastCommitByPath: { ...s.lastCommitByPath, [repoPath]: lastCommit } }))
    } catch {
      // Silently ignore — not fatal
    }
  },

  initRepo: async (repoPath) => {
    if (get().initializingByPath[repoPath]) return
    set((s) => ({ initializingByPath: { ...s.initializingByPath, [repoPath]: true } }))
    try {
      await window.api.invoke('git:init', repoPath)
      set((s) => ({ notRepoByPath: { ...s.notRepoByPath, [repoPath]: false } }))
      await get().fetch(repoPath)
    } finally {
      set((s) => ({ initializingByPath: { ...s.initializingByPath, [repoPath]: false } }))
    }
  },

  commit: async (repoPath, message) => {
    await window.api.invoke('git:commit', repoPath, message)
    // Clear commit message and refresh status after commit
    set((s) => ({ commitMessageByPath: { ...s.commitMessageByPath, [repoPath]: '' } }))
    await get().fetch(repoPath)
  },

  amendCommit: async (repoPath, message) => {
    if (get().amendingByPath[repoPath]) return
    set((s) => ({ amendingByPath: { ...s.amendingByPath, [repoPath]: true } }))
    try {
      await window.api.invoke('git:amendCommit', repoPath, message ?? null)
      set((s) => ({ commitMessageByPath: { ...s.commitMessageByPath, [repoPath]: '' } }))
      await get().fetch(repoPath)
    } finally {
      set((s) => ({ amendingByPath: { ...s.amendingByPath, [repoPath]: false } }))
    }
  },

  undoLastCommit: async (repoPath) => {
    if (get().undoingCommitByPath[repoPath]) return
    set((s) => ({ undoingCommitByPath: { ...s.undoingCommitByPath, [repoPath]: true } }))
    try {
      await window.api.invoke('git:undoLastCommit', repoPath)
      await get().fetch(repoPath)
    } finally {
      set((s) => ({ undoingCommitByPath: { ...s.undoingCommitByPath, [repoPath]: false } }))
    }
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

  discardFile: async (repoPath, file) => {
    await window.api.invoke('git:discardFile', repoPath, file.path, file.oldPath ?? null)
    clearDiffIfMatches(repoPath, [file.path, file.oldPath].filter(Boolean) as string[])
    await get().fetch(repoPath)
  },

  discardFiles: async (repoPath, files) => {
    if (files.length === 0) return
    await window.api.invoke('git:discardFiles', repoPath, files)
    const discarded = files.flatMap((f) => [f.path, f.oldPath].filter(Boolean) as string[])
    clearDiffIfMatches(repoPath, discarded)
    await get().fetch(repoPath)
  },

  discardAll: async (repoPath) => {
    await window.api.invoke('git:discardAll', repoPath)
    // Any diff view for this repo is now stale
    const diffView = useFilesStore.getState().diffView
    if (diffView && diffView.repoPath === repoPath) {
      useFilesStore.getState().clearDiff()
    }
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

  generateCommitMessageWithContext: async (repoPath, filePaths, context) => {
    if (get().generatingMessageByPath[repoPath]) return
    set((s) => ({ generatingMessageByPath: { ...s.generatingMessageByPath, [repoPath]: true } }))
    try {
      const message = await window.api.invoke('git:generateCommitMessageWithContext', repoPath, filePaths, context)
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

  pushSetUpstream: async (repoPath, branch) => {
    if (get().pushingByPath[repoPath]) return
    set((s) => ({ pushingByPath: { ...s.pushingByPath, [repoPath]: true } }))
    try {
      await window.api.invoke('git:pushSetUpstream', repoPath, branch)
    } finally {
      set((s) => ({ pushingByPath: { ...s.pushingByPath, [repoPath]: false } }))
      await get().fetch(repoPath)
    }
  },

  pull: async (repoPath, autoStash = false) => {
    if (get().pullingByPath[repoPath]) return
    set((s) => ({ pullingByPath: { ...s.pullingByPath, [repoPath]: true } }))
    try {
      const result = await window.api.invoke('git:pull', repoPath, autoStash) as PullResult | undefined
      return result
    } finally {
      set((s) => ({ pullingByPath: { ...s.pullingByPath, [repoPath]: false } }))
      await get().fetch(repoPath)
      // Auto-stash may have created/popped a stash; keep the list in sync.
      if (autoStash) void get().fetchStashes(repoPath)
    }
  },

  pullOrigin: async (repoPath) => {
    if (get().pullingByPath[repoPath]) return
    set((s) => ({ pullingByPath: { ...s.pullingByPath, [repoPath]: true } }))
    try {
      await window.api.invoke('git:pullOrigin', repoPath)
    } finally {
      set((s) => ({ pullingByPath: { ...s.pullingByPath, [repoPath]: false } }))
      await get().fetch(repoPath)
    }
  },

  fetchStashes: async (repoPath) => {
    if (get().stashLoadingByPath[repoPath]) return
    set((s) => ({ stashLoadingByPath: { ...s.stashLoadingByPath, [repoPath]: true } }))
    try {
      const stashes = await window.api.invoke('git:stashList', repoPath) as StashEntry[]
      set((s) => ({
        stashesByPath: { ...s.stashesByPath, [repoPath]: stashes },
        stashLoadingByPath: { ...s.stashLoadingByPath, [repoPath]: false },
      }))
    } catch {
      set((s) => ({ stashLoadingByPath: { ...s.stashLoadingByPath, [repoPath]: false } }))
    }
  },

  createStash: async (repoPath, opts) => {
    if (get().stashBusyByPath[repoPath]) return
    set((s) => ({ stashBusyByPath: { ...s.stashBusyByPath, [repoPath]: true } }))
    try {
      await window.api.invoke('git:stashCreate', repoPath, opts)
      await Promise.all([get().fetch(repoPath), get().fetchStashes(repoPath)])
    } finally {
      set((s) => ({ stashBusyByPath: { ...s.stashBusyByPath, [repoPath]: false } }))
    }
  },

  applyStash: async (repoPath, ref) => {
    if (get().stashBusyByPath[repoPath]) return
    set((s) => ({ stashBusyByPath: { ...s.stashBusyByPath, [repoPath]: true } }))
    try {
      await window.api.invoke('git:stashApply', repoPath, ref)
      await Promise.all([get().fetch(repoPath), get().fetchStashes(repoPath)])
    } finally {
      set((s) => ({ stashBusyByPath: { ...s.stashBusyByPath, [repoPath]: false } }))
    }
  },

  popStash: async (repoPath, ref) => {
    if (get().stashBusyByPath[repoPath]) return
    set((s) => ({ stashBusyByPath: { ...s.stashBusyByPath, [repoPath]: true } }))
    try {
      await window.api.invoke('git:stashPop', repoPath, ref)
      await Promise.all([get().fetch(repoPath), get().fetchStashes(repoPath)])
    } finally {
      set((s) => ({ stashBusyByPath: { ...s.stashBusyByPath, [repoPath]: false } }))
    }
  },

  dropStash: async (repoPath, ref) => {
    if (get().stashBusyByPath[repoPath]) return
    set((s) => ({ stashBusyByPath: { ...s.stashBusyByPath, [repoPath]: true } }))
    try {
      await window.api.invoke('git:stashDrop', repoPath, ref)
      await get().fetchStashes(repoPath)
    } finally {
      set((s) => ({ stashBusyByPath: { ...s.stashBusyByPath, [repoPath]: false } }))
    }
  },

  forceUnlock: async (repoPath) => {
    // Destructive; caller is expected to have already confirmed with the user.
    // Refresh status afterwards in case the lock was keeping our view out of date.
    const result = await window.api.invoke('git:forceUnlock', repoPath) as { removed: string[] }
    await get().fetch(repoPath)
    return result
  },

  refreshRemote: async (repoPath) => {
    if (get().refreshingRemoteByPath[repoPath]) return
    set((s) => ({ refreshingRemoteByPath: { ...s.refreshingRemoteByPath, [repoPath]: true } }))
    try {
      await window.api.invoke('git:fetchRemote', repoPath)
    } catch {
      // Ignore transient network/auth failures for background refresh.
    } finally {
      set((s) => ({ refreshingRemoteByPath: { ...s.refreshingRemoteByPath, [repoPath]: false } }))
      await get().fetch(repoPath)
    }
  },

  fetchModifiedFiles: async (threadId) => {
    try {
      const files = await window.api.invoke('threads:getModifiedFiles', threadId)
      set((s) => ({
        modifiedFilesByThread: { ...s.modifiedFilesByThread, [threadId]: files },
      }))
    } catch {
      // Silently ignore errors
    }
  },

  fetchBranches: async (repoPath) => {
    if (get().branchLoadingByPath[repoPath]) return
    set((s) => ({ branchLoadingByPath: { ...s.branchLoadingByPath, [repoPath]: true } }))
    try {
      const branches = await window.api.invoke('git:branches', repoPath)
      set((s) => ({
        branchesByPath: { ...s.branchesByPath, [repoPath]: branches },
        branchLoadingByPath: { ...s.branchLoadingByPath, [repoPath]: false },
      }))
    } catch {
      set((s) => ({ branchLoadingByPath: { ...s.branchLoadingByPath, [repoPath]: false } }))
    }
  },

  checkout: async (repoPath, branch) => {
    await window.api.invoke('git:checkout', repoPath, branch)
    await get().fetch(repoPath)
    await get().fetchBranches(repoPath)
  },

  createBranch: async (repoPath, name, base, pullFirst) => {
    await window.api.invoke('git:createBranch', repoPath, name, base, pullFirst)
    await get().fetch(repoPath)
    await get().fetchBranches(repoPath)
  },

  merge: async (repoPath, source) => {
    const result = await window.api.invoke('git:merge', repoPath, source)
    await get().fetch(repoPath) // always refresh — conflict markers show up as modified files
    if (result.conflicts.length > 0) {
      const err = new Error(`Merge conflicts in ${result.conflicts.length} file${result.conflicts.length !== 1 ? 's' : ''}`)
      ;(err as Error & { conflicts: string[] }).conflicts = result.conflicts
      throw err
    }
  },

  findMergedBranches: async (repoPath) => {
    return window.api.invoke('git:findMergedBranches', repoPath)
  },

  deleteBranches: async (repoPath, branches) => {
    const result = await window.api.invoke('git:deleteBranches', repoPath, branches)
    await get().fetchBranches(repoPath)
    return result
  },
}))
