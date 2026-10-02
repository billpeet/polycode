import { existsSync, readdirSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { Worker } from 'node:worker_threads'

const TOMBSTONE_PREFIX = '.polycode-trash-'

/**
 * Runs in a worker thread. `rmSync` there blocks only the worker: it neither
 * stalls Electron's main event loop nor occupies the libuv threadpool that
 * every other `fs` call in the main process shares.
 */
const DELETE_WORKER_SOURCE = `
const { rmSync } = require('node:fs')
const { workerData, parentPort } = require('node:worker_threads')
const failures = []
for (const path of workerData) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  } catch (error) {
    failures.push({ path, code: error && error.code ? String(error.code) : 'UNKNOWN' })
  }
}
parentPort.postMessage(failures)
`

export interface DiscardResult {
  /** Where the directory was moved before deletion, or null if it had to be deleted in place. */
  movedTo: string | null
  /** Settles when the background delete finishes. Never rejects; callers need not await it. */
  done: Promise<void>
}

/** True when `candidate` is `directory` itself or lives underneath it. */
export function isPathInside(directory: string, candidate: string): boolean {
  const normalize = (path: string) => {
    const resolved = resolve(path)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  const parent = normalize(directory)
  const child = normalize(candidate)
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

function leftoverTombstones(parentDir: string): string[] {
  try {
    return readdirSync(parentDir)
      .filter((name) => name.startsWith(TOMBSTONE_PREFIX))
      .map((name) => join(parentDir, name))
  } catch {
    return []
  }
}

function deleteInBackground(paths: string[]): Promise<void> {
  return new Promise((resolveDone) => {
    let worker: Worker
    try {
      worker = new Worker(DELETE_WORKER_SOURCE, { eval: true, workerData: paths })
    } catch (error) {
      console.warn('[worktree] Could not start background delete worker', error)
      resolveDone()
      return
    }
    worker.once('message', (failures: Array<{ path: string; code: string }>) => {
      for (const failure of failures) {
        console.warn(`[worktree] Could not delete "${failure.path}" (${failure.code}); it will be retried on the next worktree removal.`)
      }
    })
    worker.once('error', (error) => {
      console.warn('[worktree] Background delete worker failed', error)
      resolveDone()
    })
    worker.once('exit', () => resolveDone())
    // A half-deleted tombstone is swept on the next removal, so quitting need not wait.
    worker.unref()
  })
}

/**
 * Get a worktree directory out of the way now and delete it in the background.
 *
 * Grafana showed the awaited in-process `fs.rm` taking 20–40s for a worktree
 * git could not delete itself, and for that whole time every other filesystem
 * call in the main process (`locations:pathExists` among them) queued behind
 * it on the four libuv threads — the composer froze with the main thread idle.
 * A same-volume rename is near-instant, so the caller can return immediately;
 * the actual delete then happens on a worker thread.
 */
export async function discardDirectory(path: string): Promise<DiscardResult> {
  const parentDir = dirname(path)
  const stale = leftoverTombstones(parentDir)
  if (!existsSync(path)) {
    return { movedTo: null, done: stale.length > 0 ? deleteInBackground(stale) : Promise.resolve() }
  }

  const tombstone = join(parentDir, `${TOMBSTONE_PREFIX}${basename(path)}-${Date.now().toString(36)}`)
  let movedTo: string | null = null
  try {
    await rename(path, tombstone)
    movedTo = tombstone
  } catch (error) {
    // Typically EBUSY/EPERM on Windows: something still holds a handle inside.
    // Delete in place instead; whatever is locked is reported by the worker.
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : 'UNKNOWN'
    console.warn(`[worktree] Could not move "${path}" aside (${code}); deleting it in place.`)
  }
  return { movedTo, done: deleteInBackground([...stale, movedTo ?? path]) }
}
