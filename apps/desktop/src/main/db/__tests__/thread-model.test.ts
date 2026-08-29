import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '../migrations'

let database: Database.Database

// `queries.ts` reaches the database only through `getDb()`, and pulls in no
// Electron surface of its own, so swapping that one function is enough to run
// the real SQL against an in-memory schema.
vi.mock('../index', () => ({ getDb: () => database }))

const {
  createThread,
  getThreadById,
  listThreads,
  listQueueThreads,
  updateThreadProviderAndModel,
  updateThreadModel,
} = await import('../queries')

let locationId: string

beforeEach(() => {
  database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  runMigrations(database)

  const now = new Date().toISOString()
  database.prepare('INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('p1', 'Project', 'C:/repo', now, now)
  locationId = 'loc-1'
  database
    .prepare('INSERT INTO repo_locations (id, project_id, label, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(locationId, 'p1', 'Local', 'C:/repo', now, now)
})

afterEach(() => {
  database.close()
})

function createOpenCodeThread(model: string): string {
  const thread = createThread('p1', 'OpenCode thread', locationId, 'opencode', model)
  database
    .prepare('INSERT INTO messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(`msg-${thread.id}`, thread.id, 'user', 'hello', new Date().toISOString())
  return thread.id
}

describe('thread model round-trip', () => {
  it('preserves an OpenCode model discovered at runtime (not in the static list)', () => {
    // 'opencode/glm-5' comes from `opencode models --verbose` but is absent
    // from the hardcoded OPENCODE_MODELS fallback list.
    const id = createOpenCodeThread('opencode/glm-5')

    expect(getThreadById(id)?.model).toBe('opencode/glm-5')
    expect(listThreads('p1').find((t) => t.id === id)?.model).toBe('opencode/glm-5')
    expect(listQueueThreads().find((t) => t.id === id)?.model).toBe('opencode/glm-5')
  })

  it('preserves the model after an explicit model change', () => {
    const id = createOpenCodeThread('opencode/big-pickle')
    updateThreadModel(id, 'github-copilot/claude-sonnet-4.5')

    expect(getThreadById(id)?.model).toBe('github-copilot/claude-sonnet-4.5')
    expect(listThreads('p1').find((t) => t.id === id)?.model).toBe('github-copilot/claude-sonnet-4.5')
  })

  it('preserves provider+model set together on an existing thread', () => {
    const id = createOpenCodeThread('opencode/big-pickle')
    updateThreadProviderAndModel(id, 'opencode', 'opencode/kimi-k2.5')

    expect(getThreadById(id)?.model).toBe('opencode/kimi-k2.5')
  })
})
