import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

const settings = vi.hoisted(() => new Map<string, string>())
vi.mock('electron', () => ({
  app: { getVersion: () => '0.14.300' },
  powerMonitor: { on: () => {}, off: () => {} },
  BrowserWindow: class {},
}))
vi.mock('../db/queries', () => ({
  getSetting: (key: string) => settings.get(key),
  setSetting: (key: string, value: string) => settings.set(key, value),
}))
vi.mock('../app-events', () => ({ emitAppEvent: () => {}, sendToRenderer: () => {} }))
import { RemoteControlClient } from '../remote/client'

let server: Server
let client: RemoteControlClient
afterEach(async () => {
  client?.stop()
  settings.clear()
  server?.closeAllConnections()
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function start(supportedChannels?: string[], rpcError?: Record<string, unknown>) {
  const calls: string[] = []
  let healthCalls = 0
  server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.headers.authorization !== 'Bearer test-token') {
      res.writeHead(401).end('{}')
      return
    }
    if (req.url === '/api/remote/health') {
      healthCalls++
      res.end(JSON.stringify({ ok: true, version: '0.14.261', supportedChannels }))
      return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    const { channel } = JSON.parse(raw) as { channel: string }
    calls.push(channel)
    if (rpcError || !supportedChannels?.includes(channel)) {
      res.writeHead(400).end(JSON.stringify(rpcError ?? { ok: false, error: 'Unsupported channel' }))
    } else res.end(JSON.stringify({ ok: true, value: [] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  client = new RemoteControlClient({} as import('electron').BrowserWindow)
  settings.set('remote:hosts', JSON.stringify([{
    id: 'old', label: 'Old host', baseUrl: `http://127.0.0.1:${port}`, token: 'test-token',
    createdAt: '', updatedAt: '',
  }]))
  settings.set('remote:activeHostId', 'old')
  return { calls, healthCalls: () => healthCalls }
}

describe('desktop client against an older HTTP host registry', () => {
  it.each([undefined, ['projects:list'], []])('blocks routines for manifest %j without local fallback', async (manifest) => {
    const host = await start(manifest)
    await expect(client.invokeIfActive('routines:list', ['p'])).rejects.toMatchObject({
      code: 'REMOTE_UNSUPPORTED_CHANNEL', channel: 'routines:list',
      hostVersion: '0.14.261', clientVersion: '0.14.300',
    })
    expect(host.calls).toEqual([])
  })

  it('shares negotiation and forwards advertised channels', async () => {
    const host = await start(['routines:list', 'projects:list'])
    await expect(Promise.all([
      client.invokeIfActive('routines:list', ['p']),
      client.invokeIfActive('projects:list', []),
    ])).resolves.toEqual([{ handled: true, value: [] }, { handled: true, value: [] }])
    expect(host.healthCalls()).toBe(1)
    expect(host.calls.sort()).toEqual(['projects:list', 'routines:list'])
  })

  it.each([
    { ok: false, error: 'Unsupported channel' },
    { ok: false, error: 'Not available', code: 'REMOTE_UNSUPPORTED_CHANNEL' },
  ])('normalizes unsupported RPC responses %j', async (error) => {
    await start(undefined, error)
    await expect(client.invokeIfActive('projects:list', [])).rejects.toMatchObject({
      code: 'REMOTE_UNSUPPORTED_CHANNEL', hostVersion: '0.14.261',
    })
  })

  it('gates every channel in an advertised manifest', async () => {
    const host = await start(['projects:list'])
    await expect(client.invokeIfActive('threads:create', [])).rejects.toMatchObject({ code: 'REMOTE_UNSUPPORTED_CHANNEL' })
    await expect(client.invokeIfActive('projects:list', [])).resolves.toMatchObject({ handled: true })
    expect(host.calls).toEqual(['projects:list'])
  })
})
