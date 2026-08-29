import { afterEach, describe, expect, it } from 'vitest'
import * as http from 'http'
import * as net from 'net'
import { RemoteTunnelPool } from '../remote-forward'
import { attachRemoteBrowserTunnel } from '../../remote/browser-tunnel'

const servers: Array<http.Server> = []

function listen(server: http.Server): Promise<number> {
  servers.push(server)
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve((server.address() as net.AddressInfo).port)
  }))
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

describe('remote browser forwarding', () => {
  it('loads the remote host localhost and preserves the browser Host header', async () => {
    const devPort = await listen(http.createServer((req, res) => {
      res.end(JSON.stringify({ url: req.url, host: req.headers.host }))
    }))
    const controlServer = http.createServer((_req, res) => res.end())
    const controlPort = await listen(controlServer)
    const config = { enabled: true, host: '127.0.0.1', port: controlPort, token: 'test-token' }
    attachRemoteBrowserTunnel(controlServer, config)

    const pool = new RemoteTunnelPool({
      id: 'host-1', label: 'Remote', baseUrl: `http://127.0.0.1:${controlPort}`,
      token: config.token, createdAt: '', updatedAt: '',
    })
    const handle = await pool.acquire('localhost', devPort)
    try {
      const body = await new Promise<string>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: handle.localPort, path: '/ready', headers: { host: `localhost:${devPort}` } }, (res) => {
          let value = ''
          res.on('data', (chunk: Buffer) => { value += chunk })
          res.on('end', () => resolve(value))
        }).once('error', reject)
      })
      expect(JSON.parse(body)).toEqual({ url: '/ready', host: `localhost:${devPort}` })
    } finally {
      pool.dispose()
    }
  })

  it('rejects unauthenticated tunnels and non-loopback targets', async () => {
    const controlServer = http.createServer((_req, res) => res.end())
    const controlPort = await listen(controlServer)
    attachRemoteBrowserTunnel(controlServer, {
      enabled: true, host: '127.0.0.1', port: controlPort, token: 'correct-token',
    })

    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: controlPort, method: 'CONNECT',
        path: '/api/remote/browser-tunnel?host=example.com&port=80',
        headers: { Authorization: 'Bearer correct-token' },
      })
      req.once('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 0) })
      req.once('response', (res) => { res.resume(); resolve(res.statusCode ?? 0) })
      req.once('error', reject)
      req.end()
    })
    expect(status).toBe(400)
  })
})
