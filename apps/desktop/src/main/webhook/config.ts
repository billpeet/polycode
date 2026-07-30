import { randomBytes } from 'crypto'
import { getSetting, setSetting } from '../db/queries'

const WEBHOOK_ENABLED_KEY = 'webhook:enabled'
const WEBHOOK_PORT_KEY = 'webhook:port'
const WEBHOOK_TOKEN_KEY = 'webhook:token'

export const DEFAULT_WEBHOOK_PORT = 3284

export interface WebhookConfig {
  enabled: boolean
  port: number
  token: string
}

function parsePort(value: string | null): number {
  const port = parseInt(value ?? String(DEFAULT_WEBHOOK_PORT), 10)
  return Number.isInteger(port) && port >= 1024 && port <= 65535
    ? port
    : DEFAULT_WEBHOOK_PORT
}

function createToken(): string {
  return randomBytes(24).toString('hex')
}

function ensureToken(): string {
  const existing = getSetting(WEBHOOK_TOKEN_KEY)
  if (existing?.trim()) return existing.trim()

  const token = createToken()
  setSetting(WEBHOOK_TOKEN_KEY, token)
  return token
}

export function readWebhookConfig(): WebhookConfig {
  return {
    enabled: getSetting(WEBHOOK_ENABLED_KEY) === 'true',
    port: parsePort(getSetting(WEBHOOK_PORT_KEY)),
    token: ensureToken(),
  }
}

export function saveWebhookConfig(config: WebhookConfig): WebhookConfig {
  const next: WebhookConfig = {
    enabled: Boolean(config.enabled),
    port: parsePort(String(config.port)),
    token: config.token?.trim() || createToken(),
  }

  setSetting(WEBHOOK_ENABLED_KEY, next.enabled ? 'true' : 'false')
  setSetting(WEBHOOK_PORT_KEY, String(next.port))
  setSetting(WEBHOOK_TOKEN_KEY, next.token)
  return next
}
