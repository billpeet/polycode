import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { LATEST_SCHEMA_VERSION, runMigrations } from '../migrations'
import { startDatabase } from '../startup'

const databases: Database.Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe('database startup', () => {
  it('returns recovery details when the database schema is one version ahead', () => {
    const database = new Database(':memory:')
    databases.push(database)
    database.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`)

    const result = startDatabase({ initDatabase: () => runMigrations(database) })

    expect(result).toEqual({
      status: 'requires-newer-app',
      databaseSchemaVersion: LATEST_SCHEMA_VERSION + 1,
      supportedSchemaVersion: LATEST_SCHEMA_VERSION,
    })
  })
})
