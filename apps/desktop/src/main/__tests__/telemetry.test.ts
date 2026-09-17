import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node'
import Database from 'better-sqlite3'
import { instrumentDatabase } from '../db/telemetry'
import { runGit } from '../git-runner'
import { FakeRunner } from '../driver/runner/fake'
import { afterEach, expect, it, vi } from 'vitest'
import { initializeObservability, shutdownObservability, withSpan, withSyncSpan } from '../observability'

afterEach(async () => { await shutdownObservability(); vi.restoreAllMocks() })

it('exports git retries and synchronous database queries under their IPC parent', async () => {
  const spans: ReadableSpan[] = []
  vi.spyOn(OTLPTraceExporter.prototype, 'export').mockImplementation((batch, callback) => {
    spans.push(...batch)
    callback({ code: 0 })
  })
  initializeObservability({ endpoint: 'http://localhost:4318', serviceVersion: 'test', environment: 'test', serviceInstanceId: 'installation' })
  const database = new Database(':memory:')
  instrumentDatabase(database)
  const runner = new FakeRunner()
  runner.queueResult({ stderr: 'Another git process seems to be running', exitCode: 128 })
  runner.queueResult({ stdout: 'done' })
  try {
    await withSpan('ipc.test', {}, async () => {
      await runGit(runner, '/repo', ['status'], { delay: async () => {} })
      database.exec('CREATE TABLE test (value TEXT)')
      const insert = database.prepare('INSERT INTO test VALUES (?)')
      expect(insert.run('private content').changes).toBe(1)
      expect(database.prepare('SELECT value FROM test').pluck().get()).toBe('private content')
      expect(database.prepare('SELECT value FROM test').all()).toEqual([{ value: 'private content' }])
      expect(() => database.prepare('INSERT INTO missing VALUES (?)').run('secret')).toThrow()
      expect(() => withSyncSpan('db.failure', {}, () => { throw new Error('failure') })).toThrow('failure')
    })
  } finally {
    database.close()
    await shutdownObservability()
  }
  const parent = spans.find(span => span.name === 'ipc.test')!
  const children = spans.filter(span => span !== parent)
  expect(children.length).toBeGreaterThanOrEqual(7)
  for (const child of children) {
    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId)
    expect(child.resource.attributes['service.instance.id']).toBe('installation')
    expect(JSON.stringify(child.attributes)).not.toContain('private content')
  }
  const git = spans.filter(span => span.name === 'git.status')
  expect(git.map(span => span.attributes['process.exit.code'])).toEqual([128, 0])
  expect(git[0].attributes).toMatchObject({
    'git.repository': '/repo',
    'git.attempt': 1,
    'git.failure': 'locked',
    'git.stderr': 'Another git process seems to be running',
  })
  expect(git[0].status.code).toBe(2)
  expect(git[1].attributes).not.toHaveProperty('git.stderr')
  expect(spans.find(span => span.name === 'db.failure')?.status.code).toBe(2)
})

it('puts git stderr on failed spans without leaking credentials embedded in remote URLs', async () => {
  const { summarizeGitStderr } = await import('../git-runner')
  expect(summarizeGitStderr(
    "fatal: unable to access 'https://user:ghp_secret123@github.com/org/repo.git/': Could not resolve host\r\n  hint: try again\n\n",
  )).toBe("fatal: unable to access 'https://<redacted>@github.com/org/repo.git/': Could not resolve host | hint: try again")
  expect(summarizeGitStderr('x'.repeat(1000))).toHaveLength(256)
})
