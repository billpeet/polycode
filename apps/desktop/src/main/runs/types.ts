/**
 * The Run lifecycle module's types and role interfaces.
 *
 * The lifecycle accepts these dependencies rather than creating them. Each
 * interface is shaped by what the lifecycle needs (its role), not by the
 * module that implements it — a fake for any of them is a few lines. The
 * production adapters live in ./adapters and bind these roles to git, the
 * database, project-admin, the session registry, and Electron notifications.
 */
import { Routine, RunState, SshConfig, ThreadStatus, WslConfig } from '../../shared/types'

/**
 * A Run: one execution of a Routine. Stored as a Thread with run bookkeeping
 * (see CONTEXT.md); this type is the non-nullable view of that bookkeeping,
 * constructed only by the RunStore adapter.
 */
export interface Run {
  /** Thread id. */
  id: string
  routineId: string
  state: RunState
  /** Human-readable detail for the current state (e.g. escalation reason). */
  detail: string | null
  /** Location of the Run's worktree; null before provisioning or after cleanup. */
  locationId: string | null
}

/**
 * The Outcome of evaluating a Run's worktree, per ADR-0001
 * (docs/adr/0001-run-success-is-git-clean.md). Three-valued on purpose: a git
 * failure is not a verdict but `unknown`, and every consumer must interpret
 * `unknown` conservatively — the lifecycle escalates, the unshipped-work
 * check warns as if work exists.
 */
export type Outcome =
  | { kind: 'clean' }
  | { kind: 'unshipped'; description: string }
  | { kind: 'unknown'; error: string }

/**
 * A Routine's schedule, parsed once at the store. Invalid input becomes a
 * visible `invalid` value the lifecycle can report — never a silent skip.
 */
export type ParsedSchedule =
  | { kind: 'cron'; expr: string }
  | { kind: 'once'; at: Date }
  | { kind: 'manual' }
  | { kind: 'invalid'; raw: string | null }

export interface ScheduledRoutine {
  routine: Routine
  schedule: ParsedSchedule
}

export interface RunClock {
  now(): Date
}

/**
 * Git facts about repositories the lifecycle touches. Facts only — the
 * ADR-0001 policy that turns them into an Outcome lives in the lifecycle.
 * Implementations must not serve cached state: these facts decide whether a
 * worktree is destroyed.
 */
export interface RunGit {
  fetchOrigin(repoPath: string): Promise<void>
  /** The remote default branch ref (origin/HEAD → origin/main → origin/master). */
  resolveBaseRef(repoPath: string): Promise<string>
  workingTreeFacts(worktreePath: string): Promise<{ dirty: boolean; unpushedCommits: number }>
}

export interface WorktreeInfo {
  locationId: string
  path: string
  /** Directory the session runs in (WSL path conversion already applied). */
  effectiveDir: string
  ssh: SshConfig | null
  wsl: WslConfig | null
}

export interface RunWorktrees {
  /** Parent repo of a Routine's location; null when it no longer exists. */
  parent(locationId: string): { path: string; connectionType: string } | null
  create(parentLocationId: string, label: string, baseRef: string): Promise<WorktreeInfo>
  /** Worktree info for a location; null when missing or not a worktree. */
  get(locationId: string): WorktreeInfo | null
  remove(locationId: string): Promise<void>
}

/**
 * The Run state machine. Adapters (and test fakes) enforce this table so
 * illegal orderings — e.g. marking a Run dismissed before its worktree is
 * gone, then failing — are unrepresentable rather than merely avoided.
 */
export const LEGAL_RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  active: ['success', 'escalated'],
  escalated: ['success', 'escalated', 'dismissed'],
  success: [],
  dismissed: [],
}

export interface RunStore {
  loadRoutines(): ScheduledRoutine[]
  getRoutine(id: string): Routine | null
  /**
   * Advance the cron watermark. Written only when a scheduled firing actually
   * spawns a Run — never for manual runs, never for skipped firings.
   */
  recordFired(routineId: string, at: Date): void
  disableRoutine(routineId: string): void
  spawnRun(routine: Routine, name: string): Run
  attachWorktree(runId: string, locationId: string): void
  getRun(threadId: string): Run | null
  listActiveRuns(): Run[]
  activeRun(routineId: string): Run | null
  /**
   * Move a Run to a new state. Legal transitions only:
   * active → success | escalated; escalated → success | escalated | dismissed.
   * Throws on anything else — illegal orderings are unrepresentable.
   */
  transition(runId: string, to: 'success' | 'escalated' | 'dismissed', detail?: string | null): void
}

export interface RunSessions {
  /**
   * Send the Run's prompt and resolve with the turn's terminal status.
   * Rejects when the session cannot accept the message — refusal is
   * observable, never a silent no-op.
   */
  runToCompletion(threadId: string, worktree: WorktreeInfo, prompt: string): Promise<ThreadStatus>
  /**
   * Typed completion feed for turns the lifecycle did not initiate (a user
   * interacting with an escalated Run). Returns an unsubscribe function.
   */
  onCompletion(listener: (threadId: string, status: ThreadStatus) => void): () => void
  discard(threadId: string): void
}

export interface RunNotifier {
  runEscalated(routineName: string, reason: string): void
  invalidSchedule(routineName: string): void
}

export interface RunLifecycleDeps {
  store: RunStore
  git: RunGit
  worktrees: RunWorktrees
  sessions: RunSessions
  notifier: RunNotifier
  clock: RunClock
  /** Refresh hint for the renderer (`routines:changed`) — not a domain event. */
  onChange: () => void
}
