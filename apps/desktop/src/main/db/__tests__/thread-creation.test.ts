import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '../migrations'

let database: Database.Database

vi.mock('../index', () => ({ getDb: () => database }))

const { createThreadForLocation, StaleThreadSelectionError } = await import('../queries')

beforeEach(() => {
  database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  runMigrations(database)

  const now = new Date().toISOString()
  const insertProject = database.prepare(
    'INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  )
  insertProject.run('p1', 'Project one', 'C:/one', now, now)
  insertProject.run('p2', 'Project two', 'C:/two', now, now)
  database.prepare(
    'INSERT INTO repo_locations (id, project_id, label, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('loc-1', 'p1', 'Local', 'C:/one', now, now)
})

afterEach(() => {
  database.close()
})

describe('transactional thread creation', () => {
  it('rejects a location that was deleted before creation with a typed stale-selection error', () => {
    database.prepare('DELETE FROM repo_locations WHERE id = ?').run('loc-1')

    expect(() => createThreadForLocation('p1', 'New thread', 'loc-1'))
      .toThrow(StaleThreadSelectionError)
    expect(() => createThreadForLocation('p1', 'New thread', 'loc-1'))
      .toThrow('The selected project location is no longer available. Refresh and try again.')
  })

  it('rejects a location belonging to another project', () => {
    expect(() => createThreadForLocation('p2', 'New thread', 'loc-1'))
      .toThrow(StaleThreadSelectionError)
  })

  it('derives provider and model and inserts for the validated project/location pair', () => {
    const previous = createThreadForLocation('p1', 'Previous', 'loc-1')
    database.prepare(
      'UPDATE threads SET provider = ?, model = ?, provider_model_updated_at = ? WHERE id = ?'
    ).run('codex', 'gpt-5.6', new Date().toISOString(), previous.id)

    const created = createThreadForLocation('p1', 'New thread', 'loc-1')

    expect(created).toMatchObject({
      project_id: 'p1',
      location_id: 'loc-1',
      provider: 'codex',
      model: 'gpt-5.6',
    })
  })
})
