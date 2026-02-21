import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'path'

let db: Database.Database

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.')
  }
  return db
}

export function initDb(): void {
  const userDataPath = app.getPath('userData')
  const dbPath = path.join(userDataPath, 'polycode.db')

  db = new Database(dbPath)

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  runMigrations(db)
}

function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude-code',
      status TEXT NOT NULL DEFAULT 'idle',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL
    );
  `)

  // Additive migrations — safe to run on existing databases
  const cols = database.pragma('table_info(threads)') as Array<{ name: string }>
  const hasSessionId = cols.some((c) => c.name === 'claude_session_id')
  if (!hasSessionId) {
    database.exec(`ALTER TABLE threads ADD COLUMN claude_session_id TEXT`)
  }
  const hasArchived = cols.some((c) => c.name === 'archived')
  if (!hasArchived) {
    database.exec(`ALTER TABLE threads ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`)
  }
  const hasModel = cols.some((c) => c.name === 'model')
  if (!hasModel) {
    database.exec(`ALTER TABLE threads ADD COLUMN model TEXT NOT NULL DEFAULT 'claude-opus-4-5'`)
  }
}

export function closeDb(): void {
  if (db) {
    db.close()
  }
}
