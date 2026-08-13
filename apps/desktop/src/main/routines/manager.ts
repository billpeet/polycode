/**
 * Routine scheduler and Run lifecycle.
 *
 * A Routine is a standing definition of automated work; each firing spawns a
 * Run: a hidden Thread on a fresh worktree branched off origin/<default>.
 *
 * Run lifecycle (see docs/adr/0001-run-success-is-git-clean.md):
 * - session idle + clean worktree + nothing unpushed → success, worktree destroyed
 * - anything else (error, pending prompt, unshipped work, interruption)
 *   → escalated: surfaces in the normal sidebar, worktree retained.
 */
import { BrowserWindow, Notification, powerMonitor } from 'electron'
import {
  Routine,
  ThreadStatus,
} from '../../shared/types'
import {
  createThread,
  getLocationById,
  getRoutine,
  getThreadById,
  hasActiveRun,
  listActiveRuns,
  listAllRoutines,
  listRuns,
  markRoutineFired,
  setRoutineEnabled,
  setRunState,
  updateThreadLocationId,
} from '../db/queries'
import { createLocalWorktree, removeWorktreeLocation } from '../project-admin'
import { createRunner } from '../driver/runner'
import { runGit as executeGit } from '../git-runner'
import { sessionManager } from '../session/manager'
import { emitAppEvent, onAppEvent } from '../app-events'
import { windowsPathToWsl } from '../path-utils'
import { mostRecentFireTime } from './cron'

const TICK_INTERVAL_MS = 30_000

function runGit(args: string[], cwd: string): Promise<string> {
  return executeGit(createRunner({}), cwd, args)
}

function sanitizeSegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'routine'
}

class RoutineManager {
  private window: BrowserWindow | null = null
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private unsubscribe: (() => void) | null = null

  start(window: BrowserWindow): void {
    this.window = window
    this.escalateInterruptedRuns()

    // Watch state lives in the DB, not in memory: any thread with a routine_id
    // in a non-terminal run_state is evaluated when its session completes a
    // turn. This makes escalated runs from previous app sessions re-evaluable
    // with no re-registration.
    this.unsubscribe = onAppEvent((event) => {
      const match = /^thread:complete:(.+)$/.exec(event.channel)
      if (!match) return
      const threadId = match[1]
      const thread = getThreadById(threadId)
      if (!thread?.routine_id || (thread.run_state !== 'active' && thread.run_state !== 'escalated')) return
      const status = event.args[0] as ThreadStatus
      void this.onRunComplete(threadId, thread.routine_id, status)
    })

    this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS)
    powerMonitor.on('resume', () => void this.tick())
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /**
   * Runs still marked active at startup were interrupted by an app quit or
   * crash — their sessions died with the process. They escalate; auto-resuming
   * a half-done agentic session is not safe.
   */
  private escalateInterruptedRuns(): void {
    for (const run of listActiveRuns()) {
      this.escalate(run.id, run.routine_id!, 'Run was interrupted — the app closed while it was in progress.', { notify: false })
    }
  }

  /**
   * One rule covers live firing, launch catch-up, and wake catch-up: fire when
   * the most recent scheduled time is after the routine's last firing. This
   * caps catch-up at a single missed instance (the latest) by construction.
   */
  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = new Date()
      for (const routine of listAllRoutines()) {
        if (!routine.enabled) continue
        try {
          if (routine.trigger_type === 'cron' && routine.schedule) {
            const due = mostRecentFireTime(routine.schedule, now)
            if (!due) continue
            const lastFired = routine.last_fired_at ?? routine.created_at
            if (due.toISOString() > lastFired) await this.fire(routine, 'schedule')
          } else if (routine.trigger_type === 'once' && routine.schedule) {
            // Same rule as cron: fire when the scheduled moment has passed and
            // the last firing (manual runs included) predates it. After firing,
            // last_fired_at >= schedule, so it cannot fire twice — and a manual
            // run BEFORE the scheduled time doesn't suppress the scheduled one.
            const due = routine.schedule <= now.toISOString()
            const alreadyFired = routine.last_fired_at !== null && routine.last_fired_at >= routine.schedule
            if (due && !alreadyFired) {
              await this.fire(routine, 'schedule')
              // A spent one-off disables itself; re-arm by editing the routine.
              setRoutineEnabled(routine.id, false)
              this.notifyRenderer()
            }
          }
        } catch (error) {
          console.error(`[routines] Failed to fire routine "${routine.name}":`, error)
        }
      }
    } finally {
      this.ticking = false
    }
  }

  /** Manual trigger. Returns the run's thread id (existing one if a run is active). */
  async runNow(routineId: string): Promise<string> {
    const routine = getRoutine(routineId)
    if (!routine) throw new Error('Routine not found')
    if (hasActiveRun(routineId)) {
      const active = listRuns(routineId).find((r) => r.run_state === 'active')
      if (active) return active.id
    }
    return this.fire(routine, 'manual')
  }

  /**
   * Spawn a Run: fetch, worktree off origin/<default>, hidden thread, prompt.
   * The thread is created first so any setup failure has a Run to escalate.
   */
  private async fire(routine: Routine, trigger: 'schedule' | 'manual'): Promise<string> {
    if (trigger === 'schedule' && hasActiveRun(routine.id)) {
      console.warn(`[routines] Skipping firing of "${routine.name}": previous run still active.`)
      markRoutineFired(routine.id, new Date().toISOString())
      return ''
    }

    const firedAt = new Date()
    markRoutineFired(routine.id, firedAt.toISOString())

    const runName = `${routine.name} — ${firedAt.toLocaleString()}`
    const thread = createThread(
      routine.project_id, runName, routine.location_id, routine.provider, routine.model, null,
      { routineId: routine.id, permissionMode: routine.permission_mode }
    )
    this.notifyRenderer()

    try {
      const parent = getLocationById(routine.location_id)
      if (!parent) throw new Error('The routine’s location no longer exists.')
      if (parent.connection_type !== 'local') throw new Error('Routines currently support local locations only.')

      // Runs must branch off the remote default branch, fetched at fire time —
      // running against a stale local main is a silent footgun. Offline = escalate.
      let baseRef: string
      try {
        await runGit(['fetch', 'origin'], parent.path)
        baseRef = await this.resolveOriginDefault(parent.path)
      } catch (error) {
        throw new Error(`Could not fetch origin before the run: ${error instanceof Error ? error.message : String(error)}`)
      }

      const label = `${sanitizeSegment(routine.name)}-${firedAt.getTime().toString(36)}`
      const worktree = await createLocalWorktree(routine.location_id, label, baseRef)
      updateThreadLocationId(thread.id, worktree.id)

      let effectiveDir = worktree.path
      if (worktree.connection_type === 'wsl' && /^[A-Za-z]:[/\\]/.test(effectiveDir)) {
        effectiveDir = windowsPathToWsl(effectiveDir)
      }
      const win = this.window
      if (!win) throw new Error('No window available to host the run session.')
      const session = sessionManager.getOrCreate(thread.id, effectiveDir, win, worktree.ssh ?? null, worktree.wsl ?? null)
      void session.sendMessage(routine.prompt)
      return thread.id
    } catch (error) {
      this.escalate(thread.id, routine.id, error instanceof Error ? error.message : String(error))
      return thread.id
    }
  }

  private async resolveOriginDefault(repoPath: string): Promise<string> {
    try {
      const head = (await runGit(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repoPath)).trim()
      if (head.startsWith('refs/remotes/')) return head.slice('refs/remotes/'.length)
    } catch {
      // origin/HEAD not set locally — fall back to conventional names.
    }
    for (const ref of ['origin/main', 'origin/master']) {
      try {
        await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoPath)
        return ref
      } catch {
        // Try the next conventional default branch ref.
      }
    }
    throw new Error('Could not resolve the default branch on origin.')
  }

  /**
   * Session finished a turn. Success requires a mechanically clean worktree;
   * everything else escalates. Escalated runs stay watched so that, after the
   * user interacts and the session goes idle again, evaluation reruns.
   */
  private async onRunComplete(threadId: string, routineId: string, status: ThreadStatus): Promise<void> {
    if (status !== 'idle') {
      const reasons: Partial<Record<ThreadStatus, string>> = {
        error: 'The run ended with an error.',
        stopped: 'The run was stopped.',
        plan_pending: 'The run is waiting for plan approval.',
        question_pending: 'The run is waiting for an answer to a question.',
        permission_pending: 'The run is waiting for a permission decision.',
      }
      this.escalate(threadId, routineId, reasons[status] ?? `The run ended in state "${status}".`)
      return
    }

    try {
      const location = this.runWorktree(threadId)
      if (!location) {
        // No worktree (setup failed earlier, or already cleaned) — nothing to lose.
        this.succeed(threadId, routineId, null)
        return
      }
      const porcelain = (await runGit(['status', '--porcelain'], location.path)).trim()
      const unpushed = (await runGit(['rev-list', '--count', 'HEAD', '--not', '--remotes'], location.path)).trim()
      if (porcelain === '' && unpushed === '0') {
        this.succeed(threadId, routineId, location.id)
      } else {
        const parts: string[] = []
        if (porcelain !== '') parts.push('uncommitted changes')
        if (unpushed !== '0') parts.push(`${unpushed} unpushed commit${unpushed === '1' ? '' : 's'}`)
        this.escalate(threadId, routineId, `The run finished with unshipped work (${parts.join(' and ')}). The worktree has been kept.`)
      }
    } catch (error) {
      this.escalate(threadId, routineId, `Could not evaluate the run’s git state: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private runWorktree(threadId: string) {
    const run = getThreadById(threadId)
    if (!run?.location_id) return null
    const location = getLocationById(run.location_id)
    return location?.is_worktree ? location : null
  }

  private succeed(threadId: string, routineId: string, worktreeLocationId: string | null): void {
    setRunState(threadId, 'success')
    sessionManager.remove(threadId)
    if (worktreeLocationId) {
      void removeWorktreeLocation(worktreeLocationId).catch((error) => {
        console.error('[routines] Failed to remove run worktree:', error)
        setRunState(threadId, 'escalated', 'The run succeeded but its worktree could not be removed.')
        this.notifyRenderer()
      })
    }
    console.log(`[routines] Run ${threadId} of routine ${routineId} succeeded.`)
    this.notifyRenderer()
  }

  private escalate(threadId: string, routineId: string, reason: string, opts: { notify?: boolean } = {}): void {
    setRunState(threadId, 'escalated', reason)
    console.warn(`[routines] Run ${threadId} escalated: ${reason}`)
    if (opts.notify !== false && Notification.isSupported()) {
      const routine = getRoutine(routineId)
      new Notification({
        title: `Routine needs attention: ${routine?.name ?? 'Unknown routine'}`,
        body: reason,
      }).show()
    }
    this.notifyRenderer()
  }

  /**
   * User dismissed an escalated run. The caller is responsible for having
   * confirmed worktree destruction when unshipped work exists — this method
   * never asks, it executes.
   */
  async dismissRun(threadId: string): Promise<void> {
    const run = this.runWorktree(threadId)
    sessionManager.remove(threadId)
    setRunState(threadId, 'dismissed')
    if (run) await removeWorktreeLocation(run.id)
    this.notifyRenderer()
  }

  /** True if the run's worktree still holds unshipped work (drives the confirm dialog). */
  async runHasUnshippedWork(threadId: string): Promise<boolean> {
    const location = this.runWorktree(threadId)
    if (!location) return false
    try {
      const porcelain = (await runGit(['status', '--porcelain'], location.path)).trim()
      if (porcelain !== '') return true
      const unpushed = (await runGit(['rev-list', '--count', 'HEAD', '--not', '--remotes'], location.path)).trim()
      return unpushed !== '0'
    } catch {
      return true
    }
  }

  private notifyRenderer(): void {
    if (this.window && !this.window.isDestroyed()) {
      emitAppEvent(this.window, 'routines:changed')
    }
  }
}

export const routineManager = new RoutineManager()
