import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations, LATEST_SCHEMA_VERSION } from '../migrations'
import { browseSeedDatabase, importSeedDatabase } from '../seed'

let directory: string
let source: Database.Database
let destination: Database.Database
let sourcePath: string
const now = '2026-09-21T00:00:00.000Z'

function insert(database: Database.Database, table: string, row: Record<string, string | number | null>): void {
  const keys = Object.keys(row)
  database.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row))
}
function rows(database: Database.Database, table: string): Record<string, unknown>[] {
  return database.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]
}
function importSelected(projectIds: string[] = [], threadIds: string[] = []) {
  return importSeedDatabase(destination, { sourcePath, projectIds, threadIds })
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'polycode-seed-test-'))
  sourcePath = join(directory, 'production.db')
  source = new Database(sourcePath)
  source.pragma('journal_mode = WAL')
  source.pragma('foreign_keys = ON')
  destination = new Database(join(directory, 'development.db'))
  destination.pragma('foreign_keys = ON')
  runMigrations(source)
  runMigrations(destination)
  for (const id of ['p1', 'p2']) insert(source, 'projects', { id, name: id, path: `/repo/${id}`, created_at: now, updated_at: now })
  insert(source, 'repo_locations', { id: 'l1', project_id: 'p1', path: '/repo/p1', label: 'Worktree', is_worktree: 1, created_at: now, updated_at: now })
  insert(source, 'routines', { id: 'r1', project_id: 'p1', location_id: 'l1', name: 'Daily', prompt: 'Work', enabled: 1, created_at: now, updated_at: now })
  insert(source, 'project_commands', { id: 'c1', project_id: 'p1', name: 'Install', command: 'npm install', run_on_worktree_create: 1, created_at: now, updated_at: now })
  insert(source, 'slash_commands', { id: 'sc1', project_id: 'p1', name: 'Review', prompt: 'Review', created_at: now, updated_at: now })
  insert(source, 'settings', { key: 'secret', value: 'not-for-development' })
  for (const id of ['t1', 't2']) {
    insert(source, 'threads', { id, project_id: 'p1', location_id: 'l1', name: id, status: 'running', claude_session_id: 'production-provider-id', routine_id: 'r1', run_state: 'active', created_at: now, updated_at: now })
    insert(source, 'sessions', { id: `s-${id}`, thread_id: id, name: 'Planning', claude_session_id: 'production-session-id', created_at: now, updated_at: now })
    insert(source, 'messages', { id: `m-${id}`, thread_id: id, session_id: `s-${id}`, role: 'assistant', content: `History for ${id}`, metadata: '{"type":"text"}', created_at: now })
  }
})

afterEach(() => {
  source.close()
  destination.close()
  // Only this test's mkdtemp directory is removed.
  rmSync(directory, { recursive: true, force: true })
})

describe('selective production seeding', () => {
  it('imports project configuration without history, routines, secrets, or worktree ownership', () => {
    expect(importSelected(['p1'])).toMatchObject({ projectsCreated: 1, threadsCreated: 0, messagesCreated: 0 })
    expect(rows(destination, 'projects').map((row) => row.id)).toEqual(['p1'])
    for (const table of ['threads', 'sessions', 'messages', 'routines', 'settings']) expect(rows(destination, table)).toEqual([])
    expect(rows(destination, 'repo_locations')[0]).toMatchObject({ id: 'l1', path: '/repo/p1', is_worktree: 0, parent_location_id: null, pool_id: null })
    expect(rows(destination, 'project_commands')[0].run_on_worktree_create).toBe(0)
    expect(rows(destination, 'slash_commands')).toHaveLength(1)
  })

  it('copies only selected thread history from a live WAL source without changing production', () => {
    const before = ['projects', 'threads', 'sessions', 'messages', 'routines'].map((table) => rows(source, table))
    expect(importSelected([], ['t1'])).toMatchObject({ projectsCreated: 1, threadsCreated: 1, messagesCreated: 1 })
    const thread = rows(destination, 'threads')[0]
    expect(thread).toMatchObject({ name: 't1 (seed)', status: 'stopped', claude_session_id: null, routine_id: null, run_state: null })
    expect(thread.id).not.toBe('t1')
    const session = rows(destination, 'sessions')[0]
    expect(session).toMatchObject({ thread_id: thread.id, claude_session_id: null })
    expect(session.id).not.toBe('s-t1')
    expect(rows(destination, 'messages')[0]).toMatchObject({ thread_id: thread.id, session_id: session.id, content: 'History for t1' })
    expect(destination.pragma('foreign_key_check')).toEqual([])
    expect(['projects', 'threads', 'sessions', 'messages', 'routines'].map((table) => rows(source, table))).toEqual(before)
    // The source remains writable by its owner while/after the reader closes.
    source.prepare("UPDATE threads SET status = 'idle' WHERE id = 't1'").run()
  })

  it('reuses projects without overwriting local edits and creates fresh copies on each import', () => {
    importSelected([], ['t1'])
    destination.prepare("UPDATE projects SET name = 'Dev name' WHERE id = 'p1'").run()
    destination.prepare("UPDATE threads SET status = 'running'").run()
    expect(importSelected([], ['t1'])).toMatchObject({ projectsCreated: 0, threadsCreated: 1 })
    expect(rows(destination, 'projects')[0].name).toBe('Dev name')
    expect(rows(destination, 'threads').map((row) => row.status)).toEqual(['running', 'stopped'])
    expect(rows(destination, 'repo_locations')).toHaveLength(1)
  })

  it('rolls back the entire import if a selected project disappeared', () => {
    expect(() => importSelected(['p1', 'missing'])).toThrow('no longer exists')
    expect(rows(destination, 'projects')).toEqual([])
    expect(rows(destination, 'repo_locations')).toEqual([])
  })

  it('rejects self-import and unsupported schemas without migrating the source', () => {
    expect(() => importSeedDatabase(source, { sourcePath, projectIds: ['p1'], threadIds: [] })).toThrow('different')
    source.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`)
    expect(() => importSelected(['p1'])).toThrow('schema version')
    expect(source.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION + 1)
    expect(rows(destination, 'projects')).toEqual([])
  })

  it('reads an older supported schema using destination column defaults', () => {
    source.exec('ALTER TABLE threads DROP COLUMN total_tokens')
    source.exec('ALTER TABLE threads DROP COLUMN total_cost_usd')
    source.pragma('user_version = 5')
    importSelected([], ['t1'])
    expect(rows(destination, 'threads')[0].total_tokens).toBe(0)
    expect(source.pragma('user_version', { simple: true })).toBe(5)
  })

  it('paginates newest-first, filters by project, and treats search wildcards literally', () => {
    for (let i = 0; i < 51; i++) insert(source, 'threads', { id: `extra-${i}`, project_id: 'p2', name: `Recent ${i}`, created_at: now, updated_at: '2026-09-22T00:00:00.000Z' })
    const first = browseSeedDatabase(destination, { sourcePath })
    expect(first.threads).toHaveLength(50)
    expect(first.hasMore).toBe(true)
    expect(first.threads[0].projectId).toBe('p2')
    const next = browseSeedDatabase(destination, { sourcePath, offset: 50 })
    expect(next.threads).toHaveLength(3)
    expect(next.hasMore).toBe(false)
    expect(next.threads.some((thread) => first.threads.some((earlier) => earlier.id === thread.id))).toBe(false)
    expect(browseSeedDatabase(destination, { sourcePath, projectId: 'p1' }).threads).toHaveLength(2)
    expect(browseSeedDatabase(destination, { sourcePath, search: '%' }).threads).toEqual([])
  })
})
