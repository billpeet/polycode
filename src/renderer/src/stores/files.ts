import { create } from 'zustand'
import { FileEntry } from '../types/ipc'
import { useThreadStore } from './threads'
import { useUiStore } from './ui'

interface FileContent {
  content: string
  truncated: boolean
}

interface DiffView {
  repoPath: string
  filePath: string
  diff: string
  staged: boolean
  kind: 'working' | 'compareToMain' | 'commit'
  /** When present, the diff is for the file as introduced by this specific commit. */
  commitSha?: string
  /** Short SHA for display purposes when `commitSha` is set. */
  commitShortSha?: string
}

interface FilesStore {
  // File tree state per project path
  entriesByPath: Record<string, FileEntry[]>
  expandedPaths: Set<string>
  loadingPaths: Set<string>

  // Selected file preview
  selectedFilePath: string | null
  fileContent: FileContent | null
  loadingContent: boolean

  // Diff view
  diffView: DiffView | null
  loadingDiff: boolean

  // Actions
  fetchDirectory: (dirPath: string) => Promise<void>
  refreshDirectory: (dirPath: string) => Promise<void>
  toggleExpanded: (dirPath: string) => void
  selectFile: (filePath: string | null) => void
  fetchFileContent: (filePath: string) => Promise<void>
  clearSelection: () => void
  refreshSelectedFile: () => Promise<void>
  selectDiff: (repoPath: string, filePath: string, staged: boolean) => Promise<void>
  selectCompareDiffToMain: (repoPath: string, filePath: string) => Promise<void>
  selectCommitDiff: (repoPath: string, commitSha: string, commitShortSha: string, filePath: string) => Promise<void>
  refreshDiff: () => Promise<void>
  clearDiff: () => void
  switchDiffToFile: () => void
}

export const useFilesStore = create<FilesStore>((set, get) => ({
  entriesByPath: {},
  expandedPaths: new Set<string>(),
  loadingPaths: new Set<string>(),
  selectedFilePath: null,
  fileContent: null,
  loadingContent: false,
  diffView: null,
  loadingDiff: false,

  fetchDirectory: async (dirPath: string) => {
    const { loadingPaths } = get()
    if (loadingPaths.has(dirPath)) return

    set((s) => ({ loadingPaths: new Set([...s.loadingPaths, dirPath]) }))

    try {
      const entries = await window.api.invoke('files:list', dirPath) as FileEntry[]
      set((s) => ({
        entriesByPath: { ...s.entriesByPath, [dirPath]: entries },
        loadingPaths: new Set([...s.loadingPaths].filter((p) => p !== dirPath)),
      }))
    } catch {
      set((s) => ({
        loadingPaths: new Set([...s.loadingPaths].filter((p) => p !== dirPath)),
      }))
    }
  },

  refreshDirectory: async (dirPath: string) => {
    // Force-refresh: re-fetch the root dir and all currently expanded subdirs
    const { expandedPaths } = get()
    const pathsToRefresh = [dirPath, ...Array.from(expandedPaths)]

    set((s) => ({
      loadingPaths: new Set([...s.loadingPaths, ...pathsToRefresh]),
    }))

    await Promise.all(
      pathsToRefresh.map(async (p) => {
        try {
          const entries = await window.api.invoke('files:list', p) as FileEntry[]
          set((s) => ({
            entriesByPath: { ...s.entriesByPath, [p]: entries },
            loadingPaths: new Set([...s.loadingPaths].filter((lp) => lp !== p)),
          }))
        } catch {
          set((s) => ({
            loadingPaths: new Set([...s.loadingPaths].filter((lp) => lp !== p)),
          }))
        }
      })
    )
  },

  toggleExpanded: (dirPath: string) => {
    const { expandedPaths, entriesByPath, fetchDirectory } = get()
    const newExpanded = new Set(expandedPaths)

    if (newExpanded.has(dirPath)) {
      newExpanded.delete(dirPath)
    } else {
      newExpanded.add(dirPath)
      // Fetch directory contents if not already loaded
      if (!entriesByPath[dirPath]) {
        fetchDirectory(dirPath)
      }
    }

    set({ expandedPaths: newExpanded })
  },

  selectFile: (filePath: string | null) => {
    if (!filePath) {
      set({ selectedFilePath: null, fileContent: null })
      return
    }
    set({ selectedFilePath: filePath, fileContent: null })
    const thread = Object.values(useThreadStore.getState().byProject)
      .flat()
      .find((candidate) => candidate.id === useThreadStore.getState().selectedThreadId)
    if (thread?.location_id) {
      useUiStore.getState().setLocationAuxTab(thread.location_id, 'file')
    }
    get().fetchFileContent(filePath)
  },

  fetchFileContent: async (filePath: string) => {
    set({ loadingContent: true })
    try {
      const result = await window.api.invoke('files:read', filePath) as { content: string; truncated: boolean } | null
      // Only update if this is still the selected file
      if (get().selectedFilePath === filePath) {
        set({
          fileContent: result,
          loadingContent: false,
        })
      }
    } catch {
      set({ loadingContent: false })
    }
  },

  clearSelection: () => {
    set({ selectedFilePath: null, fileContent: null, diffView: null })
  },

  refreshSelectedFile: async () => {
    const { selectedFilePath } = get()
    if (!selectedFilePath) return
    await get().fetchFileContent(selectedFilePath)
  },

  selectDiff: async (repoPath: string, filePath: string, staged: boolean) => {
    set({ diffView: null, loadingDiff: true, selectedFilePath: null, fileContent: null })
    const thread = Object.values(useThreadStore.getState().byProject)
      .flat()
      .find((candidate) => candidate.id === useThreadStore.getState().selectedThreadId)
    if (thread?.location_id) {
      useUiStore.getState().setLocationAuxTab(thread.location_id, 'file')
    }
    try {
      const diff = await window.api.invoke('git:diff', repoPath, filePath, staged) as string
      set({ diffView: { repoPath, filePath, diff, staged, kind: 'working' }, loadingDiff: false })
    } catch {
      set({ loadingDiff: false })
    }
  },

  selectCompareDiffToMain: async (repoPath, filePath) => {
    set({ diffView: null, loadingDiff: true, selectedFilePath: null, fileContent: null })
    const thread = Object.values(useThreadStore.getState().byProject)
      .flat()
      .find((candidate) => candidate.id === useThreadStore.getState().selectedThreadId)
    if (thread?.location_id) {
      useUiStore.getState().setLocationAuxTab(thread.location_id, 'file')
    }
    try {
      const diff = await window.api.invoke('git:compareDiffToMain', repoPath, filePath) as string
      set({ diffView: { repoPath, filePath, diff, staged: false, kind: 'compareToMain' }, loadingDiff: false })
    } catch {
      set({ loadingDiff: false })
    }
  },

  selectCommitDiff: async (repoPath, commitSha, commitShortSha, filePath) => {
    set({ diffView: null, loadingDiff: true, selectedFilePath: null, fileContent: null })
    const thread = Object.values(useThreadStore.getState().byProject)
      .flat()
      .find((candidate) => candidate.id === useThreadStore.getState().selectedThreadId)
    if (thread?.location_id) {
      useUiStore.getState().setLocationAuxTab(thread.location_id, 'file')
    }
    try {
      const diff = await window.api.invoke('git:commitDiff', repoPath, commitSha, filePath) as string
      // Abort if the user clicked a different diff before this one resolved.
      const current = get().diffView
      if (current && current.filePath === filePath && current.commitSha && current.commitSha !== commitSha) return
      set({ diffView: { repoPath, filePath, diff, staged: false, kind: 'commit', commitSha, commitShortSha }, loadingDiff: false })
    } catch {
      set({ loadingDiff: false })
    }
  },

  refreshDiff: async () => {
    const current = get().diffView
    if (!current) return

    set({ loadingDiff: true })
    try {
      let diff = ''
      if (current.kind === 'commit' && current.commitSha) {
        diff = await window.api.invoke('git:commitDiff', current.repoPath, current.commitSha, current.filePath) as string
      } else if (current.kind === 'compareToMain') {
        diff = await window.api.invoke('git:compareDiffToMain', current.repoPath, current.filePath) as string
      } else {
        diff = await window.api.invoke('git:diff', current.repoPath, current.filePath, current.staged) as string
      }

      const latest = get().diffView
      if (
        !latest ||
        latest.repoPath !== current.repoPath ||
        latest.filePath !== current.filePath ||
        latest.kind !== current.kind ||
        latest.commitSha !== current.commitSha ||
        latest.staged !== current.staged
      ) {
        set({ loadingDiff: false })
        return
      }

      set({ diffView: { ...latest, diff }, loadingDiff: false })
    } catch {
      set({ loadingDiff: false })
    }
  },

  clearDiff: () => {
    set({ diffView: null })
  },

  switchDiffToFile: () => {
    const { diffView, selectFile } = get()
    if (!diffView) return
    const fullPath = diffView.repoPath + '/' + diffView.filePath
    set({ diffView: null })
    selectFile(fullPath)
  },
}))
