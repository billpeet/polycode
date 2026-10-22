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
    expect(database.prepare("SELECT name FROM pragma_table_info('projects') WHERE name = 'favicon_path'").pluck().get()).toBe('favicon_path')
    const indexes = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name")
      .pluck()
      .all()
    expect(indexes).toEqual([
      'idx_messages_session_created',
      'idx_messages_thread_created',
      'idx_messages_thread_system_created',
      'idx_messages_thread_text_created',
      'idx_messages_thread_user_created',
      'idx_repo_locations_project_created',
      'idx_routines_project',
      'idx_sessions_thread_active',
      'idx_threads_archived_snoozed',
      'idx_threads_archived_turn_completed',
      'idx_threads_project_archived_updated',
      'idx_threads_routine_created',
    ])
  })

  it('collapses duplicate repo locations onto the earliest row', () => {
    const database = createDatabase()
    runMigrations(database)
    database.pragma('user_version = 9')
    const now = '2026-10-15T00:00:00.000Z'
    database.prepare("INSERT INTO projects (id, name, path, created_at, updated_at) VALUES ('p', 'ProgSys', '', ?, ?)").run(now, now)
    const insertLocation = database.prepare(
      "INSERT INTO repo_locations (id, project_id, parent_location_id, is_worktree, label, connection_type, path, created_at, updated_at) VALUES (?, 'p', ?, ?, ?, 'local', ?, ?, ?)"
    )
    insertLocation.run('root', null, 0, 'ProgSys', 'C:\\src\\ProgSys', '2026-01-01', now)
    insertLocation.run('wt', 'root', 1, 'wt', 'C:/src/wt', '2026-01-02', now)
    insertLocation.run('wt-copy', 'root', 1, 'wt', 'c:/src/wt/', '2026-01-03', now)
    insertLocation.run('root-copy', 'wt-copy', 1, 'ProgSys', 'C:/src/ProgSys', '2026-01-04', now)
    insertLocation.run('child-of-copy', 'wt-copy', 1, 'other', 'C:/src/other', '2026-01-05', now)
    database.prepare("INSERT INTO threads (id, project_id, name, location_id, created_at, updated_at) VALUES ('t', 'p', 'T', 'wt-copy', ?, ?)").run(now, now)
    database.prepare("INSERT INTO routines (id, project_id, location_id, name, prompt, created_at, updated_at) VALUES ('r', 'p', 'root-copy', 'R', 'go', ?, ?)").run(now, now)

    runMigrations(database)

    expect(database.prepare('SELECT id FROM repo_locations ORDER BY created_at').pluck().all()).toEqual(['root', 'wt', 'child-of-copy'])
    expect(database.prepare("SELECT location_id FROM threads WHERE id = 't'").pluck().get()).toBe('wt')
    expect(database.prepare("SELECT location_id FROM routines WHERE id = 'r'").pluck().get()).toBe('root')
    expect(database.prepare("SELECT parent_location_id FROM repo_locations WHERE id = 'child-of-copy'").pluck().get()).toBe('wt')
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
    // v3 seeds turn ordering from the pre-existing updated_at.
    expect(database.prepare('SELECT last_turn_completed_at FROM threads WHERE id = ?').pluck().get('thread')).toBe('now')
    expect(database.prepare('SELECT last_turn_started_at FROM threads WHERE id = ?').pluck().get('thread')).toBeNull()
    // v4 deliberately does not backfill: NULL already means "never snoozed".
    expect(database.prepare('SELECT snoozed_until FROM threads WHERE id = ?').pluck().get('thread')).toBeNull()
    expect(database.prepare('SELECT favicon_path FROM projects WHERE id = ?').pluck().get('project')).toBeNull()
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

  it('adds thread cost and total-token columns to a version 5 database', () => {
    const database = createDatabase()
    runMigrations(database)
    database.exec('ALTER TABLE threads DROP COLUMN total_cost_usd')
    database.exec('ALTER TABLE threads DROP COLUMN total_tokens')
    database.pragma('user_version = 5')

    runMigrations(database)

    const columns = database.prepare("SELECT name FROM pragma_table_info('threads')").pluck().all()
    expect(columns).toContain('total_tokens')
    expect(columns).toContain('total_cost_usd')
  })

  it('adds the built-in Scratch Project to a new database and to one that predates it', () => {
    const scratch = (database: Database.Database) =>
      database.prepare("SELECT name, archived_at FROM projects WHERE id = 'scratch'").get()

    const fresh = createDatabase()
    runMigrations(fresh)
    expect(scratch(fresh)).toEqual({ name: 'Scratch', archived_at: null })

    const existing = createDatabase()
    runMigrations(existing)
    existing.prepare("DELETE FROM projects WHERE id = 'scratch'").run()
    existing.pragma('user_version = 6')
    runMigrations(existing)
    expect(scratch(existing)).toEqual({ name: 'Scratch', archived_at: null })
  })

  it('rejects databases created by a newer application version', () => {
    const database = createDatabase()
    database.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`)

    expect(() => runMigrations(database)).toThrow('newer than supported')
  })
})
