import { v4 as uuidv4 } from 'uuid'
import { getDb } from './index'
import { ProjectRow, RepoLocationRow, ThreadRow, MessageRow, SessionRow, ProjectCommandRow, YouTrackServerRow, SlashCommandRow, LocationPoolRow, RoutineRow } from './models'
import { foldMessages } from '@polycode/shared'
import { CodexPersonality, CodexReasoningSummary, Project, Thread, QueueThread, Message, Session, RepoLocation, SshConfig, WslConfig, ConnectionType, Provider, PermissionMode, ReasoningLevel, getModelsForProvider, getDefaultModelForProvider, ProjectCommand, YouTrackServer, SlashCommand, LocationPool, Routine, RoutineTriggerType, RunState } from '../../shared/types'

// ── Projects ──────────────────────────────────────────────────────────────────

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    git_url: row.git_url ?? null,
    favicon_path: row.favicon_path ?? null,
    allow_main_branch_commits: row.allow_main_branch_commits !== 0,
    archived_at: row.archived_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_activity_at: row.last_activity_at ?? row.updated_at,
  }
}

/**
 * Most recent thread activity per project, used for "last message" sorting.
 * "Activity" means Turn completion (falling back to creation for threads that
 * have never run) — consistent with thread and Queue ordering.
 */
const PROJECT_LAST_ACTIVITY_SELECT =
  'SELECT p.*, (SELECT MAX(COALESCE(t.last_turn_completed_at, t.created_at)) FROM threads t WHERE t.project_id = p.id) AS last_activity_at FROM projects p'

export function listProjects(): Project[] {
  const rows = getDb()
    .prepare(`${PROJECT_LAST_ACTIVITY_SELECT} WHERE p.archived_at IS NULL ORDER BY p.created_at DESC`)
    .all() as ProjectRow[]
  return rows.map(rowToProject)
}

export function listArchivedProjects(): Project[] {
  const rows = getDb()
    .prepare(`${PROJECT_LAST_ACTIVITY_SELECT} WHERE p.archived_at IS NOT NULL ORDER BY p.archived_at DESC`)
    .all() as ProjectRow[]
  return rows.map(rowToProject)
}

export function archiveProject(id: string): void {
  getDb()
    .prepare('UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), new Date().toISOString(), id)
}

export function unarchiveProject(id: string): void {
  getDb()
    .prepare('UPDATE projects SET archived_at = NULL, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id)
}

export function createProject(name: string, gitUrl?: string | null, allowMainBranchCommits = true): Project {
  const now = new Date().toISOString()
  const id = uuidv4()
  getDb()
    .prepare(
      'INSERT INTO projects (id, name, path, git_url, allow_main_branch_commits, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, name, '', gitUrl ?? null, allowMainBranchCommits ? 1 : 0, now, now)
  return {
    id,
    name,
    git_url: gitUrl ?? null,
    favicon_path: null,
    allow_main_branch_commits: allowMainBranchCommits,
    archived_at: null,
    created_at: now,
    updated_at: now,
    last_activity_at: now,
  }
}

export function updateProject(id: string, name: string, gitUrl?: string | null, allowMainBranchCommits = true, faviconPath?: string | null): void {
  getDb()
    .prepare('UPDATE projects SET name = ?, git_url = ?, allow_main_branch_commits = ?, favicon_path = ?, updated_at = ? WHERE id = ?')
    .run(name, gitUrl ?? null, allowMainBranchCommits ? 1 : 0, faviconPath ?? null, new Date().toISOString(), id)
}

export function deleteProject(id: string): void {
  getDb().prepare('DELETE FROM projects WHERE id = ?').run(id)
}

export function getProjectForThread(threadId: string): Project | null {
  const row = getDb()
    .prepare('SELECT p.* FROM projects p JOIN threads t ON t.project_id = p.id WHERE t.id = ?')
    .get(threadId) as ProjectRow | undefined
  return row ? rowToProject(row) : null
}

export function getProjectById(id: string): Project | null {
  const row = getDb()
    .prepare('SELECT * FROM projects WHERE id = ?')
    .get(id) as ProjectRow | undefined
  return row ? rowToProject(row) : null
}

// ── Repo Locations ────────────────────────────────────────────────────────────

function rowToLocation(row: RepoLocationRow): RepoLocation {
  const ssh: SshConfig | null = row.ssh_host
    ? {
        host: row.ssh_host,
        user: row.ssh_user ?? '',
        port: row.ssh_port ?? undefined,
        keyPath: row.ssh_key_path ?? undefined,
      }
    : null
  const wsl: WslConfig | null = row.wsl_distro
    ? { distro: row.wsl_distro }
    : null
  return {
    id: row.id,
    project_id: row.project_id,
    pool_id: row.pool_id ?? null,
    checked_out: row.checked_out === 1,
    parent_location_id: row.parent_location_id ?? null,
    is_worktree: row.is_worktree === 1,
    worktree_id: row.worktree_id ?? null,
    label: row.label,
    connection_type: row.connection_type as ConnectionType,
    path: row.path,
    ssh,
    wsl,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function listLocations(projectId: string): RepoLocation[] {
  const rows = getDb()
    .prepare('SELECT * FROM repo_locations WHERE project_id = ? ORDER BY created_at ASC')
    .all(projectId) as RepoLocationRow[]
  return rows.map(rowToLocation)
}

export function createLocation(
  projectId: string,
  label: string,
  connectionType: ConnectionType,
  locationPath: string,
  poolId?: string | null,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null
): RepoLocation {
  const now = new Date().toISOString()
  const id = uuidv4()
  getDb()
    .prepare(
      'INSERT INTO repo_locations (id, project_id, pool_id, checked_out, parent_location_id, is_worktree, worktree_id, label, connection_type, path, ssh_host, ssh_user, ssh_port, ssh_key_path, wsl_distro, created_at, updated_at) VALUES (?, ?, ?, 0, NULL, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      id, projectId, poolId ?? null, label, connectionType, locationPath,
      ssh?.host ?? null, ssh?.user ?? null, ssh?.port ?? null, ssh?.keyPath ?? null,
      wsl?.distro ?? null,
      now, now
    )
  return {
    id,
    project_id: projectId,
    pool_id: poolId ?? null,
    checked_out: false,
    parent_location_id: null,
    is_worktree: false,
    worktree_id: null,
    label,
    connection_type: connectionType,
    path: locationPath,
    ssh: ssh ?? null,
    wsl: wsl ?? null,
    created_at: now,
    updated_at: now,
  }
}

export function updateLocation(
  id: string,
  label: string,
  connectionType: ConnectionType,
  locationPath: string,
  poolId?: string | null,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null
): void {
  getDb()
    .prepare(
      'UPDATE repo_locations SET label = ?, connection_type = ?, path = ?, pool_id = ?, checked_out = CASE WHEN ? IS NULL THEN 0 ELSE checked_out END, ssh_host = ?, ssh_user = ?, ssh_port = ?, ssh_key_path = ?, wsl_distro = ?, updated_at = ? WHERE id = ?'
    )
    .run(
      label, connectionType, locationPath,
      poolId ?? null, poolId ?? null,
      ssh?.host ?? null, ssh?.user ?? null, ssh?.port ?? null, ssh?.keyPath ?? null,
      wsl?.distro ?? null,
      new Date().toISOString(), id
    )
}

export function deleteLocation(id: string): void {
  getDb().prepare('DELETE FROM repo_locations WHERE id = ?').run(id)
}

export function getLocationById(id: string): RepoLocation | null {
  const row = getDb()
    .prepare('SELECT * FROM repo_locations WHERE id = ?')
    .get(id) as RepoLocationRow | undefined
  return row ? rowToLocation(row) : null
}

export function createWorktreeLocation(
  parentLocation: RepoLocation,
  label: string,
  locationPath: string,
  worktreeId?: number
): RepoLocation {
  const now = new Date().toISOString()
  const id = uuidv4()
  const assignedWorktreeId = worktreeId ?? getNextWorktreeId(parentLocation.id)
  getDb()
    .prepare(
      'INSERT INTO repo_locations (id, project_id, pool_id, checked_out, parent_location_id, is_worktree, worktree_id, label, connection_type, path, ssh_host, ssh_user, ssh_port, ssh_key_path, wsl_distro, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      id,
      parentLocation.project_id,
      parentLocation.id,
      assignedWorktreeId,
      label,
      parentLocation.connection_type,
      locationPath,
      parentLocation.ssh?.host ?? null,
      parentLocation.ssh?.user ?? null,
      parentLocation.ssh?.port ?? null,
      parentLocation.ssh?.keyPath ?? null,
      parentLocation.wsl?.distro ?? null,
      now,
      now
    )
  return {
    id,
    project_id: parentLocation.project_id,
    pool_id: null,
    checked_out: false,
    parent_location_id: parentLocation.id,
    is_worktree: true,
    worktree_id: assignedWorktreeId,
    label,
    connection_type: parentLocation.connection_type,
    path: locationPath,
    ssh: parentLocation.ssh ?? null,
    wsl: parentLocation.wsl ?? null,
    created_at: now,
    updated_at: now,
  }
}

export function getNextWorktreeId(parentLocationId: string): number {
  const rows = getDb()
    .prepare('SELECT worktree_id FROM repo_locations WHERE parent_location_id = ? AND is_worktree = 1 AND worktree_id IS NOT NULL ORDER BY worktree_id ASC')
    .all(parentLocationId) as Array<{ worktree_id: number }>
  const used = new Set(rows.map((row) => row.worktree_id).filter((id) => Number.isInteger(id) && id > 0))
  let next = 2
  while (used.has(next)) next += 1
  return next
}

export function getLocationForThread(threadId: string): RepoLocation | null {
  const row = getDb()
    .prepare('SELECT l.* FROM repo_locations l JOIN threads t ON t.location_id = l.id WHERE t.id = ?')
    .get(threadId) as RepoLocationRow | undefined
  return row ? rowToLocation(row) : null
}

// ── Location Pools ───────────────────────────────────────────────────────────

function rowToLocationPool(row: LocationPoolRow): LocationPool {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function listLocationPools(projectId: string): LocationPool[] {
  try {
    const rows = getDb()
      .prepare('SELECT * FROM location_pools WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as LocationPoolRow[]
    return rows.map(rowToLocationPool)
  } catch {
    // Defensive fallback for older DBs before migration is applied.
    return []
  }
}

export function createLocationPool(projectId: string, name: string): LocationPool {
  const now = new Date().toISOString()
  const id = uuidv4()
  getDb()
    .prepare('INSERT INTO location_pools (id, project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, projectId, name, now, now)
  return { id, project_id: projectId, name, created_at: now, updated_at: now }
}

export function updateLocationPool(id: string, name: string): void {
  getDb()
    .prepare('UPDATE location_pools SET name = ?, updated_at = ? WHERE id = ?')
    .run(name, new Date().toISOString(), id)
}

export function deleteLocationPool(id: string): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare('UPDATE repo_locations SET pool_id = NULL, checked_out = 0, updated_at = ? WHERE pool_id = ?')
    .run(now, id)
  db.prepare('DELETE FROM location_pools WHERE id = ?').run(id)
}

export function checkoutLocation(id: string): void {
  getDb()
    .prepare('UPDATE repo_locations SET checked_out = 1, updated_at = ? WHERE id = ? AND pool_id IS NOT NULL')
    .run(new Date().toISOString(), id)
}

export function returnLocationToPool(id: string): void {
  getDb()
    .prepare('UPDATE repo_locations SET checked_out = 0, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id)
}

export function getProjectByName(name: string): Project | null {
  const row = getDb()
    .prepare('SELECT * FROM projects WHERE name = ? AND archived_at IS NULL')
    .get(name) as ProjectRow | undefined
  return row ? rowToProject(row) : null
}

export function getLocationByLabel(projectId: string, label: string): RepoLocation | null {
  const row = getDb()
    .prepare('SELECT * FROM repo_locations WHERE project_id = ? AND label = ?')
    .get(projectId, label) as RepoLocationRow | undefined
  return row ? rowToLocation(row) : null
}

export function getPoolByName(projectId: string, name: string): LocationPool | null {
  const row = getDb()
    .prepare('SELECT * FROM location_pools WHERE project_id = ? AND name = ?')
    .get(projectId, name) as LocationPoolRow | undefined
  return row ? rowToLocationPool(row) : null
}

export function getNextAvailablePoolLocation(poolId: string): RepoLocation | null {
  const row = getDb()
    .prepare('SELECT * FROM repo_locations WHERE pool_id = ? AND checked_out = 0 ORDER BY created_at ASC LIMIT 1')
    .get(poolId) as RepoLocationRow | undefined
  return row ? rowToLocation(row) : null
}

/** Find a location whose path matches (prefix match for file lookups). */
export function getLocationByPath(path: string): RepoLocation | null {
  // Exact match first
  const exact = getDb()
    .prepare('SELECT * FROM repo_locations WHERE path = ?')
    .get(path) as RepoLocationRow | undefined
  if (exact) return rowToLocation(exact)

  // Prefix match — find a location whose path is a prefix of the given path
  const allLocations = getDb()
    .prepare('SELECT * FROM repo_locations')
    .all() as RepoLocationRow[]
  for (const loc of allLocations) {
    // Require a path separator after the location path to avoid matching e.g.
    // "C:\repos\Foo" as a prefix of "C:\repos\FooBar".
    const locPathFwd = loc.path.endsWith('/') ? loc.path : loc.path + '/'
    const locPathBack = loc.path.endsWith('\\') ? loc.path : loc.path + '\\'
    if (path.startsWith(locPathFwd) || path.startsWith(locPathBack)) {
      return rowToLocation(loc)
    }
  }
  return null
}

// ── Threads ───────────────────────────────────────────────────────────────────

const VALID_REASONING_LEVELS: ReasoningLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const VALID_PERMISSION_MODES: PermissionMode[] = ['ask', 'auto', 'workspace', 'yolo']
const VALID_CODEX_PERSONALITIES: CodexPersonality[] = ['none', 'friendly', 'pragmatic']
const VALID_CODEX_SUMMARIES: CodexReasoningSummary[] = ['auto', 'concise', 'detailed', 'none']

function normalizeReasoningLevel(level: string | null | undefined): ReasoningLevel {
  return VALID_REASONING_LEVELS.includes(level as ReasoningLevel) ? level as ReasoningLevel : 'off'
}

function normalizePermissionMode(mode: string | null | undefined, yoloMode?: number | boolean): PermissionMode {
  if (VALID_PERMISSION_MODES.includes(mode as PermissionMode)) return mode as PermissionMode
  return yoloMode === 1 || yoloMode === true ? 'yolo' : 'ask'
}

function normalizeCodexPersonality(value: string | null | undefined): CodexPersonality {
  return VALID_CODEX_PERSONALITIES.includes(value as CodexPersonality) ? value as CodexPersonality : 'none'
}

function normalizeCodexReasoningSummary(value: string | null | undefined): CodexReasoningSummary {
  return VALID_CODEX_SUMMARIES.includes(value as CodexReasoningSummary) ? value as CodexReasoningSummary : 'auto'
}

function rowToThread(r: ThreadRow): Thread {
  // Validate provider/model pairing — fix mismatches caused by stale data
  const provider = (r.provider ?? 'claude-code') as Provider
  const validModels = getModelsForProvider(provider).map((m) => m.id as string)
  const model = provider === 'claude-code' || provider === 'codex' || provider === 'pi' || provider === 'cursor' || provider === 'grok' || validModels.includes(r.model) ? r.model : getDefaultModelForProvider(provider)
  const permissionMode = normalizePermissionMode(r.permission_mode, r.yolo_mode)
  return {
    id: r.id,
    project_id: r.project_id,
    location_id: r.location_id ?? null,
    name: r.name,
    provider,
    model,
    reasoning_level: normalizeReasoningLevel(r.reasoning_level),
    codex_personality: normalizeCodexPersonality(r.codex_personality),
    codex_reasoning_summary: normalizeCodexReasoningSummary(r.codex_reasoning_summary),
    cursor_thinking: r.cursor_thinking == null ? null : r.cursor_thinking === 1,
    cursor_context: r.cursor_context ?? null,
    status: r.status as Thread['status'],
    archived: r.archived === 1,
    input_tokens: r.input_tokens ?? 0,
    output_tokens: r.output_tokens ?? 0,
    context_window: r.context_window ?? 0,
    unread: (r.unread ?? 0) === 1,
    has_messages: (r.has_messages ?? 0) === 1,
    permission_mode: permissionMode,
    yolo_mode: permissionMode === 'yolo',
    use_wsl: r.use_wsl === 1,
    wsl_distro: r.wsl_distro ?? null,
    git_branch: r.git_branch ?? null,
    routine_id: r.routine_id ?? null,
    run_state: (r.run_state as Thread['run_state']) ?? null,
    run_detail: r.run_detail ?? null,
    last_turn_started_at: r.last_turn_started_at ?? null,
    last_turn_completed_at: r.last_turn_completed_at ?? null,
    snoozed_until: r.snoozed_until ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

/**
 * Runs (threads with routine_id) are hidden from the default thread list —
 * except escalated runs, which surface alongside user threads so failures
 * are never silent.
 */
const THREAD_VISIBILITY_FILTER = "(t.routine_id IS NULL OR t.run_state = 'escalated')"

/**
 * Latest Turn event on a thread — completion or start, whichever is newer —
 * falling back to creation time for threads that have never run. Scalar
 * `MAX()` returns NULL when any argument is NULL, so the COALESCE chain
 * handles partially-stamped threads.
 */
const THREAD_TURN_ACTIVITY =
  'COALESCE(MAX(t.last_turn_completed_at, t.last_turn_started_at), t.last_turn_completed_at, t.last_turn_started_at, t.created_at)'

/**
 * Hides threads whose snooze has not yet expired. Woken threads (wake time in
 * the past) pass, which is what lets them lead the Queue.
 *
 * Per ADR-0002 this is a *presentation* predicate: apply it where threads are
 * listed for a human, never where they are counted to decide whether work can
 * be destroyed. `listActiveThreadsForLocation` deliberately omits it — see the
 * comment there.
 *
 * Callers must bind one `?` with the current ISO instant.
 */
const THREAD_NOT_SNOOZED = '(t.snoozed_until IS NULL OR t.snoozed_until <= ?)'

/** Only the wake time is in the future — i.e. actively snoozed, not woken. */
const THREAD_IS_SNOOZED = '(t.snoozed_until IS NOT NULL AND t.snoozed_until > ?)'

function nowIso(): string {
  return new Date().toISOString()
}

export function listThreads(projectId: string): Thread[] {
  const rows = getDb()
    .prepare(
      'SELECT t.*, EXISTS(SELECT 1 FROM messages WHERE thread_id = t.id) AS has_messages FROM threads t WHERE t.project_id = ? AND t.archived = 0 AND ' + THREAD_VISIBILITY_FILTER + ' AND ' + THREAD_NOT_SNOOZED + ' ORDER BY ' + THREAD_TURN_ACTIVITY + ' DESC'
    )
    .all(projectId, nowIso()) as ThreadRow[]
  return rows.map(rowToThread)
}

/**
 * Live threads at a location, used to decide whether a worktree still holds
 * work and may be cleaned up.
 *
 * Deliberately does NOT filter snoozed threads. Snooze is a statement about the
 * user's attention, not about a thread's lifecycle: a snoozed thread's work is
 * live. Filtering here would make a location whose only thread is snoozed look
 * empty and get its worktree destroyed with real work inside it. This omission
 * is the whole point of ADR-0002 — do not "fix" it for consistency.
 */
export function listActiveThreadsForLocation(locationId: string): Thread[] {
  const rows = getDb()
    .prepare(
      'SELECT t.*, EXISTS(SELECT 1 FROM messages WHERE thread_id = t.id) AS has_messages FROM threads t WHERE t.location_id = ? AND t.archived = 0 AND ' + THREAD_VISIBILITY_FILTER + ' ORDER BY ' + THREAD_TURN_ACTIVITY + ' DESC'
    )
    .all(locationId) as ThreadRow[]
  return rows.map(rowToThread)
}

/**
 * The Queue: every attention-relevant thread across unarchived projects.
 * Archived threads and archived projects are excluded; Runs appear only when
 * escalated (the standard visibility rule). Rows carry denormalized project
 * and location context so the renderer needs no per-project store loads.
 * Bucketing (needs-attention vs running) happens in the renderer, where live
 * push-driven status overrides the persisted snapshot.
 */
export function listQueueThreads(): QueueThread[] {
  const rows = getDb()
    .prepare(
      `SELECT t.*,
              EXISTS(SELECT 1 FROM messages WHERE thread_id = t.id) AS has_messages,
              p.name AS project_name,
              l.label AS location_label,
              COALESCE(l.is_worktree, 0) AS location_is_worktree
       FROM threads t
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN repo_locations l ON l.id = t.location_id
       WHERE t.archived = 0 AND p.archived_at IS NULL AND ${THREAD_VISIBILITY_FILTER} AND ${THREAD_NOT_SNOOZED}
       ORDER BY ${THREAD_TURN_ACTIVITY} DESC`
    )
    .all(nowIso()) as Array<ThreadRow & { project_name: string; location_label: string | null; location_is_worktree: number }>
  return rows.map((r) => ({
    ...rowToThread(r),
    project_name: r.project_name,
    location_label: r.location_label ?? null,
    location_is_worktree: r.location_is_worktree === 1,
  }))
}

/**
 * Snoozed threads for the Queue's collapsed Snoozed section: cross-project
 * (unarchived projects only), soonest to wake first, with optional name search
 * and paging. Mirrors `listArchivedQueueThreads`.
 *
 * Ordered by wake time rather than turn activity because "what comes back next"
 * is the only useful way to scan a list of deferred work.
 */
export function listSnoozedQueueThreads(search: string | null, limit: number, offset: number): QueueThread[] {
  const query = search?.trim()
  const rows = getDb()
    .prepare(
      `SELECT t.*,
              EXISTS(SELECT 1 FROM messages WHERE thread_id = t.id) AS has_messages,
              p.name AS project_name,
              l.label AS location_label,
              COALESCE(l.is_worktree, 0) AS location_is_worktree
       FROM threads t
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN repo_locations l ON l.id = t.location_id
       WHERE t.archived = 0 AND p.archived_at IS NULL AND ${THREAD_IS_SNOOZED}${query ? ' AND t.name LIKE ?' : ''}
       ORDER BY t.snoozed_until ASC
       LIMIT ? OFFSET ?`
    )
    .all(...(query ? [nowIso(), `%${query}%`, limit, offset] : [nowIso(), limit, offset])) as Array<ThreadRow & { project_name: string; location_label: string | null; location_is_worktree: number }>
  return rows.map((r) => ({
    ...rowToThread(r),
    project_name: r.project_name,
    location_label: r.location_label ?? null,
    location_is_worktree: r.location_is_worktree === 1,
  }))
}

/**
 * Archived threads for the Queue's collapsed Archived section: cross-project
 * (unarchived projects only), newest turn activity first, with optional
 * name search and paging. Mirrors the tree's archived list, which applies no
 * Run-visibility filter.
 */
export function listArchivedQueueThreads(search: string | null, limit: number, offset: number): QueueThread[] {
  const query = search?.trim()
  const rows = getDb()
    .prepare(
      `SELECT t.*,
              EXISTS(SELECT 1 FROM messages WHERE thread_id = t.id) AS has_messages,
              p.name AS project_name,
              l.label AS location_label,
              COALESCE(l.is_worktree, 0) AS location_is_worktree
       FROM threads t
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN repo_locations l ON l.id = t.location_id
       WHERE t.archived = 1 AND p.archived_at IS NULL${query ? ' AND t.name LIKE ?' : ''}
       ORDER BY ${THREAD_TURN_ACTIVITY} DESC
       LIMIT ? OFFSET ?`
    )
    .all(...(query ? [`%${query}%`, limit, offset] : [limit, offset])) as Array<ThreadRow & { project_name: string; location_label: string | null; location_is_worktree: number }>
  return rows.map((r) => ({
    ...rowToThread(r),
    project_name: r.project_name,
    location_label: r.location_label ?? null,
    location_is_worktree: r.location_is_worktree === 1,
  }))
}

export function archivedThreadCount(projectId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) as count FROM threads WHERE project_id = ? AND archived = 1')
    .get(projectId) as { count: number }
  return row.count
}

export function listArchivedThreads(projectId: string, limit?: number, offset?: number): Thread[] {
  const rows = getDb()
    .prepare(
      'SELECT t.*, EXISTS(SELECT 1 FROM messages WHERE thread_id = t.id) AS has_messages FROM threads t WHERE t.project_id = ? AND t.archived = 1 ORDER BY t.updated_at DESC LIMIT ? OFFSET ?'
    )
    .all(projectId, limit ?? -1, offset ?? 0) as ThreadRow[]
  return rows.map(rowToThread)
}

/**
 * Snoozed threads for one project, for the tree view's per-project Snoozed
 * section. Soonest to wake first, paged like the archived list. Counted by
 * `snoozedThreadCount`, which must keep the same predicate or the pager drifts.
 */
export function listSnoozedThreads(projectId: string, limit?: number, offset?: number): Thread[] {
  const rows = getDb()
    .prepare(
      'SELECT t.*, EXISTS(SELECT 1 FROM messages WHERE thread_id = t.id) AS has_messages FROM threads t WHERE t.project_id = ? AND t.archived = 0 AND ' + THREAD_IS_SNOOZED + ' ORDER BY t.snoozed_until ASC LIMIT ? OFFSET ?'
    )
    .all(projectId, nowIso(), limit ?? -1, offset ?? 0) as ThreadRow[]
  return rows.map(rowToThread)
}

export function snoozedThreadCount(projectId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) as count FROM threads t WHERE t.project_id = ? AND t.archived = 0 AND ' + THREAD_IS_SNOOZED)
    .get(projectId, nowIso()) as { count: number }
  return row.count
}

export function threadHasMessages(id: string): boolean {
  const row = getDb()
    .prepare('SELECT COUNT(*) as count FROM messages WHERE thread_id = ?')
    .get(id) as { count: number }
  return row.count > 0
}

/**
 * Defers a thread until `until` (an absolute ISO instant resolved by the
 * client, so relative choices mean what they mean where the user is).
 *
 * Does not touch `updated_at`: snoozing is not activity on the thread, and
 * bumping it would reorder lists that sort on it.
 */
export function snoozeThread(id: string, until: string): void {
  getDb().prepare('UPDATE threads SET snoozed_until = ? WHERE id = ?').run(until, id)
}

/**
 * Ends a snooze immediately, whether pending or already woken. Used both by the
 * explicit "Wake now" action and by the user submitting a Turn, which is what
 * discharges the woken state.
 */
export function unsnoozeThread(id: string): void {
  getDb().prepare('UPDATE threads SET snoozed_until = NULL WHERE id = ?').run(id)
}

/**
 * Archiving discards any snooze: a thread is never both snoozed and archived,
 * and unarchiving returns it to active rather than back to snoozed.
 */
export function archiveThread(id: string): void {
  getDb()
    .prepare('UPDATE threads SET archived = 1, snoozed_until = NULL, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id)
}

export function unarchiveThread(id: string): void {
  getDb()
    .prepare('UPDATE threads SET archived = 0, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id)
}

export interface CreateThreadOptions {
  /** Marks the thread as a Run of this Routine (hidden from default lists). */
  routineId?: string
  permissionMode?: PermissionMode
}

export function createThread(projectId: string, name: string, locationId: string | null, provider = 'claude-code', model = 'claude-opus-4-8', gitBranch: string | null = null, opts: CreateThreadOptions = {}): Thread {
  const now = new Date().toISOString()
  const permissionMode = normalizePermissionMode(opts.permissionMode ?? 'ask')
  const thread: ThreadRow = {
    id: uuidv4(),
    project_id: projectId,
    location_id: locationId,
    name,
    provider,
    model,
    reasoning_level: 'off',
    codex_personality: 'none',
    codex_reasoning_summary: 'auto',
    cursor_thinking: null,
    cursor_context: null,
    status: 'idle',
    archived: 0,
    input_tokens: 0,
    output_tokens: 0,
    context_window: 0,
    unread: 0,
    has_messages: 0,
    permission_mode: permissionMode,
    yolo_mode: permissionMode === 'yolo' ? 1 : 0,
    use_wsl: 0,
    wsl_distro: null,
    git_branch: gitBranch,
    routine_id: opts.routineId ?? null,
    run_state: opts.routineId ? 'active' : null,
    run_detail: null,
    last_turn_started_at: null,
    last_turn_completed_at: null,
    snoozed_until: null,
    created_at: now,
    updated_at: now
  }
  getDb()
    .prepare(
      'INSERT INTO threads (id, project_id, location_id, name, provider, model, reasoning_level, status, permission_mode, yolo_mode, git_branch, routine_id, run_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      thread.id,
      thread.project_id,
      thread.location_id,
      thread.name,
      thread.provider,
      thread.model,
      thread.reasoning_level,
      thread.status,
      thread.permission_mode,
      thread.yolo_mode,
      thread.git_branch,
      thread.routine_id,
      thread.run_state,
      thread.created_at,
      thread.updated_at
    )
  return rowToThread(thread)
}

// ── Routines ─────────────────────────────────────────────────────────────────

const VALID_TRIGGER_TYPES: RoutineTriggerType[] = ['cron', 'once', 'manual']

function rowToRoutine(r: RoutineRow): Routine {
  return {
    id: r.id,
    project_id: r.project_id,
    location_id: r.location_id,
    name: r.name,
    prompt: r.prompt,
    trigger_type: VALID_TRIGGER_TYPES.includes(r.trigger_type as RoutineTriggerType) ? (r.trigger_type as RoutineTriggerType) : 'manual',
    schedule: r.schedule ?? null,
    provider: r.provider,
    model: r.model,
    permission_mode: normalizePermissionMode(r.permission_mode),
    enabled: r.enabled === 1,
    last_fired_at: r.last_fired_at ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

export function listRoutines(projectId: string): Routine[] {
  const rows = getDb()
    .prepare('SELECT * FROM routines WHERE project_id = ? ORDER BY created_at ASC')
    .all(projectId) as RoutineRow[]
  return rows.map(rowToRoutine)
}

export function listAllRoutines(): Routine[] {
  const rows = getDb().prepare('SELECT * FROM routines').all() as RoutineRow[]
  return rows.map(rowToRoutine)
}

export function getRoutine(id: string): Routine | null {
  const row = getDb().prepare('SELECT * FROM routines WHERE id = ?').get(id) as RoutineRow | undefined
  return row ? rowToRoutine(row) : null
}

export interface RoutineInput {
  project_id: string
  location_id: string
  name: string
  prompt: string
  trigger_type: RoutineTriggerType
  schedule: string | null
  provider: string
  model: string
  permission_mode: PermissionMode
  enabled: boolean
}

export function createRoutine(input: RoutineInput): Routine {
  const now = new Date().toISOString()
  const row: RoutineRow = {
    id: uuidv4(),
    project_id: input.project_id,
    location_id: input.location_id,
    name: input.name,
    prompt: input.prompt,
    trigger_type: input.trigger_type,
    schedule: input.schedule,
    provider: input.provider,
    model: input.model,
    permission_mode: input.permission_mode,
    enabled: input.enabled ? 1 : 0,
    last_fired_at: null,
    created_at: now,
    updated_at: now,
  }
  getDb()
    .prepare(
      'INSERT INTO routines (id, project_id, location_id, name, prompt, trigger_type, schedule, provider, model, permission_mode, enabled, last_fired_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(row.id, row.project_id, row.location_id, row.name, row.prompt, row.trigger_type, row.schedule, row.provider, row.model, row.permission_mode, row.enabled, row.last_fired_at, row.created_at, row.updated_at)
  return rowToRoutine(row)
}

export function updateRoutine(id: string, patch: Partial<Omit<RoutineInput, 'project_id'>>): Routine | null {
  const existing = getRoutine(id)
  if (!existing) return null
  const merged = {
    location_id: patch.location_id ?? existing.location_id,
    name: patch.name ?? existing.name,
    prompt: patch.prompt ?? existing.prompt,
    trigger_type: patch.trigger_type ?? existing.trigger_type,
    schedule: patch.schedule !== undefined ? patch.schedule : existing.schedule,
    provider: patch.provider ?? existing.provider,
    model: patch.model ?? existing.model,
    permission_mode: patch.permission_mode ?? existing.permission_mode,
    enabled: patch.enabled ?? existing.enabled,
  }
  getDb()
    .prepare('UPDATE routines SET location_id = ?, name = ?, prompt = ?, trigger_type = ?, schedule = ?, provider = ?, model = ?, permission_mode = ?, enabled = ?, updated_at = ? WHERE id = ?')
    .run(merged.location_id, merged.name, merged.prompt, merged.trigger_type, merged.schedule, merged.provider, merged.model, merged.permission_mode, merged.enabled ? 1 : 0, new Date().toISOString(), id)
  return getRoutine(id)
}

export function setRoutineEnabled(id: string, enabled: boolean): void {
  getDb()
    .prepare('UPDATE routines SET enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, new Date().toISOString(), id)
}

export function markRoutineFired(id: string, firedAt: string): void {
  getDb()
    .prepare('UPDATE routines SET last_fired_at = ?, updated_at = ? WHERE id = ?')
    .run(firedAt, new Date().toISOString(), id)
}

/**
 * Deleting a routine detaches its runs: they are archived and become plain
 * threads (routine_id cleared) so they join the normal Archived section.
 */
export function deleteRoutine(id: string): void {
  const db = getDb()
  db.transaction(() => {
    db.prepare("UPDATE threads SET archived = 1, routine_id = NULL, run_state = NULL, run_detail = NULL, updated_at = ? WHERE routine_id = ?")
      .run(new Date().toISOString(), id)
    db.prepare('DELETE FROM routines WHERE id = ?').run(id)
  })()
}

// ── Runs (threads spawned by routines) ───────────────────────────────────────

export function listRuns(routineId: string, limit?: number): Thread[] {
  const rows = getDb()
    .prepare(
      'SELECT t.*, EXISTS(SELECT 1 FROM messages WHERE thread_id = t.id) AS has_messages FROM threads t WHERE t.routine_id = ? ORDER BY t.created_at DESC LIMIT ?'
    )
    .all(routineId, limit ?? -1) as ThreadRow[]
  return rows.map(rowToThread)
}

/** Runs still marked active — used at startup to escalate interrupted runs. */
export function listActiveRuns(): Thread[] {
  const rows = getDb()
    .prepare("SELECT t.*, 1 AS has_messages FROM threads t WHERE t.routine_id IS NOT NULL AND t.run_state = 'active'")
    .all() as ThreadRow[]
  return rows.map(rowToThread)
}

export function hasActiveRun(routineId: string): boolean {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS count FROM threads WHERE routine_id = ? AND run_state = 'active'")
    .get(routineId) as { count: number }
  return row.count > 0
}

export function hasEscalatedRun(routineId: string): boolean {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS count FROM threads WHERE routine_id = ? AND run_state = 'escalated'")
    .get(routineId) as { count: number }
  return row.count > 0
}

export function setRunState(threadId: string, state: RunState, detail: string | null = null): void {
  const now = new Date().toISOString()
  if (state === 'escalated') {
    // Escalation is the Run's turn-completion-equivalent: it enters the
    // Queue's attention bucket ordered by when it escalated.
    getDb()
      .prepare('UPDATE threads SET run_state = ?, run_detail = ?, last_turn_completed_at = ?, updated_at = ? WHERE id = ?')
      .run(state, detail, now, now, threadId)
  } else {
    getDb()
      .prepare('UPDATE threads SET run_state = ?, run_detail = ?, updated_at = ? WHERE id = ?')
      .run(state, detail, now, threadId)
  }
}

export function updateThreadModel(id: string, model: string): void {
  const now = new Date().toISOString()
  getDb()
    .prepare('UPDATE threads SET model = ?, updated_at = ?, provider_model_updated_at = ? WHERE id = ?')
    .run(model, now, now, id)
}

export function updateThreadProviderAndModel(id: string, provider: string, model: string): void {
  const now = new Date().toISOString()
  getDb()
    .prepare('UPDATE threads SET provider = ?, model = ?, updated_at = ?, provider_model_updated_at = ? WHERE id = ?')
    .run(provider, model, now, now, id)
}

export function updateThreadReasoningLevel(id: string, reasoningLevel: string): void {
  getDb()
    .prepare('UPDATE threads SET reasoning_level = ?, updated_at = ? WHERE id = ?')
    .run(normalizeReasoningLevel(reasoningLevel), new Date().toISOString(), id)
}

export function updateThreadCodexPersonality(id: string, personality: string): void {
  getDb()
    .prepare('UPDATE threads SET codex_personality = ?, updated_at = ? WHERE id = ?')
    .run(normalizeCodexPersonality(personality), new Date().toISOString(), id)
}

export function updateThreadCodexReasoningSummary(id: string, summary: string): void {
  getDb()
    .prepare('UPDATE threads SET codex_reasoning_summary = ?, updated_at = ? WHERE id = ?')
    .run(normalizeCodexReasoningSummary(summary), new Date().toISOString(), id)
}

export function updateThreadCursorThinking(id: string, thinking: boolean | null): void {
  getDb()
    .prepare('UPDATE threads SET cursor_thinking = ?, updated_at = ? WHERE id = ?')
    .run(thinking == null ? null : thinking ? 1 : 0, new Date().toISOString(), id)
}

export function updateThreadCursorContext(id: string, context: string | null): void {
  const value = context && context.trim() ? context.trim() : null
  getDb()
    .prepare('UPDATE threads SET cursor_context = ?, updated_at = ? WHERE id = ?')
    .run(value, new Date().toISOString(), id)
}

export function updateThreadYoloMode(id: string, yoloMode: boolean): void {
  updateThreadPermissionMode(id, yoloMode ? 'yolo' : 'ask')
}

export function updateThreadPermissionMode(id: string, permissionMode: string): void {
  const normalized = normalizePermissionMode(permissionMode)
  getDb()
    .prepare('UPDATE threads SET permission_mode = ?, yolo_mode = ?, updated_at = ? WHERE id = ?')
    .run(normalized, normalized === 'yolo' ? 1 : 0, new Date().toISOString(), id)
}

export function updateThreadLocationId(id: string, locationId: string | null): void {
  getDb()
    .prepare('UPDATE threads SET location_id = ?, updated_at = ? WHERE id = ?')
    .run(locationId, new Date().toISOString(), id)
}

export function deleteThread(id: string): void {
  getDb().prepare('DELETE FROM threads WHERE id = ?').run(id)
}

export function getThreadById(id: string): Thread | null {
  const row = getDb()
    .prepare('SELECT t.*, EXISTS(SELECT 1 FROM messages WHERE thread_id = t.id) AS has_messages FROM threads t WHERE t.id = ?')
    .get(id) as ThreadRow | undefined
  return row ? rowToThread(row) : null
}

export function threadExists(id: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS found FROM threads WHERE id = ? LIMIT 1')
    .get(id) as { found: number } | undefined
  return !!row
}

/** Statuses that complete a Turn when reached from `running`/`stopping`: the
 * provider finished, errored, was stopped, or paused for user input. */
const TURN_COMPLETING_STATUSES = ['idle', 'error', 'stopped', 'plan_pending', 'question_pending', 'permission_pending']

export function updateThreadStatus(id: string, status: string): void {
  const now = new Date().toISOString()
  const current = getDb().prepare('SELECT status FROM threads WHERE id = ?').get(id) as { status: string } | undefined
  const prev = current?.status
  const startsTurn = status === 'running' && prev !== 'running'
  const completesTurn = (prev === 'running' || prev === 'stopping') && TURN_COMPLETING_STATUSES.includes(status)
  if (startsTurn) {
    getDb()
      .prepare('UPDATE threads SET status = ?, last_turn_started_at = ?, updated_at = ? WHERE id = ?')
      .run(status, now, now, id)
  } else if (completesTurn) {
    getDb()
      .prepare('UPDATE threads SET status = ?, last_turn_completed_at = ?, updated_at = ? WHERE id = ?')
      .run(status, now, now, id)
  } else {
    getDb()
      .prepare('UPDATE threads SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, id)
  }
}

export function updateThreadUnread(id: string, unread: boolean): void {
  getDb()
    .prepare('UPDATE threads SET unread = ? WHERE id = ?')
    .run(unread ? 1 : 0, id)
}

/** Returns true if any thread is currently running. */
export function hasRunningThreads(): boolean {
  const row = getDb()
    .prepare("SELECT COUNT(*) as count FROM threads WHERE status = 'running'")
    .get() as { count: number }
  return row.count > 0
}

/** Reset any threads left in 'running' state from a previous crash/restart.
 * The interrupted turn is stamped as completed so these threads surface in the
 * Queue's attention bucket rather than sorting on a stale timestamp. */
export function resetRunningThreads(): void {
  const now = new Date().toISOString()
  getDb()
    .prepare("UPDATE threads SET status = 'idle', last_turn_completed_at = ?, updated_at = ? WHERE status = 'running'")
    .run(now, now)
}

export function getThreadWsl(id: string): { use_wsl: boolean; wsl_distro: string | null } {
  const row = getDb()
    .prepare('SELECT use_wsl, wsl_distro FROM threads WHERE id = ?')
    .get(id) as { use_wsl: number; wsl_distro: string | null } | undefined
  return { use_wsl: (row?.use_wsl ?? 0) === 1, wsl_distro: row?.wsl_distro ?? null }
}

export function getThreadYoloMode(id: string): boolean {
  return getThreadPermissionMode(id) === 'yolo'
}

export function getThreadPermissionMode(id: string): PermissionMode {
  const row = getDb()
    .prepare('SELECT permission_mode, yolo_mode FROM threads WHERE id = ?')
    .get(id) as { permission_mode?: string; yolo_mode: number } | undefined
  return normalizePermissionMode(row?.permission_mode, row?.yolo_mode)
}

/** Sets git_branch only if it hasn't been set yet. Returns true if it was updated. */
export function setThreadGitBranchIfUnset(id: string, branch: string): boolean {
  const result = getDb()
    .prepare('UPDATE threads SET git_branch = ?, updated_at = ? WHERE id = ? AND git_branch IS NULL')
    .run(branch, new Date().toISOString(), id)
  return result.changes > 0
}

export function updateThreadWsl(id: string, useWsl: boolean, wslDistro: string | null): void {
  getDb()
    .prepare('UPDATE threads SET use_wsl = ?, wsl_distro = ?, updated_at = ? WHERE id = ?')
    .run(useWsl ? 1 : 0, wslDistro, new Date().toISOString(), id)
}

export function updateThreadName(id: string, name: string): void {
  getDb()
    .prepare('UPDATE threads SET name = ?, updated_at = ? WHERE id = ?')
    .run(name, new Date().toISOString(), id)
}

export function getThreadModel(threadId: string): string {
  const row = getDb()
    .prepare('SELECT model FROM threads WHERE id = ?')
    .get(threadId) as { model: string | null } | undefined
  return row?.model ?? 'claude-opus-4-8'
}

export function getThreadProvider(threadId: string): string {
  const row = getDb()
    .prepare('SELECT provider FROM threads WHERE id = ?')
    .get(threadId) as { provider: string | null } | undefined
  return row?.provider ?? 'claude-code'
}

export function getThreadReasoningLevel(threadId: string): ReasoningLevel {
  const row = getDb()
    .prepare('SELECT reasoning_level FROM threads WHERE id = ?')
    .get(threadId) as { reasoning_level: string | null } | undefined
  return normalizeReasoningLevel(row?.reasoning_level)
}

export function getThreadCodexPersonality(threadId: string): CodexPersonality {
  const row = getDb()
    .prepare('SELECT codex_personality FROM threads WHERE id = ?')
    .get(threadId) as { codex_personality: string | null } | undefined
  return normalizeCodexPersonality(row?.codex_personality)
}

export function getThreadCodexReasoningSummary(threadId: string): CodexReasoningSummary {
  const row = getDb()
    .prepare('SELECT codex_reasoning_summary FROM threads WHERE id = ?')
    .get(threadId) as { codex_reasoning_summary: string | null } | undefined
  return normalizeCodexReasoningSummary(row?.codex_reasoning_summary)
}

export function getThreadCursorThinking(threadId: string): boolean | null {
  const row = getDb()
    .prepare('SELECT cursor_thinking FROM threads WHERE id = ?')
    .get(threadId) as { cursor_thinking: number | null } | undefined
  return row?.cursor_thinking == null ? null : row.cursor_thinking === 1
}

export function getThreadCursorContext(threadId: string): string | null {
  const row = getDb()
    .prepare('SELECT cursor_context FROM threads WHERE id = ?')
    .get(threadId) as { cursor_context: string | null } | undefined
  return row?.cursor_context ?? null
}

export function getThreadSessionId(threadId: string): string | null {
  const row = getDb()
    .prepare('SELECT claude_session_id FROM threads WHERE id = ?')
    .get(threadId) as { claude_session_id: string | null } | undefined
  return row?.claude_session_id ?? null
}

export function getImportedSessionIds(projectId: string): string[] {
  const rows = getDb()
    .prepare('SELECT claude_session_id FROM threads WHERE project_id = ? AND claude_session_id IS NOT NULL')
    .all(projectId) as { claude_session_id: string }[]
  return rows.map(r => r.claude_session_id)
}

/** Get the provider and model from the thread where provider/model was most recently explicitly changed. */
export function getLastUsedProviderAndModel(projectId: string): { provider: string; model: string } {
  // Prefer threads where provider_model_updated_at was explicitly set; fall back to most recently updated
  const row = getDb()
    .prepare(
      'SELECT provider, model FROM threads WHERE project_id = ? ORDER BY provider_model_updated_at DESC NULLS LAST, updated_at DESC LIMIT 1'
    )
    .get(projectId) as { provider: string; model: string } | undefined

  if (!row) return { provider: 'claude-code', model: 'claude-opus-4-8' }

  // Validate the pair before returning it
  const provider = (row.provider ?? 'claude-code') as Provider
  const validModels = getModelsForProvider(provider).map((m) => m.id as string)
  const model = provider === 'claude-code' || provider === 'codex' || provider === 'pi' || provider === 'cursor' || provider === 'grok' || validModels.includes(row.model) ? row.model : getDefaultModelForProvider(provider)
  return { provider, model }
}

export function updateThreadSessionId(threadId: string, sessionId: string): void {
  getDb()
    .prepare('UPDATE threads SET claude_session_id = ? WHERE id = ?')
    .run(sessionId, threadId)
}

/** Accumulate input/output token totals and optionally set context_window to the latest snapshot. */
export function updateThreadUsage(id: string, inputTokens: number, outputTokens: number, contextWindow: number | null): void {
  getDb()
    .prepare(
      'UPDATE threads SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, context_window = COALESCE(?, context_window), updated_at = ? WHERE id = ?'
    )
    .run(inputTokens, outputTokens, contextWindow, new Date().toISOString(), id)
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export function listSessions(threadId: string): Session[] {
  const rows = getDb()
    .prepare('SELECT * FROM sessions WHERE thread_id = ? ORDER BY created_at ASC')
    .all(threadId) as SessionRow[]
  return rows.map((r) => ({ ...r, is_active: r.is_active === 1 }))
}

export function createSession(threadId: string, name: string, claudeSessionId?: string): Session {
  const now = new Date().toISOString()
  const id = uuidv4()
  getDb()
    .prepare(
      'INSERT INTO sessions (id, thread_id, claude_session_id, name, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)'
    )
    .run(id, threadId, claudeSessionId ?? null, name, now, now)
  return {
    id,
    thread_id: threadId,
    claude_session_id: claudeSessionId ?? null,
    name,
    is_active: true,
    created_at: now,
    updated_at: now
  }
}

export function getActiveSession(threadId: string): Session | null {
  const row = getDb()
    .prepare('SELECT * FROM sessions WHERE thread_id = ? AND is_active = 1')
    .get(threadId) as SessionRow | undefined
  return row ? { ...row, is_active: true } : null
}

export function setActiveSession(threadId: string, sessionId: string): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare('UPDATE sessions SET is_active = 0 WHERE thread_id = ?').run(threadId)
  db.prepare('UPDATE sessions SET is_active = 1, updated_at = ? WHERE id = ?').run(now, sessionId)
}

export function updateSessionClaudeId(sessionId: string, claudeSessionId: string): void {
  getDb()
    .prepare('UPDATE sessions SET claude_session_id = ?, updated_at = ? WHERE id = ?')
    .run(claudeSessionId, new Date().toISOString(), sessionId)
}

export function getSessionClaudeId(sessionId: string): string | null {
  const row = getDb()
    .prepare('SELECT claude_session_id FROM sessions WHERE id = ?')
    .get(sessionId) as { claude_session_id: string | null } | undefined
  return row?.claude_session_id ?? null
}

export function getOrCreateActiveSession(threadId: string): Session {
  if (!threadExists(threadId)) {
    throw new Error(`Thread not found: ${threadId}`)
  }
  let session = getActiveSession(threadId)
  if (!session) {
    // Check if thread has a legacy claude_session_id we should migrate
    const legacyId = getThreadSessionId(threadId)
    session = createSession(threadId, 'Planning', legacyId ?? undefined)
  }
  return session
}

// ── Messages ──────────────────────────────────────────────────────────────────

export function listMessages(threadId: string): Message[] {
  const rows = getDb()
    .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC')
    .all(threadId) as MessageRow[]
  return foldMessages(rows as Message[])
}

export function insertMessage(
  threadId: string,
  role: string,
  content: string,
  metadata?: Record<string, unknown>,
  sessionId?: string,
  messageId?: string
): Message {
  const now = new Date().toISOString()
  const msg: MessageRow = {
    id: messageId ?? uuidv4(),
    thread_id: threadId,
    session_id: sessionId ?? null,
    role,
    content,
    metadata: metadata ? JSON.stringify(metadata) : null,
    created_at: now
  }
  getDb()
    .prepare(
      'INSERT INTO messages (id, thread_id, session_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(msg.id, msg.thread_id, msg.session_id, msg.role, msg.content, msg.metadata, msg.created_at)
  return msg as Message
}

export function listMessagesBySession(sessionId: string): Message[] {
  const rows = getDb()
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId) as MessageRow[]
  return foldMessages(rows as Message[])
}

/**
 * Find tool_call messages in a session that have no matching tool_result, then
 * insert a synthetic tool_result with `cancelled: true` for each. Returns the
 * inserted messages so callers can push them to the renderer.
 */
export function cancelPendingToolCalls(threadId: string, sessionId: string): Message[] {
  const messages = listMessagesBySession(sessionId)

  // Collect tool_use_ids that already have a result
  const resultedIds = new Set<string>()
  for (const msg of messages) {
    if (!msg.metadata) continue
    let meta: Record<string, unknown>
    try { meta = JSON.parse(msg.metadata as string) } catch { continue }
    if (meta.type === 'tool_result' && typeof meta.tool_use_id === 'string') {
      resultedIds.add(meta.tool_use_id)
    }
  }

  // Insert a synthetic cancelled result for each orphaned tool_call
  const inserted: Message[] = []
  for (const msg of messages) {
    if (!msg.metadata) continue
    let meta: Record<string, unknown>
    try { meta = JSON.parse(msg.metadata as string) } catch { continue }
    if (
      (meta.type === 'tool_call' || meta.type === 'tool_use') &&
      typeof meta.id === 'string' &&
      !resultedIds.has(meta.id)
    ) {
      inserted.push(
        insertMessage(
          threadId,
          'assistant',
          '',
          { type: 'tool_result', tool_use_id: meta.id, cancelled: true },
          sessionId
        )
      )
    }
  }

  return inserted
}

export interface ImportedMessage {
  role: string
  content: string
  metadata?: Record<string, unknown>
  created_at: string
}

// ── Thread Modified Files ────────────────────────────────────────────────────

interface ToolCallMetadata {
  type: 'tool_call'
  id: string          // Claude API tool_use block uses 'id'
  name: string
  input?: { file_path?: string; filePath?: string; changes?: Array<{ path: string; kind: string }> }
}

interface ToolResultMetadata {
  type: 'tool_result'
  tool_use_id: string
  is_error?: boolean
}

/**
 * Extract file paths from successful Edit/Write/MultiEdit tool calls in a thread.
 * Returns deduplicated absolute paths, resolving relative paths against workingDir.
 */
export function getThreadModifiedFiles(threadId: string, workingDir: string): string[] {
  const messages = listMessages(threadId)

  // Map tool_use_id -> file_path for Edit/Write calls
  const toolCallFiles = new Map<string, string>()
  // Set of tool_use_ids that had successful results
  const successfulToolIds = new Set<string>()

  for (const msg of messages) {
    if (!msg.metadata) continue

    let meta: ToolCallMetadata | ToolResultMetadata | undefined
    try {
      meta = typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : msg.metadata
    } catch {
      continue
    }

    if (!meta || typeof meta !== 'object' || !('type' in meta)) continue

    if (meta.type === 'tool_call' && ['edit', 'write', 'multiedit'].includes(meta.name.toLowerCase())) {
      const filePath = meta.input?.file_path ?? meta.input?.filePath
      if (filePath && meta.id) {
        toolCallFiles.set(meta.id, filePath)
      }
    } else if (meta.type === 'tool_call' && meta.name === 'FileChange' && Array.isArray(meta.input?.changes) && meta.id) {
      // Codex file_change items carry a changes array; track them all under the item id
      // by joining paths with a delimiter — they'll be split out below.
      const paths = (meta.input!.changes as Array<{ path: string; kind: string }>)
        .map((c) => c.path)
        .filter((path): path is string => typeof path === 'string' && path.length > 0)
      if (paths.length > 0) {
        toolCallFiles.set(meta.id, '\x00' + paths.join('\x00'))
      }
    } else if (meta.type === 'tool_result' && meta.tool_use_id) {
      // Consider it successful if is_error is not true
      if (meta.is_error !== true) {
        successfulToolIds.add(meta.tool_use_id)
      }
    }
  }

  // Collect unique file paths from successful tool calls
  const files = new Set<string>()
  for (const [toolId, filePath] of toolCallFiles) {
    if (successfulToolIds.has(toolId)) {
      // Multi-path encoding used by FileChange: paths joined by \x00, prefixed with \x00
      const rawPaths = filePath.startsWith('\x00')
        ? filePath.slice(1).split('\x00').filter(Boolean)
        : [filePath]
      for (const p of rawPaths) {
        // Resolve relative paths against workingDir
        const resolved = p.startsWith('/') || /^[a-zA-Z]:/.test(p)
          ? p
          : `${workingDir}/${p}`
        files.add(resolved)
      }
    }
  }

  return Array.from(files)
}

// ── Project Commands ──────────────────────────────────────────────────────────

function rowToCommand(row: ProjectCommandRow): ProjectCommand {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    command: row.command,
    cwd: row.cwd ?? null,
    shell: row.shell ?? null,
    run_on_worktree_create: row.run_on_worktree_create === 1,
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function listCommands(projectId: string): ProjectCommand[] {
  const rows = getDb()
    .prepare('SELECT * FROM project_commands WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC')
    .all(projectId) as ProjectCommandRow[]
  return rows.map(rowToCommand)
}

export function createCommand(projectId: string, name: string, command: string, cwd?: string | null, shell?: string | null, runOnWorktreeCreate = false): ProjectCommand {
  const now = new Date().toISOString()
  const id = uuidv4()
  const countRow = getDb()
    .prepare('SELECT COUNT(*) as count FROM project_commands WHERE project_id = ?')
    .get(projectId) as { count: number }
  const sortOrder = countRow.count
  getDb()
    .prepare(
      'INSERT INTO project_commands (id, project_id, name, command, cwd, shell, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, projectId, name, command, cwd ?? null, shell ?? null, sortOrder, now, now)
  if (runOnWorktreeCreate) {
    getDb().prepare('UPDATE project_commands SET run_on_worktree_create = 1 WHERE id = ?').run(id)
  }
  return { id, project_id: projectId, name, command, cwd: cwd ?? null, shell: shell ?? null, run_on_worktree_create: runOnWorktreeCreate, sort_order: sortOrder, created_at: now, updated_at: now }
}

export function updateCommand(id: string, name: string, command: string, cwd?: string | null, shell?: string | null, runOnWorktreeCreate = false): void {
  getDb()
    .prepare('UPDATE project_commands SET name = ?, command = ?, cwd = ?, shell = ?, run_on_worktree_create = ?, updated_at = ? WHERE id = ?')
    .run(name, command, cwd ?? null, shell ?? null, runOnWorktreeCreate ? 1 : 0, new Date().toISOString(), id)
}

export function deleteCommand(id: string): void {
  getDb().prepare('DELETE FROM project_commands WHERE id = ?').run(id)
}

export function getCommandById(id: string): ProjectCommand | null {
  const row = getDb()
    .prepare('SELECT * FROM project_commands WHERE id = ?')
    .get(id) as ProjectCommandRow | undefined
  return row ? rowToCommand(row) : null
}

// ── YouTrack Servers ──────────────────────────────────────────────────────────

function rowToYouTrackServer(row: YouTrackServerRow): YouTrackServer {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    token: row.token,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function listYouTrackServers(): YouTrackServer[] {
  const rows = getDb()
    .prepare('SELECT * FROM youtrack_servers ORDER BY created_at ASC')
    .all() as YouTrackServerRow[]
  return rows.map(rowToYouTrackServer)
}

export function createYouTrackServer(name: string, url: string, token: string): YouTrackServer {
  const now = new Date().toISOString()
  const id = uuidv4()
  getDb()
    .prepare('INSERT INTO youtrack_servers (id, name, url, token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, url, token, now, now)
  return { id, name, url, token, created_at: now, updated_at: now }
}

export function updateYouTrackServer(id: string, name: string, url: string, token: string): void {
  getDb()
    .prepare('UPDATE youtrack_servers SET name = ?, url = ?, token = ?, updated_at = ? WHERE id = ?')
    .run(name, url, token, new Date().toISOString(), id)
}

export function deleteYouTrackServer(id: string): void {
  getDb().prepare('DELETE FROM youtrack_servers WHERE id = ?').run(id)
}

// ── Slash Commands ────────────────────────────────────────────────────────────

function rowToSlashCommand(row: SlashCommandRow): SlashCommand {
  return {
    id: row.id,
    project_id: row.project_id ?? null,
    name: row.name,
    description: row.description ?? null,
    prompt: row.prompt,
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/** List global commands plus project-specific commands for the given projectId. */
export function listSlashCommands(projectId?: string | null): SlashCommand[] {
  if (projectId) {
    const rows = getDb()
      .prepare(
        'SELECT * FROM slash_commands WHERE project_id IS NULL OR project_id = ? ORDER BY project_id NULLS FIRST, sort_order ASC, created_at ASC'
      )
      .all(projectId) as SlashCommandRow[]
    return rows.map(rowToSlashCommand)
  }
  // Global only
  const rows = getDb()
    .prepare('SELECT * FROM slash_commands WHERE project_id IS NULL ORDER BY sort_order ASC, created_at ASC')
    .all() as SlashCommandRow[]
  return rows.map(rowToSlashCommand)
}

export function createSlashCommand(
  projectId: string | null,
  name: string,
  description: string | null,
  prompt: string
): SlashCommand {
  const now = new Date().toISOString()
  const id = uuidv4()
  const countRow = getDb()
    .prepare('SELECT COUNT(*) as count FROM slash_commands WHERE project_id IS ?')
    .get(projectId) as { count: number }
  const sortOrder = countRow.count
  getDb()
    .prepare(
      'INSERT INTO slash_commands (id, project_id, name, description, prompt, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, projectId, name, description, prompt, sortOrder, now, now)
  return { id, project_id: projectId, name, description, prompt, sort_order: sortOrder, created_at: now, updated_at: now }
}

export function updateSlashCommand(
  id: string,
  name: string,
  description: string | null,
  prompt: string
): void {
  getDb()
    .prepare('UPDATE slash_commands SET name = ?, description = ?, prompt = ?, updated_at = ? WHERE id = ?')
    .run(name, description, prompt, new Date().toISOString(), id)
}

export function deleteSlashCommand(id: string): void {
  getDb().prepare('DELETE FROM slash_commands WHERE id = ?').run(id)
}

export function importThread(
  projectId: string,
  locationId: string | null,
  name: string,
  claudeSessionId: string,
  messages: ImportedMessage[]
): Thread {
  const db = getDb()
  const now = new Date().toISOString()
  const threadId = uuidv4()
  const sessionId = uuidv4()
  const { provider, model } = getLastUsedProviderAndModel(projectId)

  // Create thread with claude_session_id pre-set for resumption
  const thread: ThreadRow = {
    id: threadId,
    project_id: projectId,
    location_id: locationId,
    name,
    provider,
    model,
    reasoning_level: 'off',
    codex_personality: 'none',
    codex_reasoning_summary: 'auto',
    cursor_thinking: null,
    cursor_context: null,
    last_turn_started_at: null,
    last_turn_completed_at: null,
    snoozed_until: null,
    status: 'idle',
    archived: 0,
    input_tokens: 0,
    output_tokens: 0,
    context_window: 0,
    unread: 0,
    has_messages: 1,
    permission_mode: 'ask',
    yolo_mode: 0,
    use_wsl: 0,
    wsl_distro: null,
    git_branch: null,
    routine_id: null,
    run_state: null,
    run_detail: null,
    created_at: now,
    updated_at: now
  }

  db.prepare(
    'INSERT INTO threads (id, project_id, location_id, name, provider, model, reasoning_level, status, claude_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    thread.id,
    thread.project_id,
    thread.location_id,
    thread.name,
    thread.provider,
    thread.model,
    thread.reasoning_level,
    thread.status,
    claudeSessionId,
    thread.created_at,
    thread.updated_at
  )

  // Create a session for this thread
  db.prepare(
    'INSERT INTO sessions (id, thread_id, claude_session_id, name, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)'
  ).run(sessionId, threadId, claudeSessionId, 'Planning', now, now)

  // Bulk insert messages with session_id
  const insertStmt = db.prepare(
    'INSERT INTO messages (id, thread_id, session_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )

  const insertMany = db.transaction((msgs: ImportedMessage[]) => {
    for (const msg of msgs) {
      insertStmt.run(
        uuidv4(),
        threadId,
        sessionId,
        msg.role,
        msg.content,
        msg.metadata ? JSON.stringify(msg.metadata) : null,
        msg.created_at
      )
    }
  })

  insertMany(messages)

  return rowToThread(thread)
}

// ── Settings ──────────────────────────────────────────────────────────────────

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}
