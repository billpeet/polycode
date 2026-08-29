import * as http from 'http'
import * as net from 'net'
import type { RemoteServerConfig } from '../../shared/types'
import { isLoopbackHost } from '../../shared/browser'
import { isValidBearerToken } from '../http-auth'
import { isAllowedHostHeader } from '../http-request-security'

/** Add the authenticated CONNECT endpoint used by controller browser sessions. */
export function attachRemoteBrowserTunnel(server: http.Server, config: RemoteServerConfig): void {
  server.on('connect', (req, socket, head) => {
    const client = socket as net.Socket
    if (!isAllowedHostHeader(req.headers.host, config.host, config.port)
      || !isValidBearerToken(req.headers.authorization, config.token)) {
      client.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return
    }
    const url = new URL(req.url ?? '/', `http://${config.host}:${config.port}`)
    const targetHost = url.searchParams.get('host') ?? ''
    const targetPort = Number(url.searchParams.get('port'))
    if (url.pathname !== '/api/remote/browser-tunnel'
      || !isLoopbackHost(targetHost)
      || !Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }

    const upstream = net.connect({ host: targetHost, port: targetPort })
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      client.pipe(upstream)
      upstream.pipe(client)
    })
    upstream.once('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'))
    client.once('error', () => upstream.destroy())
  })
}
