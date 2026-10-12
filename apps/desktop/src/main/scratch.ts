/**
 * Scratch Directories: where a Thread with no Project Location is conducted.
 *
 * Each such Thread gets its own directory, `~/.polycode/scratch/<threadId>`, on the
 * machine running the main process. The directory is derived from the thread id rather
 * than stored, so it needs no schema, and it lives exactly as long as the Thread does:
 * created on demand, removed when the Thread is deleted.
 *
 * There is deliberately no "sweep directories whose thread is gone" pass. Development
 * and production profiles keep separate databases but share this root, so a sweep run
 * by one would delete the other's live directories.
 */
import { mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Thread ids reach this module from remote clients as well as the database, and one is
 * about to become a path segment handed to a recursive delete. Anything that is not a
 * plain token (`..`, a separator, an empty string) is refused.
 */
const SAFE_THREAD_ID = /^[A-Za-z0-9_-]+$/

export function scratchRoot(): string {
  return join(homedir(), '.polycode', 'scratch')
}

/** The Scratch Directory for a thread, or null when the id cannot safely name one. */
export function scratchDirForThread(threadId: string): string | null {
  return SAFE_THREAD_ID.test(threadId) ? join(scratchRoot(), threadId) : null
}

/** Like `scratchDirForThread`, but the directory exists when this returns. */
export function ensureScratchDir(threadId: string): string | null {
  const dir = scratchDirForThread(threadId)
  if (dir) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Delete a thread's Scratch Directory, if it has one. Never rejects: a directory that
 * cannot be removed (a file inside it is open, say) must not fail the thread deletion
 * that triggered this.
 */
export async function removeScratchDir(threadId: string): Promise<void> {
  const dir = scratchDirForThread(threadId)
  if (!dir) return
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  } catch (error) {
    console.warn(`[scratch] Could not remove "${dir}":`, error)
  }
}
