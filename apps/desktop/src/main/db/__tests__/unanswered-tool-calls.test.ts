import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runMigrations } from '../migrations'

let database: Database.Database

vi.mock('../index', () => ({ getDb: () => database }))

const { createThread, getOrCreateActiveSession, insertMessage, findUnansweredToolCalls, insertCancelledToolResults } = await import('../queries')

let threadId: string
let sessionId: string

beforeEach(() => {
  database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  runMigrations(database)
  const now = new Date().toISOString()
  database.prepare('INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('p1', 'Project', 'C:/repo', now, now)
  database
    .prepare('INSERT INTO repo_locations (id, project_id, label, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('loc-1', 'p1', 'Local', 'C:/repo', now, now)
  threadId = createThread('p1', 'Thread', 'loc-1').id
  sessionId = getOrCreateActiveSession(threadId).id
})

afterEach(() => {
  database.close()
})

it('finds tool calls with no result in the session, and only those', () => {
  insertMessage(threadId, 'user', 'go', undefined, sessionId)
  insertMessage(threadId, 'assistant', 'Bash', { type: 'tool_call', id: 'answered' }, sessionId)
  insertMessage(threadId, 'assistant', 'ok', { type: 'tool_result', tool_use_id: 'answered' }, sessionId)
  insertMessage(threadId, 'assistant', 'Bash', { type: 'tool_call', id: 'pending' }, sessionId)
  insertMessage(threadId, 'assistant', 'Task', { type: 'tool_use', id: 'pending-use' }, sessionId)
  insertMessage(threadId, 'assistant', 'mentions "tool_call" in text only', { type: 'text' }, sessionId)
  const other = getOrCreateActiveSession(createThread('p1', 'Other', 'loc-1').id).id
  insertMessage(threadId, 'assistant', 'Bash', { type: 'tool_call', id: 'other-session' }, other)

  expect(findUnansweredToolCalls(sessionId)).toEqual(['pending', 'pending-use'])
})

it('records cancelled results that answer those calls', () => {
  insertMessage(threadId, 'assistant', 'Bash', { type: 'tool_call', id: 'pending' }, sessionId)
  const inserted = insertCancelledToolResults(threadId, sessionId, ['pending'])
  expect(JSON.parse(inserted[0].metadata!)).toEqual({ type: 'tool_result', tool_use_id: 'pending', cancelled: true })
  expect(findUnansweredToolCalls(sessionId)).toEqual([])
})
