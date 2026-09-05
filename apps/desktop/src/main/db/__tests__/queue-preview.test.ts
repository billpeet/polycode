import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '../migrations'

let database: Database.Database

vi.mock('../index', () => ({ getDb: () => database }))

const { createThread, listQueueThreads } = await import('../queries')

let threadId: string
let tick = 0

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
  tick = 0
})

afterEach(() => {
  database.close()
})

function addMessage(role: string, content: string, metadata?: Record<string, unknown>): void {
  tick += 1
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString()
  database
    .prepare('INSERT INTO messages (id, thread_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`msg-${tick}`, threadId, role, content, metadata ? JSON.stringify(metadata) : null, at)
}

function preview(): { preview: string | null; preview_is_error: boolean } {
  const row = listQueueThreads().find((t) => t.id === threadId)!
  return { preview: row.preview, preview_is_error: row.preview_is_error }
}

describe('queue preview', () => {
  it('is null when the thread has no messages', () => {
    expect(preview()).toEqual({ preview: null, preview_is_error: false })
  })

  it('concatenates streamed assistant chunks after the last user message', () => {
    addMessage('user', 'first')
    addMessage('assistant', 'stale answer')
    addMessage('user', 'hello')
    addMessage('assistant', 'Hel')
    addMessage('assistant', 'lo ')
    addMessage('assistant', 'there', { agentId: 'sub-1' })
    expect(preview()).toEqual({ preview: 'Hello there', preview_is_error: false })
  })

  it('ignores tool, thinking and plan rows', () => {
    addMessage('user', 'hello')
    addMessage('assistant', 'hmm', { type: 'thinking' })
    addMessage('assistant', 'Reading', { type: 'tool_call', id: 't1' })
    addMessage('assistant', 'Done', { type: 'tool_result', id: 't1' })
    addMessage('assistant', 'Result')
    addMessage('assistant', 'plan', { type: 'plan_ready' })
    expect(preview()).toEqual({ preview: 'Result', preview_is_error: false })
  })

  it('prefers a newer error row and flags it', () => {
    addMessage('user', 'hello')
    addMessage('assistant', 'Working')
    addMessage('system', 'Provider crashed', { type: 'error' })
    expect(preview()).toEqual({ preview: 'Provider crashed', preview_is_error: true })
  })

  it('ignores an error row older than the latest assistant text', () => {
    addMessage('user', 'hello')
    addMessage('system', 'Provider crashed', { type: 'error' })
    addMessage('assistant', 'Recovered')
    expect(preview()).toEqual({ preview: 'Recovered', preview_is_error: false })
  })

  it('truncates long previews to 200 characters', () => {
    addMessage('user', 'hello')
    addMessage('assistant', 'x'.repeat(500))
    expect(preview().preview).toHaveLength(200)
  })
})
