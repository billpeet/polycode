import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import type { SeedBrowseRequest, SeedCatalog, SeedImportRequest, SeedImportResult, SeedProject, SeedThread } from '@polycode/shared'
import { LATEST_SCHEMA_VERSION } from './migrations'

type Row = Record<string, string | number | bigint | Buffer | null>
type Table = 'projects' | 'repo_locations' | 'project_commands' | 'slash_commands' | 'threads' | 'sessions' | 'messages'

function openSource(sourcePath: string, destination: Database.Database): Database.Database {
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) throw new Error('Choose a production database.')
  const sourceFile = realpathSync(sourcePath)
  if (destination.name !== ':memory:') {
    const destFile = realpathSync(destination.name)
    const sourceStat = statSync(sourceFile)
    const destStat = statSync(destFile)
    if (sourceFile === destFile || (sourceStat.dev === destStat.dev && sourceStat.ino === destStat.ino)) {
      throw new Error('The source must be different from the current database.')
    }
  }
  const source = new Database(sourceFile, { readonly: true, fileMustExist: true })
  try {
    source.pragma('query_only = ON')
    const version = source.pragma('user_version', { simple: true }) as number
    if (version < 1 || version > LATEST_SCHEMA_VERSION) {
      throw new Error(`Cannot seed schema version ${version}. Supported versions: 1–${LATEST_SCHEMA_VERSION}. Update the older app first.`)
    }
    return source
  } catch (error) {
    source.close()
    throw error
  }
}

/** A read transaction includes committed WAL data without copying or migrating production. */
function readSource<T>(sourcePath: string, destination: Database.Database, read: (source: Database.Database) => T): T {
  const source = openSource(sourcePath, destination)
  try { return source.transaction(() => read(source))() } finally { source.close() }
}

export function browseSeedDatabase(destination: Database.Database, request: SeedBrowseRequest): SeedCatalog {
  if (!request || typeof request !== 'object') throw new Error('Invalid browse request')
  const offset = request.offset ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid page offset')
  if (request.search !== undefined && (typeof request.search !== 'string' || request.search.length > 200)) throw new Error('Invalid search')
  if (request.projectId !== undefined && typeof request.projectId !== 'string') throw new Error('Invalid project')
  return readSource(request.sourcePath, destination, (source) => {
    const projects = source.prepare('SELECT id, name FROM projects ORDER BY name COLLATE NOCASE, id').all() as SeedProject[]
    const search = `%${(request.search ?? '').replace(/[\\%_]/g, '\\$&')}%`
    const threads = source.prepare(`
      SELECT t.id, t.project_id AS projectId, p.name AS projectName, t.name, t.status, t.updated_at AS updatedAt
      FROM threads t JOIN projects p ON p.id = t.project_id
      WHERE (? IS NULL OR t.project_id = ?) AND (t.name LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\')
      ORDER BY t.updated_at DESC, t.id DESC LIMIT 51 OFFSET ?
    `).all(request.projectId ?? null, request.projectId ?? null, search, search, offset) as SeedThread[]
    return { projects, threads: threads.slice(0, 50), hasMore: threads.length > 50 }
  })
}

function selectedIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some((id) => typeof id !== 'string' || !id || id.length > 128)) {
    throw new Error('Select up to 100 projects or threads at a time.')
  }
  return [...new Set(value)] as string[]
}

export function importSeedDatabase(destination: Database.Database, request: SeedImportRequest): SeedImportResult {
  if (!request || typeof request !== 'object') throw new Error('Invalid import request')
  const projectIds = new Set(selectedIds(request.projectIds))
  const threadIds = selectedIds(request.threadIds)
  if (!projectIds.size && !threadIds.length) throw new Error('Select a project or thread to import.')
  return readSource(request.sourcePath, destination, (source) => destination.transaction(() => {
    const result: SeedImportResult = { projectsCreated: 0, threadsCreated: 0, messagesCreated: 0, projectIds: [] }
    const columns = new Map<Table, Set<string>>()
    const inserts = new Map<string, Database.Statement>()
    const insert = (table: Table, row: Row): void => {
      let allowed = columns.get(table)
      if (!allowed) {
        allowed = new Set((destination.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name))
        columns.set(table, allowed)
      }
      const keys = Object.keys(row).filter((key) => allowed.has(key))
      const names = keys.map((key) => `"${key.replaceAll('"', '""')}"`).join(', ')
      const sql = `INSERT INTO ${table} (${names}) VALUES (${keys.map(() => '?').join(', ')})`
      let statement = inserts.get(sql)
      if (!statement) {
        statement = destination.prepare(sql)
        inserts.set(sql, statement)
      }
      statement.run(...keys.map((key) => row[key]))
    }
    const requiredRow = (table: Table, id: string): Row => {
      const row = source.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Row | undefined
      if (!row) throw new Error(`Selected ${table} record no longer exists. Refresh and try again.`)
      return row
    }
    const threads = threadIds.map((id) => requiredRow('threads', id))
    for (const thread of threads) projectIds.add(thread.project_id as string)
    for (const projectId of projectIds) {
      const project = requiredRow('projects', projectId)
      if (!destination.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) {
        insert('projects', { ...project, archived_at: null })
        result.projectsCreated++
      }
      // Keep stable project/location IDs so later imports reuse the same configuration.
      // Existing development configuration is never overwritten.
      for (const location of source.prepare('SELECT * FROM repo_locations WHERE project_id = ?').all(projectId) as Row[]) {
        const existing = destination.prepare('SELECT project_id FROM repo_locations WHERE id = ?').get(location.id) as Row | undefined
        if (existing && existing.project_id !== projectId) throw new Error('Location ID conflicts with another development project.')
        if (!existing) insert('repo_locations', {
          ...location, pool_id: null, checked_out: 0, parent_location_id: null, is_worktree: 0, worktree_id: null,
        })
      }
      for (const table of ['project_commands', 'slash_commands'] as const) {
        for (const row of source.prepare(`SELECT * FROM ${table} WHERE project_id = ?`).all(projectId) as Row[]) {
          if (!destination.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(row.id)) {
            insert(table, table === 'project_commands' ? { ...row, run_on_worktree_create: 0 } : row)
          }
        }
      }
      result.projectIds.push(projectId)
    }
    for (const thread of threads) {
      const id = randomUUID()
      // Copied history is for inspection. A new turn starts a new provider session,
      // never resumes the production conversation. Runs become ordinary threads.
      const interrupted = ['running', 'stopping', 'plan_pending', 'question_pending', 'permission_pending'].includes(thread.status as string)
      insert('threads', {
        ...thread, id, name: `${thread.name} (seed)`, claude_session_id: null,
        total_tokens: thread.total_tokens ?? Number(thread.input_tokens ?? 0) + Number(thread.output_tokens ?? 0),
        status: interrupted ? 'stopped' : thread.status,
        routine_id: null, run_state: null, run_detail: null, archived: 0, snoozed_until: null, unread: 0,
      })
      const sessionIds = new Map<string, string>()
      for (const session of source.prepare('SELECT * FROM sessions WHERE thread_id = ?').all(thread.id) as Row[]) {
        const sessionId = randomUUID()
        sessionIds.set(session.id as string, sessionId)
        insert('sessions', { ...session, id: sessionId, thread_id: id, claude_session_id: null })
      }
      // Stream only selected histories, rather than loading a large production DB.
      for (const message of source.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, rowid').iterate(thread.id) as Iterable<Row>) {
        insert('messages', {
          ...message, id: randomUUID(), thread_id: id,
          session_id: message.session_id ? sessionIds.get(message.session_id as string) ?? null : null,
        })
        result.messagesCreated++
      }
      result.threadsCreated++
    }
    return result
  })())
}
