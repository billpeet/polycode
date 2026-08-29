import * as http from 'http'
import * as https from 'https'
import * as net from 'net'
import type { RemoteHost } from '../../shared/types'
import type { ForwardHandle } from './port-forward'

interface ForwardServer {
  server: net.Server
  port: number
}

/**
 * Presents local TCP endpoints whose connections are carried to the active
 * PolyCode host with an authenticated HTTP CONNECT request. The host opens the
 * final loopback socket, so `localhost` means the host running project commands.
 */
export class RemoteTunnelPool {
  private forwards = new Map<string, Promise<ForwardServer>>()
  private disposed = false

  constructor(private readonly remote: RemoteHost) {}

  async acquire(host: string, port: number): Promise<ForwardHandle> {
    if (this.disposed) throw new Error('Remote tunnel pool is disposed')
    const key = `${host}:${port}`
    let pending = this.forwards.get(key)
    if (!pending) {
      pending = this.listen(host, port)
      this.forwards.set(key, pending)
      pending.catch(() => this.forwards.delete(key))
    }
    const forward = await pending
    return { localPort: forward.port, retain: () => {}, release: () => {} }
  }

  dispose(): void {
    this.disposed = true
    for (const pending of this.forwards.values()) {
      void pending.then(({ server }) => server.close()).catch(() => {})
    }
    this.forwards.clear()
  }

  private listen(host: string, port: number): Promise<ForwardServer> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.connect(socket, host, port))
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        const address = server.address()
        if (!address || typeof address === 'string') {
          server.close()
          reject(new Error('Remote browser forward failed to bind'))
          return
        }
        server.on('error', () => {})
        resolve({ server, port: address.port })
      })
    })
  }

  private connect(client: net.Socket, host: string, port: number): void {
    const base = new URL(this.remote.baseUrl)
    const request = (base.protocol === 'https:' ? https : http).request({
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port || undefined,
      method: 'CONNECT',
      path: `/api/remote/browser-tunnel?host=${encodeURIComponent(host)}&port=${port}`,
      headers: { Authorization: `Bearer ${this.remote.token}` },
    })

    const fail = (): void => { client.destroy() }
    request.once('connect', (response, tunnel, head) => {
      if (response.statusCode !== 200) {
        tunnel.destroy()
        fail()
        return
      }
      if (head.length > 0) client.write(head)
      client.pipe(tunnel)
      tunnel.pipe(client)
      client.once('error', () => tunnel.destroy())
      tunnel.once('error', fail)
    })
    request.once('response', (response) => {
      response.resume()
      fail()
    })
    request.once('error', fail)
    request.end()
  }
}
