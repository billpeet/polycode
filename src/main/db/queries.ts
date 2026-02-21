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
    .prepare('SELECT * FROM threads WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId) as ThreadRow[]
  return rows as Thread[]
}

export function createThread(projectId: string, name: string, provider = 'claude-code'): Thread {
  const now = new Date().toISOString()
  const thread: ThreadRow = {
    id: uuidv4(),
    project_id: projectId,
    name,
    provider,
    status: 'idle',
    created_at: now,
    updated_at: now
  }
  getDb()
    .prepare(
      'INSERT INTO threads (id, project_id, name, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      thread.id,
      thread.project_id,
      thread.name,
      thread.provider,
      thread.status,
      thread.created_at,
      thread.updated_at
    )
  return thread as Thread
}

export function deleteThread(id: string): void {
  getDb().prepare('DELETE FROM threads WHERE id = ?').run(id)
}

export function updateThreadStatus(id: string, status: string): void {
  getDb()
    .prepare('UPDATE threads SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), id)
}

export function updateThreadName(id: string, name: string): void {
  getDb()
    .prepare('UPDATE threads SET name = ?, updated_at = ? WHERE id = ?')
    .run(name, new Date().toISOString(), id)
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
