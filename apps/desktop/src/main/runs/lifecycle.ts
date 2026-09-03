/**
 * The Run lifecycle module.
 *
 * A Routine is a standing definition of automated work; each firing spawns a
 * Run: a hidden Thread on a fresh worktree branched off the remote default
 * branch. This module owns the whole lifecycle: deciding when a Routine is
 * due, spawning the Run, evaluating its Outcome when the session finishes
 * (`evaluateOutcome` below is the single implementation of ADR-0001), and
 * cleaning up or escalating.
 *
 * Dependencies are accepted through the role interfaces in ./types, never
 * created here: the module runs under test with in-memory fakes and in the
 * app with the adapters in ./adapters. Nothing in this file may import
 * electron, the database, git, or the session registry.
 *
 * Interface preconditions:
 * - Runs are local-only: a Routine whose parent Location is not `local`
 *   escalates at fire time instead of spawning a session.
 * - `start()` at most once per instance; `stop()` releases the timer and the
 *   completion subscription.
 *
 * State rule: a Run's state changes only AFTER the destructive step succeeds.
 * A worktree that cannot be removed keeps its Run escalated and visible —
 * never silently gone, never silently kept.
 */
import { Routine, ThreadStatus } from '../../shared/types'
import { mostRecentFireTime } from './cron'
import { Outcome, Run, RunLifecycleDeps, WorktreeInfo } from './types'

const DEFAULT_TICK_INTERVAL_MS = 30_000

const NON_IDLE_REASONS: Partial<Record<ThreadStatus, string>> = {
  error: 'The run ended with an error.',
  stopped: 'The run was stopped.',
  plan_pending: 'The run is waiting for plan approval.',
  question_pending: 'The run is waiting for an answer to a question.',
  permission_pending: 'The run is waiting for a permission decision.',
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sanitizeSegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'routine'
}

export class RunLifecycle {
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private unsubscribe: (() => void) | null = null
  /** Runs whose completion the lifecycle is already awaiting via runToCompletion. */
  private watched = new Set<string>()
  /** Invalid schedules already reported this process, keyed by routine id + raw value. */
  private invalidReported = new Set<string>()
  private readonly tickIntervalMs: number | null

  constructor(
    private readonly deps: RunLifecycleDeps,
    opts: { tickIntervalMs?: number | null } = {}
  ) {
    this.tickIntervalMs = opts.tickIntervalMs === undefined ? DEFAULT_TICK_INTERVAL_MS : opts.tickIntervalMs
  }

  start(): void {
    this.recoverInterruptedRuns()

    // Watch state lives in the store, not in memory: any Run in a non-terminal
    // state is re-evaluated when its session completes a turn — including
    // turns started by a user interacting with an escalated Run. Runs the
    // lifecycle itself started are excluded here; their runToCompletion
    // promise owns the evaluation.
    this.unsubscribe = this.deps.sessions.onCompletion((threadId, status) => {
      if (this.watched.has(threadId)) return
      const run = this.deps.store.getRun(threadId)
      if (!run || (run.state !== 'active' && run.state !== 'escalated')) return
      void this.evaluateCompletedRun(run, status)
    })

    if (this.tickIntervalMs !== null) {
      this.timer = setInterval(() => void this.tick(), this.tickIntervalMs)
    }
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /**
   * One rule covers live firing, launch catch-up, and wake catch-up: fire when
   * the most recent scheduled time is after the routine's last firing. This
   * caps catch-up at a single missed instance (the latest) by construction.
   */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = this.deps.clock.now()
      for (const { routine, schedule } of this.deps.store.loadRoutines()) {
        if (!routine.enabled) continue
        try {
          if (schedule.kind === 'invalid') {
            this.reportInvalidSchedule(routine, schedule.raw)
          } else if (schedule.kind === 'cron') {
            const due = mostRecentFireTime(schedule.expr, now)
            if (!due) continue
            const lastFired = routine.last_fired_at ?? routine.created_at
            if (due.toISOString() > lastFired) await this.fireScheduled(routine)
          } else if (schedule.kind === 'once') {
            const due = schedule.at.getTime() <= now.getTime()
            const alreadyFired =
              routine.last_fired_at !== null && routine.last_fired_at >= schedule.at.toISOString()
            if (due && !alreadyFired) {
              const spawned = await this.fireScheduled(routine)
              if (spawned) {
                // A spent one-off disables itself; re-arm by editing the
                // routine. Only an ACTUAL spawn spends it — a firing skipped
                // because a run is still active stays due and retries.
                this.deps.store.disableRoutine(routine.id)
                this.deps.onChange()
              }
            }
          }
        } catch (error) {
          console.error(`[runs] Failed to fire routine "${routine.name}":`, error)
        }
      }
    } finally {
      this.ticking = false
    }
  }

  /** Manual trigger. Returns the run's thread id (the existing one if a run is active). */
  async runNow(routineId: string): Promise<string> {
    const routine = this.deps.store.getRoutine(routineId)
    if (!routine) throw new Error('Routine not found')
    const active = this.deps.store.activeRun(routineId)
    if (active) return active.id
    // Manual firings never advance the cron watermark: a manual run is not a
    // scheduled one, and must neither satisfy nor suppress the schedule.
    return this.fire(routine)
  }

  /**
   * User dismissed an escalated run. The caller is responsible for having
   * confirmed worktree destruction when unshipped work exists — this method
   * never asks, it executes. If the worktree cannot be removed the error
   * propagates and the Run stays escalated (state rule above).
   */
  async dismissRun(threadId: string): Promise<void> {
    const run = this.deps.store.getRun(threadId)
    if (!run) throw new Error('Thread is not a routine run.')
    this.deps.sessions.discard(run.id)
    const worktree = run.locationId ? this.deps.worktrees.get(run.locationId) : null
    if (worktree) await this.deps.worktrees.remove(worktree.locationId)
    this.deps.store.transition(run.id, 'dismissed')
    this.deps.onChange()
  }

  /** True if the run's worktree still holds unshipped work (drives the confirm dialog). */
  async runHasUnshippedWork(threadId: string): Promise<boolean> {
    const run = this.deps.store.getRun(threadId)
    const worktree = run?.locationId ? this.deps.worktrees.get(run.locationId) : null
    if (!worktree) return false
    const outcome = await this.evaluateOutcome(worktree.path)
    // `unknown` counts as unshipped: warn before destroying what we cannot read.
    return outcome.kind !== 'clean'
  }

  /**
   * Runs still marked active at startup were interrupted by an app quit or
   * crash — their sessions died with the process. They escalate; auto-resuming
   * a half-done agentic session is not safe.
   */
  private recoverInterruptedRuns(): void {
    for (const run of this.deps.store.listActiveRuns()) {
      this.escalate(run.id, run.routineId, 'Run was interrupted — the app closed while it was in progress.', {
        notify: false,
      })
    }
  }

  /** A scheduled firing. Returns false when skipped because a run is still active. */
  private async fireScheduled(routine: Routine): Promise<boolean> {
    if (this.deps.store.activeRun(routine.id)) {
      // Skip WITHOUT writing the watermark: the firing stays due and retries
      // once the active run finishes; the fire rule itself caps catch-up.
      console.warn(`[runs] Skipping firing of "${routine.name}": previous run still active.`)
      return false
    }
    this.deps.store.recordFired(routine.id, this.deps.clock.now())
    await this.fire(routine)
    return true
  }

  /**
   * Spawn a Run: fetch, worktree off origin/<default>, hidden thread, prompt.
   * The thread is created first so any setup failure has a Run to escalate.
   */
  private async fire(routine: Routine): Promise<string> {
    const firedAt = this.deps.clock.now()
    const run = this.deps.store.spawnRun(routine, `${routine.name} — ${this.deps.formatTimestamp(firedAt)}`)
    this.deps.onChange()

    try {
      const parent = this.deps.worktrees.parent(routine.location_id)
      if (!parent) throw new Error('The routine’s location no longer exists.')
      if (parent.connectionType !== 'local') throw new Error('Routines currently support local locations only.')

      // Runs must branch off the remote default branch, fetched at fire time —
      // running against a stale local main is a silent footgun. Offline = escalate.
      let baseRef: string
      try {
        await this.deps.git.fetchOrigin(parent.path)
        baseRef = await this.deps.git.resolveBaseRef(parent.path)
      } catch (error) {
        throw new Error(`Could not fetch origin before the run: ${message(error)}`)
      }

      const label = `${sanitizeSegment(routine.name)}-${firedAt.getTime().toString(36)}`
      const worktree = await this.deps.worktrees.create(routine.location_id, label, baseRef)
      this.deps.store.attachWorktree(run.id, worktree.locationId)
      this.watch({ ...run, locationId: worktree.locationId }, routine.prompt, worktree)
      return run.id
    } catch (error) {
      this.escalate(run.id, routine.id, message(error))
      return run.id
    }
  }

  /**
   * Await the turn the lifecycle just started, then evaluate. A refused
   * prompt escalates immediately — it must never leave the Run active
   * forever with nothing watching it.
   */
  private watch(run: Run, prompt: string, worktree: WorktreeInfo): void {
    this.watched.add(run.id)
    void (async () => {
      let status: ThreadStatus
      try {
        status = await this.deps.sessions.runToCompletion(run.id, worktree, prompt)
      } catch (error) {
        this.escalate(run.id, run.routineId, `The run’s session could not accept the prompt: ${message(error)}`)
        return
      } finally {
        this.watched.delete(run.id)
      }
      await this.evaluateCompletedRun(run, status)
    })()
  }

  /**
   * Session finished a turn. Success requires a mechanically clean worktree;
   * everything else escalates. Escalated runs stay watched so that, after the
   * user interacts and the session goes idle again, evaluation reruns.
   */
  private async evaluateCompletedRun(run: Run, status: ThreadStatus): Promise<void> {
    try {
      if (status !== 'idle') {
        this.escalate(run.id, run.routineId, NON_IDLE_REASONS[status] ?? `The run ended in state "${status}".`)
        return
      }
      // The turn is over, but detached background work (a backgrounded command,
      // a subagent) may still be writing into the worktree and may yet wake the
      // thread. Removing the worktree here would destroy live work, so escalate
      // instead — the worktree is kept, and because escalated Runs stay watched,
      // a later completion with nothing live still promotes this to success.
      if (this.deps.sessions.hasLiveBackgroundWork(run.id)) {
        this.escalate(
          run.id,
          run.routineId,
          'The run went idle with background tasks still running. The worktree has been kept.'
        )
        return
      }
      const current = this.deps.store.getRun(run.id)
      const worktree = current?.locationId ? this.deps.worktrees.get(current.locationId) : null
      if (!worktree) {
        // No worktree (setup failed earlier, or already cleaned) — nothing to lose.
        await this.succeed(run, null)
        return
      }
      const outcome = await this.evaluateOutcome(worktree.path)
      if (outcome.kind === 'clean') {
        await this.succeed(run, worktree)
      } else if (outcome.kind === 'unshipped') {
        this.escalate(
          run.id,
          run.routineId,
          `The run finished with unshipped work (${outcome.description}). The worktree has been kept.`
        )
      } else {
        this.escalate(run.id, run.routineId, `Could not evaluate the run’s git state: ${outcome.error}`)
      }
    } catch (error) {
      this.escalate(run.id, run.routineId, `Could not evaluate the run: ${message(error)}`)
    }
  }

  /**
   * The single implementation of ADR-0001
   * (docs/adr/0001-run-success-is-git-clean.md): a Run's Outcome is
   * mechanically determined by git state — clean tree and nothing unpushed is
   * `clean`, anything else is `unshipped`. A git failure is not a verdict; it
   * is `unknown`, and every caller treats unknown conservatively (the
   * lifecycle escalates, `runHasUnshippedWork` warns as if work exists).
   */
  private async evaluateOutcome(worktreePath: string): Promise<Outcome> {
    try {
      const facts = await this.deps.git.workingTreeFacts(worktreePath)
      if (!facts.dirty && facts.unpushedCommits === 0) return { kind: 'clean' }
      const parts: string[] = []
      if (facts.dirty) parts.push('uncommitted changes')
      if (facts.unpushedCommits > 0) {
        parts.push(`${facts.unpushedCommits} unpushed commit${facts.unpushedCommits === 1 ? '' : 's'}`)
      }
      return { kind: 'unshipped', description: parts.join(' and ') }
    } catch (error) {
      return { kind: 'unknown', error: message(error) }
    }
  }

  /** Destroy first, then record: the Run becomes `success` only after its worktree is gone. */
  private async succeed(run: Run, worktree: WorktreeInfo | null): Promise<void> {
    this.deps.sessions.discard(run.id)
    if (worktree) {
      try {
        await this.deps.worktrees.remove(worktree.locationId)
      } catch (error) {
        this.escalate(run.id, run.routineId, `The run succeeded but its worktree could not be removed: ${message(error)}`)
        return
      }
    }
    this.deps.store.transition(run.id, 'success')
    console.log(`[runs] Run ${run.id} of routine ${run.routineId} succeeded.`)
    this.deps.onChange()
  }

  private escalate(runId: string, routineId: string, reason: string, opts: { notify?: boolean } = {}): void {
    this.deps.store.transition(runId, 'escalated', reason)
    console.warn(`[runs] Run ${runId} escalated: ${reason}`)
    if (opts.notify !== false) {
      const routine = this.deps.store.getRoutine(routineId)
      this.deps.notifier.runEscalated(routine?.name ?? 'Unknown routine', reason)
    }
    this.deps.onChange()
  }

  private reportInvalidSchedule(routine: Routine, raw: string | null): void {
    const key = `${routine.id}:${raw ?? ''}`
    if (this.invalidReported.has(key)) return
    this.invalidReported.add(key)
    console.warn(`[runs] Routine "${routine.name}" has an invalid schedule and will not fire.`)
    this.deps.notifier.invalidSchedule(routine.name)
  }
}
