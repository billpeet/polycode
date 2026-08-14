/**
 * In-memory fakes for the Run lifecycle's role interfaces. The lifecycle is
 * tested exclusively through its interface with these — no Electron, no
 * database, no git, no module mocks.
 */
import { Routine, RunState, ThreadStatus } from '../../../shared/types'
import { parseSchedule } from '../schedule'
import {
  LEGAL_RUN_TRANSITIONS,
  Run,
  RunClock,
  RunGit,
  RunNotifier,
  RunSessions,
  RunStore,
  RunWorktrees,
  ScheduledRoutine,
  WorktreeInfo,
} from '../types'

export function makeRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'routine-1',
    project_id: 'project-1',
    location_id: 'loc-parent',
    name: 'Nightly cleanup',
    prompt: 'Do the thing',
    trigger_type: 'cron',
    schedule: '0 3 * * *',
    provider: 'claude-code',
    model: 'claude-opus-4-8',
    permission_mode: 'yolo',
    enabled: true,
    last_fired_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

export class FakeStore implements RunStore {
  routines = new Map<string, Routine>()
  runs = new Map<string, Run>()
  transitions: Array<{ runId: string; to: RunState; detail: string | null }> = []
  private spawnCounter = 0

  addRoutine(routine: Routine): Routine {
    this.routines.set(routine.id, routine)
    return routine
  }

  /** Seed a pre-existing Run (e.g. an interrupted or escalated one). */
  seedRun(run: Run): Run {
    this.runs.set(run.id, run)
    return run
  }

  loadRoutines(): ScheduledRoutine[] {
    return [...this.routines.values()].map((routine) => ({ routine, schedule: parseSchedule(routine) }))
  }

  getRoutine(id: string): Routine | null {
    return this.routines.get(id) ?? null
  }

  recordFired(routineId: string, at: Date): void {
    const routine = this.routines.get(routineId)
    if (routine) routine.last_fired_at = at.toISOString()
  }

  disableRoutine(routineId: string): void {
    const routine = this.routines.get(routineId)
    if (routine) routine.enabled = false
  }

  spawnRun(routine: Routine, _name: string): Run {
    const run: Run = {
      id: `run-${++this.spawnCounter}`,
      routineId: routine.id,
      state: 'active',
      detail: null,
      locationId: routine.location_id,
    }
    this.runs.set(run.id, run)
    return run
  }

  attachWorktree(runId: string, locationId: string): void {
    const run = this.runs.get(runId)
    if (run) run.locationId = locationId
  }

  getRun(threadId: string): Run | null {
    return this.runs.get(threadId) ?? null
  }

  listActiveRuns(): Run[] {
    return [...this.runs.values()].filter((run) => run.state === 'active')
  }

  activeRun(routineId: string): Run | null {
    return [...this.runs.values()].find((run) => run.routineId === routineId && run.state === 'active') ?? null
  }

  transition(runId: string, to: 'success' | 'escalated' | 'dismissed', detail: string | null = null): void {
    const run = this.runs.get(runId)
    if (!run) throw new Error(`Thread ${runId} is not a run.`)
    if (!LEGAL_RUN_TRANSITIONS[run.state].includes(to)) {
      throw new Error(`Illegal run transition ${run.state} → ${to} for run ${runId}.`)
    }
    run.state = to
    run.detail = detail
    this.transitions.push({ runId, to, detail })
  }
}

export class FakeGit implements RunGit {
  fetched: string[] = []
  fetchError: Error | null = null
  baseRef = 'origin/main'
  facts = new Map<string, { dirty: boolean; unpushedCommits: number }>()
  factsError: Error | null = null

  async fetchOrigin(repoPath: string): Promise<void> {
    if (this.fetchError) throw this.fetchError
    this.fetched.push(repoPath)
  }

  async resolveBaseRef(): Promise<string> {
    return this.baseRef
  }

  async workingTreeFacts(worktreePath: string): Promise<{ dirty: boolean; unpushedCommits: number }> {
    if (this.factsError) throw this.factsError
    return this.facts.get(worktreePath) ?? { dirty: false, unpushedCommits: 0 }
  }
}

export class FakeWorktrees implements RunWorktrees {
  parents = new Map<string, { path: string; connectionType: string }>()
  worktrees = new Map<string, WorktreeInfo>()
  created: Array<{ parentLocationId: string; label: string; baseRef: string }> = []
  removed: string[] = []
  createError: Error | null = null
  removeError: Error | null = null
  private counter = 0

  seedWorktree(locationId: string): WorktreeInfo {
    const info: WorktreeInfo = {
      locationId,
      path: `/worktrees/${locationId}`,
      effectiveDir: `/worktrees/${locationId}`,
      ssh: null,
      wsl: null,
    }
    this.worktrees.set(locationId, info)
    return info
  }

  parent(locationId: string): { path: string; connectionType: string } | null {
    return this.parents.get(locationId) ?? null
  }

  async create(parentLocationId: string, label: string, baseRef: string): Promise<WorktreeInfo> {
    if (this.createError) throw this.createError
    this.created.push({ parentLocationId, label, baseRef })
    return this.seedWorktree(`wt-${++this.counter}`)
  }

  get(locationId: string): WorktreeInfo | null {
    return this.worktrees.get(locationId) ?? null
  }

  async remove(locationId: string): Promise<void> {
    if (this.removeError) throw this.removeError
    this.removed.push(locationId)
    this.worktrees.delete(locationId)
  }
}

export class FakeSessions implements RunSessions {
  prompts: Array<{ threadId: string; prompt: string }> = []
  discarded: string[] = []
  refusal: Error | null = null
  /** Status runToCompletion resolves with; 'never' leaves the turn pending. */
  completionStatus: ThreadStatus | 'never' = 'idle'
  private pending = new Map<string, (status: ThreadStatus) => void>()
  private listeners: Array<(threadId: string, status: ThreadStatus) => void> = []

  runToCompletion(threadId: string, _worktree: WorktreeInfo, prompt: string): Promise<ThreadStatus> {
    if (this.refusal) return Promise.reject(this.refusal)
    this.prompts.push({ threadId, prompt })
    if (this.completionStatus === 'never') {
      return new Promise((resolve) => this.pending.set(threadId, resolve))
    }
    return Promise.resolve(this.completionStatus)
  }

  /** Resolve a pending runToCompletion turn (completionStatus = 'never'). */
  completePending(threadId: string, status: ThreadStatus): void {
    this.pending.get(threadId)?.(status)
    this.pending.delete(threadId)
  }

  onCompletion(listener: (threadId: string, status: ThreadStatus) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  /** Simulate a completion the lifecycle did not initiate (a user turn). */
  emitCompletion(threadId: string, status: ThreadStatus): void {
    for (const listener of [...this.listeners]) listener(threadId, status)
  }

  discard(threadId: string): void {
    this.discarded.push(threadId)
  }
}

export class FakeNotifier implements RunNotifier {
  escalations: Array<{ routineName: string; reason: string }> = []
  invalidSchedules: string[] = []

  runEscalated(routineName: string, reason: string): void {
    this.escalations.push({ routineName, reason })
  }

  invalidSchedule(routineName: string): void {
    this.invalidSchedules.push(routineName)
  }
}

export class ManualClock implements RunClock {
  constructor(public current: Date) {}

  now(): Date {
    return new Date(this.current)
  }

  set(date: Date): void {
    this.current = date
  }
}
