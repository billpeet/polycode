import { randomBytes } from 'crypto'
import { getSetting, setSetting } from '../db/queries'
import { RemoteServerConfig } from '../../shared/types'

const SERVER_ENABLED_KEY = 'remote:server:enabled'
const SERVER_HOST_KEY = 'remote:server:host'
const SERVER_PORT_KEY = 'remote:server:port'
const SERVER_TOKEN_KEY = 'remote:server:token'

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

export function readRemoteServerConfig(): RemoteServerConfig {
  return {
    enabled: getSetting(SERVER_ENABLED_KEY) === 'true',
    host: normalizeHost(getSetting(SERVER_HOST_KEY)),
    port: parsePort(getSetting(SERVER_PORT_KEY)),
    token: ensureToken(),
  }
}

export function saveRemoteServerConfig(config: RemoteServerConfig): RemoteServerConfig {
  const next: RemoteServerConfig = {
    enabled: Boolean(config.enabled),
    host: normalizeHost(config.host),
    port: parsePort(String(config.port)),
    token: config.token?.trim() || randomBytes(24).toString('hex'),
  }

  setSetting(SERVER_ENABLED_KEY, next.enabled ? 'true' : 'false')
  setSetting(SERVER_HOST_KEY, next.host)
  setSetting(SERVER_PORT_KEY, String(next.port))
  setSetting(SERVER_TOKEN_KEY, next.token)
  return next
}
