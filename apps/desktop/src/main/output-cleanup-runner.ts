import { statSync } from 'node:fs'
import { getDatabasePath, getDb } from './db/index'
import { getSetting, setSetting } from './db/queries'
import { OutputCleanup, type OutputCleanupState } from './db/output-cleanup'
import type { StorageInfo } from '../shared/types'

/** Runs the one-time Codex output cleanup (`db/output-cleanup.ts`) in the background. */

const STATE_KEY = 'maintenance.codex-output-cleanup'
/** Leave startup alone: the first windows wait until the app has settled. */
const START_DELAY_MS = 30_000
/** Work per step: short enough that nothing else on the main process notices. */
const STEP_MS = 25
/** Between steps, so the main process spends most of its time on everything else. */
const PAUSE_MS = 75
/** Save progress this often; a restart redoes at most this much work. */
const SAVE_EVERY_MS = 5_000

let timer: ReturnType<typeof setTimeout> | null = null
let running = false
let cleanup: OutputCleanup | null = null
let savedAt = 0

export function readOutputCleanupState(): OutputCleanupState | null {
  const raw = getSetting(STATE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as OutputCleanupState
  } catch {
    return null
  }
}

function step(): void {
  timer = null
  if (!running) return
  try {
    if (!cleanup) {
      const db = getDb('outputCleanup')
      cleanup = new OutputCleanup(db, readOutputCleanupState() ?? OutputCleanup.begin(db))
    }
    const state = cleanup.step(STEP_MS)
    if (state.done || Date.now() - savedAt >= SAVE_EVERY_MS) {
      setSetting(STATE_KEY, JSON.stringify(state))
      savedAt = Date.now()
    }
    if (state.done) {
      running = false
      cleanup = null
      console.info(`[db] Codex output cleanup finished: ${state.deletedRows} rows removed`)
      return
    }
    timer = setTimeout(step, PAUSE_MS)
  } catch (error) {
    // Retried from where it stopped at the next launch.
    running = false
    console.warn('[db] Codex output cleanup paused after an error', error)
  }
}

export function startOutputCleanupRunner(): void {
  if (running || readOutputCleanupState()?.done) return
  running = true
  console.info('[db] Codex output cleanup scheduled')
  timer = setTimeout(step, START_DELAY_MS)
}

export function stopOutputCleanupRunner(): void {
  running = false
  if (timer) clearTimeout(timer)
  timer = null
  // Keep the progress made since the last save; the database closes after this.
  if (cleanup) {
    try {
      setSetting(STATE_KEY, JSON.stringify(cleanup.current))
    } catch {
      // Shutdown may already have closed the database; a restart redoes a few seconds.
    }
    cleanup = null
  }
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

export function getStorageInfo(): StorageInfo {
  const db = getDb('storageInfo')
  const pageSize = db.pragma('page_size', { simple: true }) as number
  const freePages = db.pragma('freelist_count', { simple: true }) as number
  const path = getDatabasePath()
  const state = cleanup?.current ?? readOutputCleanupState()
  return {
    fileBytes: fileBytes(path) + fileBytes(`${path}-wal`),
    freeBytes: pageSize * freePages,
    cleanup: state
      ? { done: state.done, progress: state.end > 0 ? Math.min(state.cursor / state.end, 1) : 1, deletedRows: state.deletedRows }
      : { done: false, progress: 0, deletedRows: 0 },
  }
}

/**
 * Rewrite the database file without its free pages. Blocks the main process for as
 * long as it takes (about a minute per few GB), so it only ever runs on request.
 */
export function compactDatabase(): StorageInfo {
  const db = getDb('compactDatabase')
  db.exec('VACUUM')
  db.pragma('wal_checkpoint(TRUNCATE)')
  return getStorageInfo()
}
