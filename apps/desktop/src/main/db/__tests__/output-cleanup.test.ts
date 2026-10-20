import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { foldMessages, type Message } from '@polycode/shared'
import { runMigrations } from '../migrations'
import { OutputCleanup } from '../output-cleanup'

let database: Database.Database

vi.mock('../index', () => ({ getDb: () => database }))

const { createThread, pageMessages } = await import('../queries')

let threadId: string
let tick = 0

beforeEach(() => {
  database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  runMigrations(database)
  const now = new Date().toISOString()
  database.prepare('INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('p1', 'Project', 'C:/repo', now, now)
  database
    .prepare('INSERT INTO repo_locations (id, project_id, label, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('loc-1', 'p1', 'Local', 'C:/repo', now, now)
  threadId = createThread('p1', 'Thread', 'loc-1').id
  tick = 0
})

afterEach(() => {
  database.close()
})

function add(role: string, content: string, metadata?: Record<string, unknown>): string {
  tick += 1
  const id = `msg-${tick}`
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString()
  database
    .prepare('INSERT INTO messages (id, thread_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, threadId, role, content, metadata ? JSON.stringify(metadata) : null, at)
  return id
}

/** A delta row as Codex saved them: the raw notification spread into metadata. */
const delta = (toolUseId: string, text: string) =>
  add('assistant', text, { threadId: 'x', turnId: 'y', itemId: toolUseId, delta: text, type: 'tool_result', tool_use_id: toolUseId })
const call = (toolUseId: string) => add('assistant', 'ls', { type: 'tool_call', id: toolUseId, name: 'Bash', input: {} })
const final = (toolUseId: string, output: string) =>
  add('assistant', output, { id: toolUseId, type: 'tool_result', tool_use_id: toolUseId, status: 'completed', aggregated_output: output, exit_code: 0 })

function rows(): Message[] {
  return database.prepare('SELECT * FROM messages ORDER BY created_at, rowid').all() as Message[]
}

/** What the transcript shows for each tool: the last folded result for its id. */
function shownOutputs(): Record<string, string> {
  const shown: Record<string, string> = {}
  for (const message of foldMessages(rows())) {
    const meta = message.metadata ? JSON.parse(message.metadata) as Record<string, unknown> : null
    if (meta?.type === 'tool_result' && typeof meta.tool_use_id === 'string') shown[meta.tool_use_id] = message.content
  }
  return shown
}

function cleanAll(): number {
  return new OutputCleanup(database, OutputCleanup.begin(database)).runToEnd().deletedRows
}

describe('Codex output cleanup', () => {
  it('drops the deltas a final result repeats, and its aggregated_output copy', () => {
    add('user', 'go')
    call('cmd-1')
    delta('cmd-1', 'a\n')
    delta('cmd-1', 'b\n')
    const finalId = final('cmd-1', 'a\nb\n')
    add('assistant', 'Done.')
    const before = shownOutputs()

    expect(cleanAll()).toBe(2)

    expect(shownOutputs()).toEqual(before)
    const kept = rows().find((row) => row.id === finalId)!
    expect(JSON.parse(kept.metadata!)).toEqual({ id: 'cmd-1', type: 'tool_result', tool_use_id: 'cmd-1', status: 'completed', exit_code: 0 })
    expect(rows().map((row) => row.content)).toEqual(['go', 'ls', 'a\nb\n', 'Done.'])
  })

  it('keeps the streamed text when the final result reported less', () => {
    add('user', 'go')
    call('cmd-1')
    delta('cmd-1', 'lots of ')
    delta('cmd-1', 'output')
    const finalId = final('cmd-1', '')
    expect(shownOutputs()['cmd-1']).toBe('lots of output')

    cleanAll()

    expect(shownOutputs()['cmd-1']).toBe('lots of output')
    expect(rows().filter((row) => row.content === 'lots of output').map((row) => row.id)).toEqual([finalId])
  })

  it('collapses output whose final result never came into one row, stopping at the next user message', () => {
    add('user', 'go')
    call('cmd-1')
    delta('cmd-1', 'half')
    const lastDelta = delta('cmd-1', ' done')
    add('user', 'stop that')
    // A later command reusing the id must not be mistaken for its final result.
    final('cmd-1', 'unrelated')

    cleanAll()

    const kept = rows().find((row) => row.id === lastDelta)!
    expect(kept.content).toBe('half done')
    expect(JSON.parse(kept.metadata!)).toEqual({ type: 'tool_result', tool_use_id: 'cmd-1' })
    expect(rows()).toHaveLength(5)
  })

  it('separates commands whose output interleaved', () => {
    add('user', 'go')
    call('cmd-1')
    call('cmd-2')
    for (let index = 0; index < 5; index++) {
      delta('cmd-1', `1.${index};`)
      delta('cmd-2', `2.${index};`)
    }
    final('cmd-1', '1.0;1.1;1.2;1.3;1.4;')
    final('cmd-2', '2.0;2.1;2.2;2.3;2.4;')
    const before = shownOutputs()

    expect(cleanAll()).toBe(10)
    expect(shownOutputs()).toEqual(before)
  })

  it('collapses a command whose output spans thousands of rows, reading correctly at every step', () => {
    add('user', 'go')
    call('cmd-1')
    const pieces = Array.from({ length: 1_200 }, (_, index) => `${index};`)
    for (const piece of pieces) delta('cmd-1', piece)
    final('cmd-1', pieces.join(''))
    add('assistant', 'Done.')
    const expected = shownOutputs()

    const cleanup = new OutputCleanup(database, OutputCleanup.begin(database))
    let steps = 0
    while (!cleanup.current.done) {
      cleanup.step(0) // one unit of work per step
      steps += 1
      expect(shownOutputs()).toEqual(expected)
    }
    expect(steps).toBeGreaterThan(5)
    expect(cleanup.current.deletedRows).toBe(1_200)
  })

  it('leaves alone a command whose joined output would be too large to write in one step', () => {
    add('user', 'go')
    call('cmd-1')
    for (let index = 0; index < 60; index++) delta('cmd-1', `${index}:${'x'.repeat(100_000)}`)
    final('cmd-1', 'truncated by Codex')
    const before = rows()
    const shown = shownOutputs()

    expect(cleanAll()).toBe(0)

    expect(rows().map((row) => row.id)).toEqual(before.map((row) => row.id))
    expect(shownOutputs()).toEqual(shown)
  })

  it('resumes after a restart midway without duplicating output', () => {
    add('user', 'go')
    call('cmd-1')
    for (let index = 0; index < 600; index++) delta('cmd-1', `${index};`)
    // No final result: the Turn was stopped.
    add('user', 'next')
    const expected = shownOutputs()['cmd-1']

    const first = new OutputCleanup(database, OutputCleanup.begin(database))
    let saved = first.current
    for (let unit = 0; unit < 6; unit++) saved = first.step(0)
    expect(saved.done).toBe(false)

    // The process restarts from the last saved state with no memory of the command.
    new OutputCleanup(database, saved).runToEnd()

    expect(shownOutputs()['cmd-1']).toBe(expected)
    expect(rows().filter((row) => row.content === expected)).toHaveLength(1)
    expect(rows()).toHaveLength(4)
  })

  it('leaves rows without deltas alone and is safe to run twice', () => {
    add('user', 'go')
    add('assistant', 'Hello', { type: 'text' })
    call('cmd-1')
    final('cmd-1', 'out')
    cleanAll()
    const once = rows()
    expect(cleanAll()).toBe(0)
    expect(rows()).toEqual(once)
    expect(once.map((row) => row.content)).toEqual(['go', 'Hello', 'ls', 'out'])
  })
})

describe('pageMessages over SQLite', () => {
  it('pages a thread from the newest message back, in created_at then rowid order', () => {
    for (let index = 0; index < 12; index++) add(index % 2 ? 'assistant' : 'user', `m${index}`)
    const tail = pageMessages({ threadId }, { kind: 'tail', limit: 5 })
    expect(tail.messages.map((message) => message.content)).toEqual(['m7', 'm8', 'm9', 'm10', 'm11'])
    expect(tail.hasOlder).toBe(true)

    const older = pageMessages({ threadId }, { kind: 'older', before: tail.messages[0].id, limit: 100 })
    expect(older.messages.map((message) => message.content)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'])
    expect(older.hasOlder).toBe(false)

    add('user', 'm12')
    const since = pageMessages({ threadId }, { kind: 'since', since: tail.messages.at(-1)!.id })
    expect(since.anchored).toBe(true)
    expect(since.messages.map((message) => message.content)).toEqual(['m11', 'm12'])
  })
})
