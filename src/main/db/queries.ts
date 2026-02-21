import { v4 as uuidv4 } from 'uuid'
import { getDb } from './index'
import { ProjectRow, ThreadRow, MessageRow } from './models'
import { Project, Thread, Message } from '../../shared/types'

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

export function updateThreadSessionId(threadId: string, sessionId: string): void {
  getDb()
    .prepare('UPDATE threads SET claude_session_id = ? WHERE id = ?')
    .run(sessionId, threadId)
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
  metadata?: Record<string, unknown>
): Message {
  const now = new Date().toISOString()
  const msg: MessageRow = {
    id: uuidv4(),
    thread_id: threadId,
    role,
    content,
    metadata: metadata ? JSON.stringify(metadata) : null,
    created_at: now
  }
  getDb()
    .prepare(
      'INSERT INTO messages (id, thread_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(msg.id, msg.thread_id, msg.role, msg.content, msg.metadata, msg.created_at)
  return msg as Message
}
