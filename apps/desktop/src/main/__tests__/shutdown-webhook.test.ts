import { EventEmitter } from 'node:events'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import type { BrowserWindow } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { startWebhookServer, stopWebhookServer } from '../webhook/server'
import { resetAppLifecycleForTest, shutdownApp, waitForAppOperations } from '../app-lifecycle'

const h = vi.hoisted(() => ({ handler: null as RequestListener | null, query: vi.fn() }))
vi.mock('electron', () => ({}))
vi.mock('http', () => ({
  createServer: (handler: RequestListener) => {
    h.handler = handler
    return Object.assign(new EventEmitter(), { listen: () => {}, close: () => {} })
  },
}))
vi.mock('../session/manager', () => ({ sessionManager: {} }))
vi.mock('../db/queries', () => ({ getProjectByName: (...args: unknown[]) => h.query(...args) }))
vi.mock('../app-events', () => ({ emitAppEvent: () => {} }))

afterEach(() => { stopWebhookServer(); resetAppLifecycleForTest(); vi.clearAllMocks() })

it('rejects a webhook whose body arrives after shutdown without querying SQLite', async () => {
  startWebhookServer({ enabled: true, port: 3284, token: 'test-token' }, {} as BrowserWindow)
  const req = Object.assign(new EventEmitter(), {
    method: 'POST', url: '/api/threads',
    headers: { host: '127.0.0.1:3284', authorization: 'Bearer test-token' },
  }) as IncomingMessage
  const res = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() }
  const request = h.handler!(req, res as unknown as ServerResponse)
  await shutdownApp({
    stopProducers: stopWebhookServer, awaitProducers: waitForAppOperations,
    closeDatabase: () => h.query.mockImplementation(() => { throw new Error('Database is closed') }),
    finish: () => {},
  })
  req.emit('data', '{"project":"private-project"}')
  req.emit('end')
  await request
  expect(res.writeHead).toHaveBeenCalledWith(503, expect.any(Object))
  expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({ code: 'APP_SHUTTING_DOWN' })
  expect(h.query).not.toHaveBeenCalled()
})
