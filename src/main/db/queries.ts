import { v4 as uuidv4 } from 'uuid'
import { getDb } from './index'
import { ProjectRow, RepoLocationRow, ThreadRow, MessageRow, SessionRow, ProjectCommandRow, YouTrackServerRow } from './models'
import { Project, Thread, Message, Session, RepoLocation, SshConfig, WslConfig, ConnectionType, Provider, getModelsForProvider, getDefaultModelForProvider, ProjectCommand, YouTrackServer } from '../../shared/types'

// ── Projects ──────────────────────────────────────────────────────────────────

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    git_url: row.git_url ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function listProjects(): Project[] {
  const rows = getDb().prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as ProjectRow[]
  return rows.map(rowToProject)
}

export function createProject(name: string, gitUrl?: string | null): Project {
  const now = new Date().toISOString()
  const id = uuidv4()
  getDb()
    .prepare(
      'INSERT INTO projects (id, name, path, git_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(id, name, '', gitUrl ?? null, now, now)
  return {
    id,
    name,
    git_url: gitUrl ?? null,
    created_at: now,
    updated_at: now,
  }
}

export function updateProject(id: string, name: string, gitUrl?: string | null): void {
  getDb()
    .prepare('UPDATE projects SET name = ?, git_url = ?, updated_at = ? WHERE id = ?')
    .run(name, gitUrl ?? null, new Date().toISOString(), id)
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
  ssh?: SshConfig | null,
  wsl?: WslConfig | null
): RepoLocation {
  const now = new Date().toISOString()
  const id = uuidv4()
  getDb()
    .prepare(
      'INSERT INTO repo_locations (id, project_id, label, connection_type, path, ssh_host, ssh_user, ssh_port, ssh_key_path, wsl_distro, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      id, projectId, label, connectionType, locationPath,
      ssh?.host ?? null, ssh?.user ?? null, ssh?.port ?? null, ssh?.keyPath ?? null,
      wsl?.distro ?? null,
      now, now
    )
  return {
    id,
    project_id: projectId,
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
  ssh?: SshConfig | null,
  wsl?: WslConfig | null
): void {
  getDb()
    .prepare(
      'UPDATE repo_locations SET label = ?, connection_type = ?, path = ?, ssh_host = ?, ssh_user = ?, ssh_port = ?, ssh_key_path = ?, wsl_distro = ?, updated_at = ? WHERE id = ?'
    )
    .run(
      label, connectionType, locationPath,
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

export function getLocationForThread(threadId: string): RepoLocation | null {
  const row = getDb()
    .prepare('SELECT l.* FROM repo_locations l JOIN threads t ON t.location_id = l.id WHERE t.id = ?')
    .get(threadId) as RepoLocationRow | undefined
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

function rowToThread(r: ThreadRow): Thread {
  // Validate provider/model pairing — fix mismatches caused by stale data
  const provider = (r.provider ?? 'claude-code') as Provider
  const validModels = getModelsForProvider(provider).map((m) => m.id as string)
  const model = validModels.includes(r.model) ? r.model : getDefaultModelForProvider(provider)
  return {
    id: r.id,
    project_id: r.project_id,
    location_id: r.location_id ?? null,
    name: r.name,
    provider,
    model,
    status: r.status as Thread['status'],
    archived: r.archived === 1,
    input_tokens: r.input_tokens ?? 0,
    output_tokens: r.output_tokens ?? 0,
    context_window: r.context_window ?? 0,
    has_messages: (r.has_messages ?? 0) === 1,
    use_wsl: r.use_wsl === 1,
    wsl_distro: r.wsl_distro ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

export function listThreads(projectId: string): Thread[] {
  const rows = getDb()
    .prepare(
      'SELECT t.*, EXISTS(SELECT 1 FROM messages WHERE thread_id = t.id) AS has_messages FROM threads t WHERE t.project_id = ? AND t.archived = 0 ORDER BY t.updated_at DESC'
    )
    .all(projectId) as ThreadRow[]
  return rows.map(rowToThread)
}

export function archivedThreadCount(projectId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) as count FROM threads WHERE project_id = ? AND archived = 1')
    .get(projectId) as { count: number }
  return row.count
}

export function listArchivedThreads(projectId: string): Thread[] {
  const rows = getDb()
    .prepare(
      'SELECT t.*, EXISTS(SELECT 1 FROM messages WHERE thread_id = t.id) AS has_messages FROM threads t WHERE t.project_id = ? AND t.archived = 1 ORDER BY t.updated_at DESC'
    )
    .all(projectId) as ThreadRow[]
  return rows.map(rowToThread)
}

export function threadHasMessages(id: string): boolean {
  const row = getDb()
    .prepare('SELECT COUNT(*) as count FROM messages WHERE thread_id = ?')
    .get(id) as { count: number }
  return row.count > 0
}

export function archiveThread(id: string): void {
  getDb()
    .prepare('UPDATE threads SET archived = 1, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id)
}

export function unarchiveThread(id: string): void {
  getDb()
    .prepare('UPDATE threads SET archived = 0, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id)
}

export function createThread(projectId: string, name: string, locationId: string | null, provider = 'claude-code', model = 'claude-opus-4-5'): Thread {
  const now = new Date().toISOString()
  const thread: ThreadRow = {
    id: uuidv4(),
    project_id: projectId,
    location_id: locationId,
    name,
    provider,
    model,
    status: 'idle',
    archived: 0,
    input_tokens: 0,
    output_tokens: 0,
    context_window: 0,
    has_messages: 0,
    use_wsl: 0,
    wsl_distro: null,
    created_at: now,
    updated_at: now
  }
  getDb()
    .prepare(
      'INSERT INTO threads (id, project_id, location_id, name, provider, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      thread.id,
      thread.project_id,
      thread.location_id,
      thread.name,
      thread.provider,
      thread.model,
      thread.status,
      thread.created_at,
      thread.updated_at
    )
  return rowToThread(thread)
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

export function deleteThread(id: string): void {
  getDb().prepare('DELETE FROM threads WHERE id = ?').run(id)
}

export function updateThreadStatus(id: string, status: string): void {
  getDb()
    .prepare('UPDATE threads SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), id)
}

/** Returns true if any thread is currently running. */
export function hasRunningThreads(): boolean {
  const row = getDb()
    .prepare("SELECT COUNT(*) as count FROM threads WHERE status = 'running'")
    .get() as { count: number }
  return row.count > 0
}

/** Reset any threads left in 'running' state from a previous crash/restart. */
export function resetRunningThreads(): void {
  getDb()
    .prepare("UPDATE threads SET status = 'idle', updated_at = ? WHERE status = 'running'")
    .run(new Date().toISOString())
}

export function getThreadWsl(id: string): { use_wsl: boolean; wsl_distro: string | null } {
  const row = getDb()
    .prepare('SELECT use_wsl, wsl_distro FROM threads WHERE id = ?')
    .get(id) as { use_wsl: number; wsl_distro: string | null } | undefined
  return { use_wsl: (row?.use_wsl ?? 0) === 1, wsl_distro: row?.wsl_distro ?? null }
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
  return row?.model ?? 'claude-opus-4-5'
}

export function getThreadProvider(threadId: string): string {
  const row = getDb()
    .prepare('SELECT provider FROM threads WHERE id = ?')
    .get(threadId) as { provider: string | null } | undefined
  return row?.provider ?? 'claude-code'
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

  if (!row) return { provider: 'claude-code', model: 'claude-opus-4-6' }

  // Validate the pair before returning it
  const provider = (row.provider ?? 'claude-code') as Provider
  const validModels = getModelsForProvider(provider).map((m) => m.id as string)
  const model = validModels.includes(row.model) ? row.model : getDefaultModelForProvider(provider)
  return { provider, model }
}

export function updateThreadSessionId(threadId: string, sessionId: string): void {
  getDb()
    .prepare('UPDATE threads SET claude_session_id = ? WHERE id = ?')
    .run(sessionId, threadId)
}

/** Accumulate input/output token totals and set context_window to latest snapshot. */
export function updateThreadUsage(id: string, inputTokens: number, outputTokens: number, contextWindow: number): void {
  getDb()
    .prepare(
      'UPDATE threads SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, context_window = ?, updated_at = ? WHERE id = ?'
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
  return rows as Message[]
}

export function insertMessage(
  threadId: string,
  role: string,
  content: string,
  metadata?: Record<string, unknown>,
  sessionId?: string
): Message {
  const now = new Date().toISOString()
  const msg: MessageRow = {
    id: uuidv4(),
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
  return rows as Message[]
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
  input?: { file_path?: string; filePath?: string }
}

interface ToolResultMetadata {
  type: 'tool_result'
  tool_use_id: string
  is_error?: boolean
}

/**
 * Extract file paths from successful Edit/Write tool calls in a thread.
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

    if (meta.type === 'tool_call' && (meta.name === 'Edit' || meta.name === 'Write' || meta.name === 'edit' || meta.name === 'write')) {
      const filePath = meta.input?.file_path ?? meta.input?.filePath
      if (filePath && meta.id) {
        toolCallFiles.set(meta.id, filePath)
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
      // Resolve relative paths against workingDir
      const resolved = filePath.startsWith('/') || /^[a-zA-Z]:/.test(filePath)
        ? filePath
        : `${workingDir}/${filePath}`
      files.add(resolved)
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

export function createCommand(projectId: string, name: string, command: string, cwd?: string | null): ProjectCommand {
  const now = new Date().toISOString()
  const id = uuidv4()
  const countRow = getDb()
    .prepare('SELECT COUNT(*) as count FROM project_commands WHERE project_id = ?')
    .get(projectId) as { count: number }
  const sortOrder = countRow.count
  getDb()
    .prepare(
      'INSERT INTO project_commands (id, project_id, name, command, cwd, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, projectId, name, command, cwd ?? null, sortOrder, now, now)
  return { id, project_id: projectId, name, command, cwd: cwd ?? null, sort_order: sortOrder, created_at: now, updated_at: now }
}

export function updateCommand(id: string, name: string, command: string, cwd?: string | null): void {
  getDb()
    .prepare('UPDATE project_commands SET name = ?, command = ?, cwd = ?, updated_at = ? WHERE id = ?')
    .run(name, command, cwd ?? null, new Date().toISOString(), id)
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
    status: 'idle',
    archived: 0,
    input_tokens: 0,
    output_tokens: 0,
    context_window: 0,
    has_messages: 1,
    use_wsl: 0,
    wsl_distro: null,
    created_at: now,
    updated_at: now
  }

  db.prepare(
    'INSERT INTO threads (id, project_id, location_id, name, provider, model, status, claude_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    thread.id,
    thread.project_id,
    thread.location_id,
    thread.name,
    thread.provider,
    thread.model,
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
