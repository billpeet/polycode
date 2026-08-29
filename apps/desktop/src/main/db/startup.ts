import { initDb } from './index'
import { DatabaseSchemaTooNewError } from './migrations'

export interface DatabaseStartupDependencies {
  initDatabase: () => void
}

export interface DatabaseRequiresNewerApp {
  status: 'requires-newer-app'
  databaseSchemaVersion: number
  supportedSchemaVersion: number
}

export function startDatabase(
  dependencies: DatabaseStartupDependencies = { initDatabase: initDb }
): { status: 'ready' } | DatabaseRequiresNewerApp {
  try {
    dependencies.initDatabase()
    return { status: 'ready' }
  } catch (error) {
    if (!(error instanceof DatabaseSchemaTooNewError)) throw error
    return {
      status: 'requires-newer-app',
      databaseSchemaVersion: error.databaseSchemaVersion,
      supportedSchemaVersion: error.supportedSchemaVersion,
    }
  }
}
