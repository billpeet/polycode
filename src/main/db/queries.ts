import { v4 as uuidv4 } from 'uuid'
import { getDb } from './index'
import { ProjectRow, ThreadRow, MessageRow, SessionRow } from './models'
import { Project, Thread, Message, Session } from '../../shared/types'

// ── Projects ──────────────────────────────────────────────────────────────────

export function listProjects(): Project[] {
  const rows = getDb().prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as ProjectRow[]
  return rows as Project[]
}

export function createProject(name: string, projectPath: string): Project {
  const now = new Date().toISOString()
  const project: ProjectRow = {
    id: uuidv4(),
    name,
    path: projectPath,
    created_at: now,
    updated_at: now
  }
  getDb()
    .prepare('INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(project.id, project.name, project.path, project.created_at, project.updated_at)
  return project as Project
}

export function updateProject(id: string, name: string, path: string): void {
  getDb()
    .prepare('UPDATE projects SET name = ?, path = ?, updated_at = ? WHERE id = ?')
    .run(name, path, new Date().toISOString(), id)
}

export function deleteProject(id: string): void {
  getDb().prepare('DELETE FROM projects WHERE id = ?').run(id)
}

// ── Threads ───────────────────────────────────────────────────────────────────

export function listThreads(projectId: string): Thread[] {
  const rows = getDb()
    .prepare('SELECT * FROM threads WHERE project_id = ? AND archived = 0 ORDER BY updated_at DESC')
    .all(projectId) as ThreadRow[]
  return rows.map((r) => ({ ...r, archived: r.archived === 1 })) as Thread[]
}

export function archivedThreadCount(projectId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) as count FROM threads WHERE project_id = ? AND archived = 1')
    .get(projectId) as { count: number }
  return row.count
}

export function listArchivedThreads(projectId: string): Thread[] {
  const rows = getDb()
    .prepare('SELECT * FROM threads WHERE project_id = ? AND archived = 1 ORDER BY updated_at DESC')
    .all(projectId) as ThreadRow[]
  return rows.map((r) => ({ ...r, archived: r.archived === 1 })) as Thread[]
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

export function createThread(projectId: string, name: string, provider = 'claude-code', model = 'claude-opus-4-5'): Thread {
  const now = new Date().toISOString()
  const thread: ThreadRow = {
    id: uuidv4(),
    project_id: projectId,
    name,
    provider,
    model,
    status: 'idle',
    archived: 0,
    created_at: now,
    updated_at: now
  }
  getDb()
    .prepare(
      'INSERT INTO threads (id, project_id, name, provider, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      thread.id,
      thread.project_id,
      thread.name,
      thread.provider,
      thread.model,
      thread.status,
      thread.created_at,
      thread.updated_at
    )
  return { ...thread, archived: false } as Thread
}

export function updateThreadModel(id: string, model: string): void {
  getDb()
    .prepare('UPDATE threads SET model = ?, updated_at = ? WHERE id = ?')
    .run(model, new Date().toISOString(), id)
}

export function deleteThread(id: string): void {
  getDb().prepare('DELETE FROM threads WHERE id = ?').run(id)
}

export function updateThreadStatus(id: string, status: string): void {
  getDb()
    .prepare('UPDATE threads SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), id)
}

/** Reset any threads left in 'running' state from a previous crash/restart. */
export function resetRunningThreads(): void {
  getDb()
    .prepare("UPDATE threads SET status = 'idle', updated_at = ? WHERE status = 'running'")
    .run(new Date().toISOString())
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

/** Get the model from the most recently updated thread in a project, or default. */
export function getLastUsedModel(projectId: string): string {
  const row = getDb()
    .prepare('SELECT model FROM threads WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1')
    .get(projectId) as { model: string } | undefined
  return row?.model ?? 'claude-opus-4-5'
}

export function updateThreadSessionId(threadId: string, sessionId: string): void {
  getDb()
    .prepare('UPDATE threads SET claude_session_id = ? WHERE id = ?')
    .run(sessionId, threadId)
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

export interface ImportedMessage {
  role: string
  content: string
  metadata?: Record<string, unknown>
  created_at: string
}

export function importThread(
  projectId: string,
  name: string,
  claudeSessionId: string,
  messages: ImportedMessage[]
): Thread {
  const db = getDb()
  const now = new Date().toISOString()
  const threadId = uuidv4()
  const sessionId = uuidv4()
  const model = getLastUsedModel(projectId)

  // Create thread with claude_session_id pre-set for resumption
  const thread: ThreadRow = {
    id: threadId,
    project_id: projectId,
    name,
    provider: 'claude-code',
    model,
    status: 'idle',
    archived: 0,
    created_at: now,
    updated_at: now
  }

  db.prepare(
    'INSERT INTO threads (id, project_id, name, provider, model, status, claude_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    thread.id,
    thread.project_id,
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

  return { ...thread, archived: false } as Thread
}
