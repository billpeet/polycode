import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { runMigrations } from '../migrations'
let database: Database.Database
vi.mock('../index', () => ({ getDb: () => database }))
const { resetRunningThreads } = await import('../queries')
afterEach(() => database.close())

it('marks interrupted running and stopping turns stopped, leaving other statuses alone', () => {
  database = new Database(':memory:')
  runMigrations(database)
  database.exec("INSERT INTO projects(id,name,path,created_at,updated_at) VALUES ('p','Project','/repo','old','old')")
  for (const status of ['running', 'stopping', 'idle', 'error', 'question_pending']) {
    database.prepare('INSERT INTO threads(id,project_id,name,status,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(status, 'p', status, status, 'old', 'old')
  }
  resetRunningThreads()
  const rows = database.prepare('SELECT id, status, last_turn_completed_at FROM threads').all() as { id: string; status: string; last_turn_completed_at: string | null }[]
  for (const row of rows) {
    const interrupted = ['running', 'stopping'].includes(row.id)
    expect(row.status).toBe(interrupted ? 'stopped' : row.id)
    expect(row.last_turn_completed_at !== null).toBe(interrupted)
  }
})
