import { watch, existsSync, statSync, FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import { BrowserWindow } from 'electron'

interface FileWatchEntry {
  watcher: FSWatcher
  refCount: number
  debounceTimer: ReturnType<typeof setTimeout> | null
}

const watchers = new Map<string, FileWatchEntry>()

function closeWatchEntry(filePath: string, entry: FileWatchEntry): void {
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
  entry.watcher.close()
  watchers.delete(filePath)
}

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
            modifiedAt: exists ? safeMtimeMs(filePath) : Date.now(),
            deleted: !exists,
          })
        }
      }, 200)
    })

    watchers.set(filePath, { watcher, refCount: 1, debounceTimer: null })
    watcher.on('error', (error: NodeJS.ErrnoException) => {
      const current = watchers.get(filePath)
      if (current) closeWatchEntry(filePath, current)

      if (error.code === 'EPERM' || error.code === 'ENOENT') {
        console.warn('[file-watch] watcher stopped', {
          filePath,
          parentDir,
          code: error.code,
          message: error.message,
        })
        return
      }

      console.error('[file-watch] watcher failed', {
        filePath,
        parentDir,
        code: error.code,
        message: error.message,
        stack: error.stack,
      })
    })
    return true
  } catch (error) {
    console.warn('[file-watch] failed to start watcher', {
      filePath,
      parentDir,
      error,
    })
    return false
  }
}

export function stopFileWatch(filePath: string): void {
  const existing = watchers.get(filePath)
  if (!existing) return

  existing.refCount -= 1
  if (existing.refCount > 0) return

  closeWatchEntry(filePath, existing)
}

export function stopAllFileWatches(): void {
  for (const [filePath, entry] of watchers) {
    closeWatchEntry(filePath, entry)
  }
}

function safeMtimeMs(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return Date.now()
  }
}
