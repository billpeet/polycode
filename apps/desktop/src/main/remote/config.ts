import { randomBytes } from 'crypto'
import { getSetting, setSetting } from '../db/queries'
import { RemoteServerConfig } from '../../shared/types'
import { normalizeTailscaleLogins } from './identity'

const SERVER_ENABLED_KEY = 'remote:server:enabled'
const SERVER_HOST_KEY = 'remote:server:host'
const SERVER_PORT_KEY = 'remote:server:port'
const SERVER_TOKEN_KEY = 'remote:server:token'
const SERVER_WEB_ENABLED_KEY = 'remote:server:web'
const SERVER_ALLOWED_HOSTNAMES_KEY = 'remote:server:allowedHostnames'
const SERVER_TAILSCALE_LOGINS_KEY = 'remote:server:tailscaleLogins'

export const DEFAULT_REMOTE_CONTROL_PORT = 3285
export const DEFAULT_REMOTE_CONTROL_HOST = '127.0.0.1'

function parsePort(value: string | null): number {
  const port = parseInt(value ?? String(DEFAULT_REMOTE_CONTROL_PORT), 10)
  return Number.isInteger(port) && port >= 1024 && port <= 65535
    ? port
    : DEFAULT_REMOTE_CONTROL_PORT
}

function normalizeHost(value: string | null): string {
  const host = value?.trim()
  return host || DEFAULT_REMOTE_CONTROL_HOST
}

function ensureToken(): string {
  const existing = getSetting(SERVER_TOKEN_KEY)
  if (existing?.trim()) return existing.trim()
  const token = randomBytes(24).toString('hex')
  setSetting(SERVER_TOKEN_KEY, token)
  return token
}

/**
 * One user-typed hostname to its canonical form: lower-case, no scheme, no port, no
 * path. `pc.tailnet.ts.net`, `PC.tailnet.ts.net:443` and `https://pc.tailnet.ts.net/`
 * all become `pc.tailnet.ts.net`. Anything the URL parser rejects is dropped.
 */
function parseHostname(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) return null
  const candidate = trimmed.includes('://') ? trimmed : `http://${trimmed}`
  try {
    return new URL(candidate).hostname || null
  } catch {
    return null
  }
}

export function normalizeAllowedHostnames(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const out = new Set<string>()
  for (const raw of values) {
    if (typeof raw !== 'string') continue
    const hostname = parseHostname(raw)
    if (hostname) out.add(hostname)
  }
  return [...out]
}

function readJsonList(key: string, normalize: (values: unknown) => string[]): string[] {
  const raw = getSetting(key)
  if (!raw) return []
  try {
    return normalize(JSON.parse(raw))
  } catch {
    return []
  }
}

export function readRemoteServerConfig(): RemoteServerConfig {
  return {
    enabled: getSetting(SERVER_ENABLED_KEY) === 'true',
    host: normalizeHost(getSetting(SERVER_HOST_KEY)),
    port: parsePort(getSetting(SERVER_PORT_KEY)),
    token: ensureToken(),
    webEnabled: getSetting(SERVER_WEB_ENABLED_KEY) === 'true',
    allowedHostnames: readJsonList(SERVER_ALLOWED_HOSTNAMES_KEY, normalizeAllowedHostnames),
    tailscaleLogins: readJsonList(SERVER_TAILSCALE_LOGINS_KEY, normalizeTailscaleLogins),
  }
}

export function saveRemoteServerConfig(config: RemoteServerConfig): RemoteServerConfig {
  const next: RemoteServerConfig = {
    enabled: Boolean(config.enabled),
    host: normalizeHost(config.host),
    port: parsePort(String(config.port)),
    token: config.token?.trim() || randomBytes(24).toString('hex'),
    webEnabled: Boolean(config.webEnabled),
    allowedHostnames: normalizeAllowedHostnames(config.allowedHostnames),
    tailscaleLogins: normalizeTailscaleLogins(config.tailscaleLogins),
  }

  setSetting(SERVER_ENABLED_KEY, next.enabled ? 'true' : 'false')
  setSetting(SERVER_HOST_KEY, next.host)
  setSetting(SERVER_PORT_KEY, String(next.port))
  setSetting(SERVER_TOKEN_KEY, next.token)
  setSetting(SERVER_WEB_ENABLED_KEY, next.webEnabled ? 'true' : 'false')
  setSetting(SERVER_ALLOWED_HOSTNAMES_KEY, JSON.stringify(next.allowedHostnames))
  setSetting(SERVER_TAILSCALE_LOGINS_KEY, JSON.stringify(next.tailscaleLogins))
  return next
}
