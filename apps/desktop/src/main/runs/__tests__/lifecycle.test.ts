/**
 * Run lifecycle — interface tests with fakes.
 *
 * BEHAVIOUR INVENTORY — every behaviour ported from routines/manager.ts,
 * encoded here against the new interface (the old singleton was never
 * test-harnessed; this checklist is the port's safety net):
 *
 *  Firing
 *   1. A due cron routine fires; catch-up is capped at one missed instance.
 *   2. Disabled routines and 'manual' trigger types never fire from tick.
 *   3. A scheduled firing is skipped while a run is active — and (changed
 *      behaviour, Q11) the skip does NOT advance the watermark: the firing
 *      stays due and retries after the active run finishes.
 *   4. A 'once' routine fires at/after its moment and disables itself — only
 *      after a run actually spawns (defect fix: it can no longer be spent by
 *      a skip or a manual run).
 *   5. Manual runNow returns the active run's id if one exists, never
 *      advances the cron watermark, and never suppresses the schedule.
 *  Provisioning
 *   6. fetch origin → resolve remote base ref → worktree off that ref;
 *      fetch/resolve failure escalates with "Could not fetch origin".
 *   7. A missing or non-local parent location escalates (local-only is an
 *      interface precondition).
 *   8. The run thread is created FIRST, so every setup failure has a Run to
 *      escalate.
 *  Evaluation (ADR-0001, single site)
 *   9. idle + clean tree + nothing unpushed → success: session discarded,
 *      worktree removed, THEN the state transition (state changes only after
 *      the destructive step succeeds).
 *  10. idle + unshipped work → escalated, worktree kept, detail names the
 *      uncommitted/unpushed parts.
 *  11. git failure during evaluation → Outcome 'unknown' → escalated.
 *  12. Non-idle terminal statuses escalate with their per-status reasons.
 *  13. A refused prompt escalates immediately (defect fix: a Run can no
 *      longer sit active forever because the session silently dropped the
 *      message).
 *  14. Worktree-removal failure after a clean run escalates — awaited, so the
 *      Run is never briefly 'success' (defect fix: no floating re-escalation).
 *  Escalated runs
 *  15. Startup recovery: runs still active at start() escalate as
 *      interrupted, without an OS notification.
 *  16. Escalated runs stay watched: a user turn that ends idle re-evaluates
 *      (and can succeed) via the completion subscription.
 *  17. The subscription ignores runs the lifecycle is already awaiting — no
 *      double evaluation.
 *  Dismissal
 *  18. Dismiss removes the worktree and only then transitions to dismissed;
 *      on removal failure the error propagates and the Run stays escalated
 *      (defect fix: dismissal can no longer lose track of a live worktree).
 *  Unshipped-work check
 *  19. Dirty or unpushed → true; clean → false; no worktree → false; git
 *      failure → true (unknown is treated conservatively).
 *  Schedules
 *  20. An invalid schedule is reported (once per value) instead of silently
 *      skipped.
 *  Notifications & change signal
 *  21. Escalations notify with the routine name; onChange fires on spawn,
 *      success, escalation, dismissal, and once-disable.
 */
import { describe, expect, it } from 'vitest'
import { ThreadStatus } from '../../../shared/types'
import { RunLifecycle } from '../lifecycle'
import { FakeGit, FakeNotifier, FakeSessions, FakeStore, FakeWorktrees, ManualClock, makeRoutine } from './fakes'

/** Let the lifecycle's floating watch() promises settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function harness(clockAt = new Date('2026-08-14T03:05:00')) {
  const store = new FakeStore()
  const git = new FakeGit()
  const worktrees = new FakeWorktrees()
  const sessions = new FakeSessions()
  const notifier = new FakeNotifier()
  const clock = new ManualClock(clockAt)
  const changes = { count: 0 }
  worktrees.parents.set('loc-parent', { path: '/repo', connectionType: 'local' })
  const lifecycle = new RunLifecycle(
    { store, git, worktrees, sessions, notifier, clock, onChange: () => changes.count++ },
    { tickIntervalMs: null }
  )
  return { lifecycle, store, git, worktrees, sessions, notifier, clock, changes }
}

describe('firing', () => {
  it('fires a due cron routine and advances the watermark', async () => {
    const h = harness()
    const routine = h.store.addRoutine(makeRoutine())
    await h.lifecycle.tick()
    await settle()
    expect(h.sessions.prompts).toHaveLength(1)
    expect(h.sessions.prompts[0].prompt).toBe('Do the thing')
    expect(routine.last_fired_at).toBe(h.clock.now().toISOString())
  })

  it('caps catch-up at one missed instance', async () => {
    const h = harness()
    // Last fired three days ago; many 03:00 instances missed since.
    h.store.addRoutine(makeRoutine({ last_fired_at: '2026-08-11T04:00:00.000Z' }))
    await h.lifecycle.tick()
    await settle()
    await h.lifecycle.tick()
    await settle()
    expect(h.sessions.prompts).toHaveLength(1)
  })

  it('never fires disabled or manual-trigger routines', async () => {
    const h = harness()
    h.store.addRoutine(makeRoutine({ id: 'r-disabled', enabled: false }))
    h.store.addRoutine(makeRoutine({ id: 'r-manual', trigger_type: 'manual', schedule: null }))
    await h.lifecycle.tick()
    expect(h.sessions.prompts).toHaveLength(0)
  })

  it('skips a scheduled firing while a run is active WITHOUT advancing the watermark, then retries', async () => {
    const h = harness()
    const routine = h.store.addRoutine(makeRoutine())
    const active = h.store.seedRun({ id: 'run-live', routineId: routine.id, state: 'active', detail: null, locationId: null })
    await h.lifecycle.tick()
    expect(h.sessions.prompts).toHaveLength(0)
    expect(routine.last_fired_at).toBeNull()

    active.state = 'success' // the blocking run finishes
    await h.lifecycle.tick()
    await settle()
    expect(h.sessions.prompts).toHaveLength(1)
    expect(routine.last_fired_at).not.toBeNull()
  })

  it("disables a 'once' routine only after a run actually spawns", async () => {
    const h = harness(new Date('2026-08-14T03:05:00Z'))
    const routine = h.store.addRoutine(
      makeRoutine({ trigger_type: 'once', schedule: '2026-08-14T02:00:00.000Z' })
    )
    const active = h.store.seedRun({ id: 'run-live', routineId: routine.id, state: 'active', detail: null, locationId: null })
    await h.lifecycle.tick()
    // Skipped: still enabled, still unspent (the old code disabled it here).
    expect(routine.enabled).toBe(true)
    expect(routine.last_fired_at).toBeNull()

    active.state = 'success'
    await h.lifecycle.tick()
    await settle()
    expect(h.sessions.prompts).toHaveLength(1)
    expect(routine.enabled).toBe(false)
  })

  it('runNow returns the active run id, and manual firings never advance the watermark', async () => {
    const h = harness()
    const routine = h.store.addRoutine(makeRoutine())
    const firstId = await h.lifecycle.runNow(routine.id)
    await settle()
    expect(h.sessions.prompts).toHaveLength(1)
    expect(routine.last_fired_at).toBeNull()

    // While that run is active, runNow returns it instead of spawning.
    h.store.getRun(firstId)!.state = 'active'
    const again = await h.lifecycle.runNow(routine.id)
    expect(again).toBe(firstId)

    // Once it finishes, the schedule is still due — the manual run did not satisfy it.
    h.store.getRun(firstId)!.state = 'success'
    await h.lifecycle.tick()
    await settle()
    expect(h.sessions.prompts).toHaveLength(2)
    expect(routine.last_fired_at).not.toBeNull()
  })
})

describe('provisioning', () => {
  it('fetches origin and branches the worktree off the resolved remote default', async () => {
    const h = harness()
    h.git.baseRef = 'origin/trunk'
    h.store.addRoutine(makeRoutine())
    await h.lifecycle.tick()
    await settle()
    expect(h.git.fetched).toEqual(['/repo'])
    expect(h.worktrees.created).toEqual([
      expect.objectContaining({ parentLocationId: 'loc-parent', baseRef: 'origin/trunk' }),
    ])
    expect(h.worktrees.created[0].label).toMatch(/^Nightly-cleanup-/)
  })

  it('escalates when fetch fails — the run thread exists first, so there is a Run to escalate', async () => {
    const h = harness()
    h.git.fetchError = new Error('offline')
    h.store.addRoutine(makeRoutine())
    await h.lifecycle.tick()
    await settle()
    const run = [...h.store.runs.values()][0]
    expect(run.state).toBe('escalated')
    expect(run.detail).toContain('Could not fetch origin before the run')
    expect(h.notifier.escalations).toHaveLength(1)
  })

  it('escalates when the parent location is missing or non-local', async () => {
    const h = harness()
    h.store.addRoutine(makeRoutine({ id: 'r-gone', location_id: 'loc-gone' }))
    h.worktrees.parents.set('loc-ssh', { path: '/remote', connectionType: 'ssh' })
    h.store.addRoutine(makeRoutine({ id: 'r-ssh', location_id: 'loc-ssh' }))
    await h.lifecycle.tick()
    await settle()
    const details = [...h.store.runs.values()].map((run) => run.detail)
    expect(details).toEqual(
      expect.arrayContaining([
        expect.stringContaining('location no longer exists'),
        expect.stringContaining('local locations only'),
      ])
    )
  })
})

describe('evaluation (ADR-0001)', () => {
  it('succeeds a clean idle run: discard session, remove worktree, THEN transition', async () => {
    const h = harness()
    const routine = h.store.addRoutine(makeRoutine())
    await h.lifecycle.tick()
    await settle()
    const run = [...h.store.runs.values()][0]
    expect(run.state).toBe('success')
    expect(h.sessions.discarded).toContain(run.id)
    expect(h.worktrees.removed).toHaveLength(1)
    expect(h.notifier.escalations).toHaveLength(0)
    expect(routine.enabled).toBe(true)
  })

  it('escalates — never removes the worktree — when the run goes idle with background tasks live', async () => {
    // The turn ending is not the same as the work ending: a detached command or
    // subagent may still be writing into the worktree, and may yet wake the
    // thread. Removing it here would destroy live work.
    const h = harness()
    h.store.addRoutine(makeRoutine())
    h.sessions.liveBackgroundWork.add('run-1')
    await h.lifecycle.tick()
    await settle()
    const run = [...h.store.runs.values()][0]
    // Guard against the id guess above silently disarming this test.
    expect(h.sessions.liveBackgroundWork.has(run.id)).toBe(true)
    expect(run.state).toBe('escalated')
    expect(run.detail).toContain('background tasks still running')
    expect(h.worktrees.removed).toHaveLength(0)
    expect(h.sessions.discarded).not.toContain(run.id)
    expect(h.store.transitions.map((t) => t.to)).not.toContain('success')
  })

  it('escalates unshipped work with a detail naming the parts, keeping the worktree', async () => {
    const h = harness()
    h.store.addRoutine(makeRoutine())
    h.git.facts.set('/worktrees/wt-1', { dirty: true, unpushedCommits: 2 })
    await h.lifecycle.tick()
    await settle()
    const run = [...h.store.runs.values()][0]
    expect(run.state).toBe('escalated')
    expect(run.detail).toContain('uncommitted changes and 2 unpushed commits')
    expect(run.detail).toContain('worktree has been kept')
    expect(h.worktrees.removed).toHaveLength(0)
  })

  it("escalates when git state cannot be read (Outcome 'unknown')", async () => {
    const h = harness()
    h.store.addRoutine(makeRoutine())
    h.git.factsError = new Error('index.lock held')
    await h.lifecycle.tick()
    await settle()
    const run = [...h.store.runs.values()][0]
    expect(run.state).toBe('escalated')
    expect(run.detail).toContain('Could not evaluate the run’s git state')
    expect(h.worktrees.removed).toHaveLength(0)
  })

  it.each<[ThreadStatus, string]>([
    ['error', 'ended with an error'],
    ['stopped', 'was stopped'],
    ['plan_pending', 'waiting for plan approval'],
    ['question_pending', 'waiting for an answer'],
    ['permission_pending', 'waiting for a permission decision'],
  ])('escalates a %s turn with its reason', async (status, fragment) => {
    const h = harness()
    h.store.addRoutine(makeRoutine())
    h.sessions.completionStatus = status
    await h.lifecycle.tick()
    await settle()
    const run = [...h.store.runs.values()][0]
    expect(run.state).toBe('escalated')
    expect(run.detail).toContain(fragment)
  })

  it('escalates immediately when the session refuses the prompt', async () => {
    const h = harness()
    h.store.addRoutine(makeRoutine())
    h.sessions.refusal = new Error('The session is already running a turn.')
    await h.lifecycle.tick()
    await settle()
    const run = [...h.store.runs.values()][0]
    expect(run.state).toBe('escalated')
    expect(run.detail).toContain('could not accept the prompt')
  })

  it('escalates — never success — when the worktree cannot be removed after a clean run', async () => {
    const h = harness()
    h.store.addRoutine(makeRoutine())
    h.worktrees.removeError = new Error('EBUSY')
    await h.lifecycle.tick()
    await settle()
    const run = [...h.store.runs.values()][0]
    expect(run.state).toBe('escalated')
    expect(run.detail).toContain('worktree could not be removed')
    // The state rule: no transient 'success' was ever recorded.
    expect(h.store.transitions.map((t) => t.to)).not.toContain('success')
  })
})

describe('escalated runs', () => {
  it('escalates interrupted runs at startup without an OS notification', () => {
    const h = harness()
    h.store.seedRun({ id: 'run-x', routineId: 'routine-1', state: 'active', detail: null, locationId: null })
    h.lifecycle.start()
    h.lifecycle.stop()
    expect(h.store.getRun('run-x')!.state).toBe('escalated')
    expect(h.store.getRun('run-x')!.detail).toContain('interrupted')
    expect(h.notifier.escalations).toHaveLength(0)
  })

  it('re-evaluates an escalated run when a user turn completes idle, and can succeed it', async () => {
    const h = harness()
    h.store.addRoutine(makeRoutine({ trigger_type: 'manual', schedule: null }))
    h.store.seedRun({ id: 'run-x', routineId: 'routine-1', state: 'escalated', detail: 'was dirty', locationId: 'wt-9' })
    h.worktrees.seedWorktree('wt-9')
    h.lifecycle.start()
    h.sessions.emitCompletion('run-x', 'idle')
    await settle()
    h.lifecycle.stop()
    expect(h.store.getRun('run-x')!.state).toBe('success')
    expect(h.worktrees.removed).toEqual(['wt-9'])
  })

  it('ignores completions for threads that are not runs', async () => {
    const h = harness()
    h.lifecycle.start()
    h.sessions.emitCompletion('some-user-thread', 'idle')
    await settle()
    h.lifecycle.stop()
    expect(h.store.transitions).toHaveLength(0)
  })

  it('does not double-evaluate a lifecycle-initiated turn seen by the subscription', async () => {
    const h = harness()
    h.store.addRoutine(makeRoutine({ trigger_type: 'manual', schedule: null }))
    h.sessions.completionStatus = 'never'
    h.lifecycle.start()
    const runId = await h.lifecycle.runNow('routine-1')
    // The completion reaches the bus (subscription) AND resolves the promise.
    h.sessions.emitCompletion(runId, 'idle')
    h.sessions.completePending(runId, 'idle')
    await settle()
    h.lifecycle.stop()
    expect(h.store.transitions.filter((t) => t.runId === runId)).toHaveLength(1)
  })
})

describe('dismissal', () => {
  it('removes the worktree first, then transitions to dismissed', async () => {
    const h = harness()
    h.store.seedRun({ id: 'run-x', routineId: 'routine-1', state: 'escalated', detail: 'dirty', locationId: 'wt-9' })
    h.worktrees.seedWorktree('wt-9')
    await h.lifecycle.dismissRun('run-x')
    expect(h.worktrees.removed).toEqual(['wt-9'])
    expect(h.store.getRun('run-x')!.state).toBe('dismissed')
    expect(h.sessions.discarded).toContain('run-x')
  })

  it('keeps the run escalated and propagates the error when removal fails', async () => {
    const h = harness()
    h.store.seedRun({ id: 'run-x', routineId: 'routine-1', state: 'escalated', detail: 'dirty', locationId: 'wt-9' })
    h.worktrees.seedWorktree('wt-9')
    h.worktrees.removeError = new Error('EPERM')
    await expect(h.lifecycle.dismissRun('run-x')).rejects.toThrow('EPERM')
    expect(h.store.getRun('run-x')!.state).toBe('escalated')
  })

  it('rejects dismissing a thread that is not a run', async () => {
    const h = harness()
    await expect(h.lifecycle.dismissRun('nope')).rejects.toThrow('not a routine run')
  })
})

describe('unshipped-work check', () => {
  it.each([
    [{ dirty: true, unpushedCommits: 0 }, true],
    [{ dirty: false, unpushedCommits: 3 }, true],
    [{ dirty: false, unpushedCommits: 0 }, false],
  ])('%o → %s', async (facts, expected) => {
    const h = harness()
    h.store.seedRun({ id: 'run-x', routineId: 'routine-1', state: 'escalated', detail: null, locationId: 'wt-9' })
    h.worktrees.seedWorktree('wt-9')
    h.git.facts.set('/worktrees/wt-9', facts)
    expect(await h.lifecycle.runHasUnshippedWork('run-x')).toBe(expected)
  })

  it('treats an unreadable worktree as unshipped, and a missing one as clean', async () => {
    const h = harness()
    h.store.seedRun({ id: 'run-x', routineId: 'routine-1', state: 'escalated', detail: null, locationId: 'wt-9' })
    h.worktrees.seedWorktree('wt-9')
    h.git.factsError = new Error('boom')
    expect(await h.lifecycle.runHasUnshippedWork('run-x')).toBe(true)

    h.store.seedRun({ id: 'run-y', routineId: 'routine-1', state: 'escalated', detail: null, locationId: null })
    expect(await h.lifecycle.runHasUnshippedWork('run-y')).toBe(false)
  })
})

describe('schedules', () => {
  it('reports an invalid schedule once instead of silently skipping it', async () => {
    const h = harness()
    h.store.addRoutine(makeRoutine({ schedule: 'not a cron' }))
    await h.lifecycle.tick()
    await h.lifecycle.tick()
    expect(h.sessions.prompts).toHaveLength(0)
    expect(h.notifier.invalidSchedules).toEqual(['Nightly cleanup'])
  })

  it("reports an invalid 'once' datetime the same way", async () => {
    const h = harness()
    h.store.addRoutine(makeRoutine({ trigger_type: 'once', schedule: 'tomorrow-ish' }))
    await h.lifecycle.tick()
    expect(h.notifier.invalidSchedules).toEqual(['Nightly cleanup'])
  })
})

describe('change signal', () => {
  it('fires onChange across the lifecycle of a successful run', async () => {
    const h = harness()
    h.store.addRoutine(makeRoutine())
    await h.lifecycle.tick()
    await settle()
    // spawn + success — at least two refresh hints.
    expect(h.changes.count).toBeGreaterThanOrEqual(2)
  })
})
