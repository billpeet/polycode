import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'path'
import { instrumentDatabase } from './telemetry'
import { runMigrations } from './migrations'
import { getAppLifecycleState, getAppOperationName, sanitizeOperationName } from '../app-lifecycle'

let db: Database.Database | undefined

export function getDatabasePath(): string {
  return path.join(app.getPath('userData'), 'polycode.db')
}

export function getDb(query = 'unknown'): Database.Database {
  if (!db) {
    const state = getAppLifecycleState()
    if (state !== 'running') {
      // Keep this an observable invariant failure, distinct from rejected new IPC.
      throw new Error(`Database unavailable during ${state}: operation=${getAppOperationName()}, query=${sanitizeOperationName(query)}`)
    }
    throw new Error('Database not initialized. Call initDb() first.')
  }
  return db
}

export function initDb(): void {
  const database = new Database(getDatabasePath())

  try {
    // Enable WAL mode for better concurrent read performance
    database.pragma('journal_mode = WAL')
    database.pragma('foreign_keys = ON')

    runMigrations(database)
    instrumentDatabase(database)
    db = database
  } catch (error) {
    database.close()
    throw error
  }
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = undefined
  }
}
