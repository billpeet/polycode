import type { RemoteConnectionStatus } from '@polycode/shared'

export interface HostConnection {
  baseUrl: string
  token: string
}

interface RpcResponse {
  ok?: boolean
  value?: unknown
  error?: string
}

export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('Host URL is required')
  const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  const url = new URL(withProtocol)
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/+$/, '')
}

export function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // AbortController timeouts surface as opaque "cancelled" errors.
  if (
    (error instanceof Error && error.name === 'AbortError') ||
    /abort|cancell?ed/i.test(message)
  ) {
    return 'Connection timed out — host unreachable'
  }
  return message
}

async function readJsonResponse(response: Response): Promise<RpcResponse> {
  try {
    return (await response.json()) as RpcResponse
  } catch {
    return {}
  }
}

/**
 * Call one remote-control RPC channel: POST /api/remote/rpc {channel, args}.
 * Resolves the unwrapped value or throws with the server's error message.
 */
export async function rpcRequest(host: HostConnection, channel: string, args: unknown[]): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    let response: Response
    try {
      response = await fetch(endpoint(host.baseUrl, '/api/remote/rpc'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${host.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channel, args }),
        signal: controller.signal,
      })
    } catch (error) {
      throw new Error(errorMessage(error))
    }
    const body = await readJsonResponse(response)
    if (!response.ok || !body.ok) {
      throw new Error(body.error ?? `Remote request failed with HTTP ${response.status}`)
    }
    return body.value
  } finally {
    clearTimeout(timer)
  }
}

/** GET /api/remote/health with a 5s timeout. Auth is required even for health. */
export async function testConnection(host: HostConnection): Promise<RemoteConnectionStatus> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      const response = await fetch(endpoint(host.baseUrl, '/api/remote/health'), {
        method: 'GET',
        headers: { Authorization: `Bearer ${host.token}` },
        signal: controller.signal,
      })
      const body = await readJsonResponse(response)
      if (response.ok && body.ok) return { ok: true }
      return { ok: false, error: body.error ?? `HTTP ${response.status}` }
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}
