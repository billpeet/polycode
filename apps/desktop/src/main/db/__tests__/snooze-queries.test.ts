import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '../migrations'

let database: Database.Database

// `queries.ts` reaches the database only through `getDb()`, and pulls in no
// Electron surface of its own, so swapping that one function is enough to run
// the real SQL against an in-memory schema.
vi.mock('../index', () => ({ getDb: () => database }))

const {
  archiveThread,
  createThread,
  listActiveThreadsForLocation,
  listQueueThreads,
  listSnoozedQueueThreads,
  listSnoozedThreads,
  listThreads,
  snoozeThread,
  snoozedThreadCount,
  unsnoozeThread,
} = await import('../queries')

const PAST = '2020-01-01T00:00:00.000Z'
const FUTURE = '2999-01-01T00:00:00.000Z'

let locationId: string

beforeEach(() => {
  database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  runMigrations(database)

  const now = new Date().toISOString()
  database.prepare('INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('p1', 'Project', 'C:/repo', now, now)
  locationId = 'loc-1'
  database
    .prepare('INSERT INTO repo_locations (id, project_id, label, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(locationId, 'p1', 'Local', 'C:/repo', now, now)
})

afterEach(() => {
  database.close()
})

function makeThread(name: string): string {
  const thread = createThread('p1', name, locationId)
  // Give it a message so it is not treated as a never-used thread anywhere.
  database
    .prepare('INSERT INTO messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(`msg-${thread.id}`, thread.id, 'user', 'hello', new Date().toISOString())
  return thread.id
}

describe('snooze query predicates', () => {
  it('hides an actively snoozed thread from the project list and the Queue', () => {
    const id = makeThread('Deferred')

    snoozeThread(id, FUTURE)

    expect(listThreads('p1').map((t) => t.id)).toEqual([])
    expect(listQueueThreads().map((t) => t.id)).toEqual([])
    expect(listSnoozedThreads('p1').map((t) => t.id)).toEqual([id])
    expect(listSnoozedQueueThreads(null, 30, 0).map((t) => t.id)).toEqual([id])
    expect(snoozedThreadCount('p1')).toBe(1)
  })

  it('returns a woken thread to the project list and the Queue', () => {
    // A wake time in the past is the whole of "woken" — nothing writes on wake,
    // so this is exactly the state after the app has been closed past the time.
    const id = makeThread('Woke up')

    snoozeThread(id, PAST)

    expect(listThreads('p1').map((t) => t.id)).toEqual([id])
    expect(listQueueThreads().map((t) => t.id)).toEqual([id])
    // Woken is not snoozed: it must not linger in the Snoozed section.
    expect(listSnoozedThreads('p1')).toEqual([])
    expect(snoozedThreadCount('p1')).toBe(0)
  })

  it('keeps a snoozed thread visible to worktree cleanup', () => {
    // The invariant ADR-0002 exists to protect. If the snooze predicate ever
    // leaks into this query, a location whose only thread is snoozed looks
    // empty and its worktree gets destroyed with live work inside it.
    const id = makeThread('Snoozed but live')

    snoozeThread(id, FUTURE)

    expect(listActiveThreadsForLocation(locationId).map((t) => t.id)).toEqual([id])
  })

  it('discards the snooze when a thread is archived', () => {
    const id = makeThread('Archived while snoozed')
    snoozeThread(id, FUTURE)

    archiveThread(id)

    expect(snoozedThreadCount('p1')).toBe(0)
    expect(listSnoozedThreads('p1')).toEqual([])
    expect(
      database.prepare('SELECT snoozed_until FROM threads WHERE id = ?').pluck().get(id)
    ).toBeNull()
  })

  it('orders snoozed threads by wake time, soonest to return first', () => {
    const later = makeThread('Later')
    const sooner = makeThread('Sooner')
    snoozeThread(later, '2999-06-01T00:00:00.000Z')
    snoozeThread(sooner, '2999-01-01T00:00:00.000Z')

    expect(listSnoozedThreads('p1').map((t) => t.id)).toEqual([sooner, later])
    expect(listSnoozedQueueThreads(null, 30, 0).map((t) => t.id)).toEqual([sooner, later])
  })

  it('searches snoozed threads by name', () => {
    const match = makeThread('Refactor the parser')
    snoozeThread(match, FUTURE)
    const other = makeThread('Unrelated')
    snoozeThread(other, FUTURE)

    expect(listSnoozedQueueThreads('parser', 30, 0).map((t) => t.id)).toEqual([match])
  })

  it('clears a snooze outright on unsnooze', () => {
    const id = makeThread('Woken by hand')
    snoozeThread(id, FUTURE)

    unsnoozeThread(id)

    expect(listThreads('p1').map((t) => t.id)).toEqual([id])
    expect(snoozedThreadCount('p1')).toBe(0)
  })

  it('does not bump updated_at when snoozing', () => {
    // Snoozing is not activity on the thread; bumping it would reorder every
    // list that sorts on it.
    const id = makeThread('Untouched')
    const before = database.prepare('SELECT updated_at FROM threads WHERE id = ?').pluck().get(id)

    snoozeThread(id, FUTURE)

    expect(database.prepare('SELECT updated_at FROM threads WHERE id = ?').pluck().get(id)).toBe(before)
  })
})
