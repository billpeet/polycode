import { watch, existsSync, statSync, FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import { BrowserWindow } from 'electron'

interface FileWatchEntry {
  watcher: FSWatcher
  refCount: number
  debounceTimer: ReturnType<typeof setTimeout> | null
}

const watchers = new Map<string, FileWatchEntry>()

export function startFileWatch(win: BrowserWindow, filePath: string): boolean {
  const existing = watchers.get(filePath)
  if (existing) {
    existing.refCount += 1
    return true
  }

  const parentDir = dirname(filePath)
  const targetName = basename(filePath)
  if (!existsSync(parentDir)) return false

  try {
    const watcher = watch(parentDir, (_eventType, changedName) => {
      if (typeof changedName !== 'string' || changedName !== targetName) return

      const current = watchers.get(filePath)
      if (!current) return
      if (current.debounceTimer) clearTimeout(current.debounceTimer)

      current.debounceTimer = setTimeout(() => {
        const latest = watchers.get(filePath)
        if (!latest) return
        latest.debounceTimer = null

        if (!win.isDestroyed()) {
          const exists = existsSync(filePath)
          win.webContents.send('files:changed', {
            path: filePath,
            modifiedAt: exists ? statSync(filePath).mtimeMs : Date.now(),
            deleted: !exists,
          })
        }
      }, 200)
    })

    watchers.set(filePath, { watcher, refCount: 1, debounceTimer: null })
    return true
  } catch {
    return false
  }
}

export function stopFileWatch(filePath: string): void {
  const existing = watchers.get(filePath)
  if (!existing) return

  existing.refCount -= 1
  if (existing.refCount > 0) return

  if (existing.debounceTimer) clearTimeout(existing.debounceTimer)
  existing.watcher.close()
  watchers.delete(filePath)
}

export function stopAllFileWatches(): void {
  for (const [filePath, entry] of watchers) {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    entry.watcher.close()
    watchers.delete(filePath)
  }
}
