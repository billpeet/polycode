import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'path'
import { runMigrations } from './migrations'

let db: Database.Database | undefined

export function getDatabasePath(): string {
  return path.join(app.getPath('userData'), 'polycode.db')
}

export function getDb(): Database.Database {
  if (!db) {
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
