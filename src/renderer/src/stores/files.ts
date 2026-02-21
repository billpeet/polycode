import { create } from 'zustand'
import { FileEntry } from '../types/ipc'

interface FileContent {
  content: string
  truncated: boolean
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

  // Actions
  fetchDirectory: (dirPath: string) => Promise<void>
  toggleExpanded: (dirPath: string) => void
  selectFile: (filePath: string | null) => void
  fetchFileContent: (filePath: string) => Promise<void>
  clearSelection: () => void
}

export const useFilesStore = create<FilesStore>((set, get) => ({
  entriesByPath: {},
  expandedPaths: new Set<string>(),
  loadingPaths: new Set<string>(),
  selectedFilePath: null,
  fileContent: null,
  loadingContent: false,

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
    set({ selectedFilePath: null, fileContent: null })
  },
}))
