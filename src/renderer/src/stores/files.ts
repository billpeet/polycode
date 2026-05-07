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

  // Selected file preview (scoped by location; legacy fields mirror the current location)
  selectedFilePath: string | null
  fileContent: FileContent | null
  loadingContent: boolean
  selectedFilePathByLocation: Record<string, string | null>
  fileContentByLocation: Record<string, FileContent | null>
  loadingContentByLocation: Record<string, boolean>

  // Diff view (scoped by location; legacy fields mirror the current location)
  diffView: DiffView | null
  loadingDiff: boolean
  diffViewByLocation: Record<string, DiffView | null>
  loadingDiffByLocation: Record<string, boolean>

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

function getCurrentLocationId(): string | null {
  const threadState = useThreadStore.getState()
  if (!threadState.selectedThreadId) return null
  for (const threads of Object.values(threadState.byProject)) {
    const thread = threads.find((candidate) => candidate.id === threadState.selectedThreadId)
    if (thread) return thread.location_id ?? null
  }
  return null
}

export const useFilesStore = create<FilesStore>((set, get) => ({
  entriesByPath: {},
  expandedPaths: new Set<string>(),
  loadingPaths: new Set<string>(),
  selectedFilePath: null,
  fileContent: null,
  loadingContent: false,
  selectedFilePathByLocation: {},
  fileContentByLocation: {},
  loadingContentByLocation: {},
  diffView: null,
  loadingDiff: false,
  diffViewByLocation: {},
  loadingDiffByLocation: {},

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
    const locationId = getCurrentLocationId()
    if (!filePath) {
      set((s) => ({
        selectedFilePath: null,
        fileContent: null,
        selectedFilePathByLocation: locationId ? { ...s.selectedFilePathByLocation, [locationId]: null } : s.selectedFilePathByLocation,
        fileContentByLocation: locationId ? { ...s.fileContentByLocation, [locationId]: null } : s.fileContentByLocation,
      }))
      return
    }
    set((s) => ({
      selectedFilePath: filePath,
      fileContent: null,
      diffView: null,
      selectedFilePathByLocation: locationId ? { ...s.selectedFilePathByLocation, [locationId]: filePath } : s.selectedFilePathByLocation,
      fileContentByLocation: locationId ? { ...s.fileContentByLocation, [locationId]: null } : s.fileContentByLocation,
      diffViewByLocation: locationId ? { ...s.diffViewByLocation, [locationId]: null } : s.diffViewByLocation,
    }))
    if (locationId) {
      useUiStore.getState().setLocationAuxTab(locationId, 'file')
    }
    get().fetchFileContent(filePath)
  },

  fetchFileContent: async (filePath: string) => {
    const locationId = getCurrentLocationId()
    set((s) => ({
      loadingContent: true,
      loadingContentByLocation: locationId ? { ...s.loadingContentByLocation, [locationId]: true } : s.loadingContentByLocation,
    }))
    try {
      const result = await window.api.invoke('files:read', filePath) as { content: string; truncated: boolean } | null
      if (get().selectedFilePathByLocation[locationId ?? ''] === filePath || get().selectedFilePath === filePath) {
        set((s) => ({
          fileContent: result,
          loadingContent: false,
          fileContentByLocation: locationId ? { ...s.fileContentByLocation, [locationId]: result } : s.fileContentByLocation,
          loadingContentByLocation: locationId ? { ...s.loadingContentByLocation, [locationId]: false } : s.loadingContentByLocation,
        }))
      }
    } catch {
      set((s) => ({
        loadingContent: false,
        loadingContentByLocation: locationId ? { ...s.loadingContentByLocation, [locationId]: false } : s.loadingContentByLocation,
      }))
    }
  },

  clearSelection: () => {
    const locationId = getCurrentLocationId()
    set((s) => ({
      selectedFilePath: null,
      fileContent: null,
      diffView: null,
      selectedFilePathByLocation: locationId ? { ...s.selectedFilePathByLocation, [locationId]: null } : s.selectedFilePathByLocation,
      fileContentByLocation: locationId ? { ...s.fileContentByLocation, [locationId]: null } : s.fileContentByLocation,
      diffViewByLocation: locationId ? { ...s.diffViewByLocation, [locationId]: null } : s.diffViewByLocation,
    }))
  },

  refreshSelectedFile: async () => {
    const locationId = getCurrentLocationId()
    const selectedFilePath = (locationId && get().selectedFilePathByLocation[locationId]) || get().selectedFilePath
    if (!selectedFilePath) return
    await get().fetchFileContent(selectedFilePath)
  },

  selectDiff: async (repoPath: string, filePath: string, staged: boolean) => {
    const locationId = getCurrentLocationId()
    set((s) => ({ diffView: null, loadingDiff: true, selectedFilePath: null, fileContent: null,
      diffViewByLocation: locationId ? { ...s.diffViewByLocation, [locationId]: null } : s.diffViewByLocation,
      loadingDiffByLocation: locationId ? { ...s.loadingDiffByLocation, [locationId]: true } : s.loadingDiffByLocation,
      selectedFilePathByLocation: locationId ? { ...s.selectedFilePathByLocation, [locationId]: null } : s.selectedFilePathByLocation,
      fileContentByLocation: locationId ? { ...s.fileContentByLocation, [locationId]: null } : s.fileContentByLocation,
    }))
    if (locationId) useUiStore.getState().setLocationAuxTab(locationId, 'diff')
    try {
      const diff = await window.api.invoke('git:diff', repoPath, filePath, staged) as string
      const next = { repoPath, filePath, diff, staged, kind: 'working' as const }
      set((s) => ({ diffView: next, loadingDiff: false, diffViewByLocation: locationId ? { ...s.diffViewByLocation, [locationId]: next } : s.diffViewByLocation, loadingDiffByLocation: locationId ? { ...s.loadingDiffByLocation, [locationId]: false } : s.loadingDiffByLocation }))
    } catch {
      set((s) => ({ loadingDiff: false, loadingDiffByLocation: locationId ? { ...s.loadingDiffByLocation, [locationId]: false } : s.loadingDiffByLocation }))
    }
  },

  selectCompareDiffToMain: async (repoPath, filePath) => {
    const locationId = getCurrentLocationId()
    set((s) => ({ diffView: null, loadingDiff: true, selectedFilePath: null, fileContent: null,
      diffViewByLocation: locationId ? { ...s.diffViewByLocation, [locationId]: null } : s.diffViewByLocation,
      loadingDiffByLocation: locationId ? { ...s.loadingDiffByLocation, [locationId]: true } : s.loadingDiffByLocation,
      selectedFilePathByLocation: locationId ? { ...s.selectedFilePathByLocation, [locationId]: null } : s.selectedFilePathByLocation,
      fileContentByLocation: locationId ? { ...s.fileContentByLocation, [locationId]: null } : s.fileContentByLocation,
    }))
    if (locationId) useUiStore.getState().setLocationAuxTab(locationId, 'diff')
    try {
      const diff = await window.api.invoke('git:compareDiffToMain', repoPath, filePath) as string
      const next = { repoPath, filePath, diff, staged: false, kind: 'compareToMain' as const }
      set((s) => ({ diffView: next, loadingDiff: false, diffViewByLocation: locationId ? { ...s.diffViewByLocation, [locationId]: next } : s.diffViewByLocation, loadingDiffByLocation: locationId ? { ...s.loadingDiffByLocation, [locationId]: false } : s.loadingDiffByLocation }))
    } catch {
      set((s) => ({ loadingDiff: false, loadingDiffByLocation: locationId ? { ...s.loadingDiffByLocation, [locationId]: false } : s.loadingDiffByLocation }))
    }
  },

  selectCommitDiff: async (repoPath, commitSha, commitShortSha, filePath) => {
    const locationId = getCurrentLocationId()
    set((s) => ({ diffView: null, loadingDiff: true, selectedFilePath: null, fileContent: null,
      diffViewByLocation: locationId ? { ...s.diffViewByLocation, [locationId]: null } : s.diffViewByLocation,
      loadingDiffByLocation: locationId ? { ...s.loadingDiffByLocation, [locationId]: true } : s.loadingDiffByLocation,
      selectedFilePathByLocation: locationId ? { ...s.selectedFilePathByLocation, [locationId]: null } : s.selectedFilePathByLocation,
      fileContentByLocation: locationId ? { ...s.fileContentByLocation, [locationId]: null } : s.fileContentByLocation,
    }))
    if (locationId) useUiStore.getState().setLocationAuxTab(locationId, 'diff')
    try {
      const diff = await window.api.invoke('git:commitDiff', repoPath, commitSha, filePath) as string
      const current = locationId ? get().diffViewByLocation[locationId] : get().diffView
      if (current && current.filePath === filePath && current.commitSha && current.commitSha !== commitSha) return
      const next = { repoPath, filePath, diff, staged: false, kind: 'commit' as const, commitSha, commitShortSha }
      set((s) => ({ diffView: next, loadingDiff: false, diffViewByLocation: locationId ? { ...s.diffViewByLocation, [locationId]: next } : s.diffViewByLocation, loadingDiffByLocation: locationId ? { ...s.loadingDiffByLocation, [locationId]: false } : s.loadingDiffByLocation }))
    } catch {
      set((s) => ({ loadingDiff: false, loadingDiffByLocation: locationId ? { ...s.loadingDiffByLocation, [locationId]: false } : s.loadingDiffByLocation }))
    }
  },

  refreshDiff: async () => {
    const locationId = getCurrentLocationId()
    const current = (locationId && get().diffViewByLocation[locationId]) || get().diffView
    if (!current) return

    set((s) => ({ loadingDiff: true, loadingDiffByLocation: locationId ? { ...s.loadingDiffByLocation, [locationId]: true } : s.loadingDiffByLocation }))
    try {
      let diff = ''
      if (current.kind === 'commit' && current.commitSha) {
        diff = await window.api.invoke('git:commitDiff', current.repoPath, current.commitSha, current.filePath) as string
      } else if (current.kind === 'compareToMain') {
        diff = await window.api.invoke('git:compareDiffToMain', current.repoPath, current.filePath) as string
      } else {
        diff = await window.api.invoke('git:diff', current.repoPath, current.filePath, current.staged) as string
      }

      const latest = (locationId && get().diffViewByLocation[locationId]) || get().diffView
      if (
        !latest ||
        latest.repoPath !== current.repoPath ||
        latest.filePath !== current.filePath ||
        latest.kind !== current.kind ||
        latest.commitSha !== current.commitSha ||
        latest.staged !== current.staged
      ) {
        set((s) => ({ loadingDiff: false, loadingDiffByLocation: locationId ? { ...s.loadingDiffByLocation, [locationId]: false } : s.loadingDiffByLocation }))
        return
      }

      const next = { ...latest, diff }
      set((s) => ({ diffView: next, loadingDiff: false, diffViewByLocation: locationId ? { ...s.diffViewByLocation, [locationId]: next } : s.diffViewByLocation, loadingDiffByLocation: locationId ? { ...s.loadingDiffByLocation, [locationId]: false } : s.loadingDiffByLocation }))
    } catch {
      set((s) => ({ loadingDiff: false, loadingDiffByLocation: locationId ? { ...s.loadingDiffByLocation, [locationId]: false } : s.loadingDiffByLocation }))
    }
  },

  clearDiff: () => {
    const locationId = getCurrentLocationId()
    set((s) => ({
      diffView: null,
      diffViewByLocation: locationId ? { ...s.diffViewByLocation, [locationId]: null } : s.diffViewByLocation,
    }))
  },

  switchDiffToFile: () => {
    const { diffView, selectFile } = get()
    if (!diffView) return
    const fullPath = diffView.repoPath + '/' + diffView.filePath
    set({ diffView: null })
    selectFile(fullPath)
  },
}))
