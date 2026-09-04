import { watch, existsSync, statSync, FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import { BrowserWindow } from 'electron'
import { emitAppEvent } from './app-events'

interface FileWatchEntry {
  watcher: FSWatcher
  refCount: number
  debounceTimer: ReturnType<typeof setTimeout> | null
}

interface RepoWatchEntry {
  watcher: FSWatcher
  refCount: number
  debounceTimer: ReturnType<typeof setTimeout> | null
}

const watchers = new Map<string, FileWatchEntry>()
const repoWatchers = new Map<string, RepoWatchEntry>()

/**
 * Trailing-throttle window for `git:repoChanged`. The old behaviour was a resettable 1s
 * debounce: during an active agent run the worktree is written continuously, so the debounce
 * either never settled or fired every ~1.75s forever — the renderer then ran its
 * isRepo→status→head refresh chain on every tick (observed fleet-wide at up to ~850
 * `git:status` IPC calls per second). A throttle guarantees at most one emit per window and
 * always settles.
 */
const REPO_CHANGE_THROTTLE_MS = 5_000

/**
 * Path segments whose churn says nothing about git state the UI shows. `.git/objects` (and
 * pack files under it) is written on every fetch/gc without changing status output;
 * `node_modules` is the classic build-noise firehose.
 */
const REPO_NOISE_SEGMENT = /(^|[\\/])(node_modules|\.git[\\/]objects)([\\/]|$)/

function closeWatchEntry(filePath: string, entry: FileWatchEntry): void {
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
  entry.watcher.close()
  watchers.delete(filePath)
}

function closeRepoWatchEntry(repoPath: string, entry: RepoWatchEntry): void {
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
  entry.watcher.close()
  repoWatchers.delete(repoPath)
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
          emitAppEvent(win, 'files:changed', {
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
  for (const [repoPath, entry] of repoWatchers) {
    closeRepoWatchEntry(repoPath, entry)
  }
}

export function startRepoGitWatch(win: BrowserWindow, repoPath: string): boolean {
  const existing = repoWatchers.get(repoPath)
  if (existing) {
    existing.refCount += 1
    return true
  }

  if (!existsSync(repoPath)) return false

  try {
    // Trailing throttle, not a debounce: the first change schedules one emit and later
    // changes inside the window collapse into it. Freshness of the *data* behind the emit is
    // the job of the git read cache's TTL (git.ts), which this watcher deliberately no longer
    // invalidates — see the `git:watchStart` handler.
    const watcher = watch(repoPath, { recursive: true }, (_eventType, changedName) => {
      if (typeof changedName === 'string' && REPO_NOISE_SEGMENT.test(changedName)) return

      const current = repoWatchers.get(repoPath)
      if (!current || current.debounceTimer) return

      current.debounceTimer = setTimeout(() => {
        const latest = repoWatchers.get(repoPath)
        if (!latest) return
        latest.debounceTimer = null

        if (!win.isDestroyed()) {
          emitAppEvent(win, 'git:repoChanged', {
            path: repoPath,
            changedAt: Date.now(),
          })
        }
      }, REPO_CHANGE_THROTTLE_MS)
    })

    repoWatchers.set(repoPath, { watcher, refCount: 1, debounceTimer: null })
    watcher.on('error', (error: NodeJS.ErrnoException) => {
      const current = repoWatchers.get(repoPath)
      if (current) closeRepoWatchEntry(repoPath, current)

      if (error.code === 'EPERM' || error.code === 'ENOENT') {
        console.warn('[repo-watch] watcher stopped', {
          repoPath,
          code: error.code,
          message: error.message,
        })
        return
      }

      console.error('[repo-watch] watcher failed', {
        repoPath,
        code: error.code,
        message: error.message,
        stack: error.stack,
      })
    })
    return true
  } catch (error) {
    console.warn('[repo-watch] failed to start watcher', {
      repoPath,
      error,
    })
    return false
  }
}

export function stopRepoGitWatch(repoPath: string): void {
  const existing = repoWatchers.get(repoPath)
  if (!existing) return

  existing.refCount -= 1
  if (existing.refCount > 0) return

  closeRepoWatchEntry(repoPath, existing)
}

function safeMtimeMs(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return Date.now()
  }
}
