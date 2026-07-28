import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { LATEST_SCHEMA_VERSION, runMigrations } from '../migrations'

const databases: Database.Database[] = []

function createDatabase(): Database.Database {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  databases.push(database)
  return database
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe('database migrations', () => {
  it('creates the current schema and records its version', () => {
    const database = createDatabase()

    runMigrations(database)

    expect(database.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION)
    const indexes = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name")
      .pluck()
      .all()
    expect(indexes).toEqual([
      'idx_messages_session_created',
      'idx_messages_thread_created',
      'idx_repo_locations_project_created',
      'idx_sessions_thread_active',
      'idx_threads_project_archived_updated',
    ])
  })

  it('adopts an unversioned legacy database and preserves its data', () => {
    const database = createDatabase()
    database.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'claude-code',
        status TEXT NOT NULL DEFAULT 'idle', created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO projects VALUES ('project', 'Project', 'C:/repo', 'now', 'now');
      INSERT INTO threads VALUES ('thread', 'project', 'Thread', 'claude-code', 'idle', 'now', 'now');
      INSERT INTO messages VALUES ('message', 'thread', 'user', 'hello', NULL, 'now');
    `)

    runMigrations(database)

    expect(database.prepare('SELECT content FROM messages WHERE id = ?').pluck().get('message')).toBe('hello')
    const locationId = database.prepare('SELECT location_id FROM threads WHERE id = ?').pluck().get('thread')
    expect(locationId).toEqual(expect.any(String))
    expect(database.prepare('SELECT path FROM repo_locations WHERE id = ?').pluck().get(locationId)).toBe('C:/repo')
    expect(database.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION)
  })

  it('does no schema work after the database reaches the latest version', () => {
    const database = createDatabase()
    runMigrations(database)
    database.exec('DROP INDEX idx_messages_thread_created')

    runMigrations(database)

    expect(
      database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_thread_created'").get()
    ).toBeUndefined()
  })

  it('rejects databases created by a newer application version', () => {
    const database = createDatabase()
    database.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`)

    expect(() => runMigrations(database)).toThrow('newer than supported')
  })
})
