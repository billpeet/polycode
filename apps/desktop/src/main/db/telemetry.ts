import type Database from 'better-sqlite3'
import { withSyncSpan } from '../observability'

/** Trace execution, not SQL values: bound parameters can contain user content. */
export function instrumentDatabase(database: Database.Database): void {
  const prepare = database.prepare
  database.prepare = function (sql: string) {
    const statement = prepare.call(database, sql)
    const operation = sql.trim().split(/\s+/, 1)[0].toUpperCase()
    for (const method of ['run', 'get', 'all'] as const) {
      const execute = statement[method]
      Object.defineProperty(statement, method, {
        value: (...args: unknown[]) => withSyncSpan(`db.${operation}`, {
          'db.system.name': 'sqlite',
          'db.operation.name': operation,
          'db.statement.method': method,
        }, () => Reflect.apply(execute, statement, args)),
      })
    }
    return statement
  } as Database.Database['prepare']
  const exec = database.exec
  database.exec = function (sql: string) {
    return withSyncSpan('db.exec', { 'db.system.name': 'sqlite' }, () => exec.call(database, sql))
  }
}
