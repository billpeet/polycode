import { homedir } from 'os'
import { SshConfig, WslConfig } from '../shared/types'
import { createRunner } from './driver/runner'

export interface CodexAvailableModelOption {
  id: string
  label: string
}

type CacheEntry = {
  expiresAt: number
  value: CodexAvailableModelOption[]
}

type JsonRpcMessage = {
  id?: unknown
  result?: unknown
  error?: { message?: string } | string
}

type CodexModel = {
  id?: unknown
  model?: unknown
  displayName?: unknown
  hidden?: unknown
  isDefault?: unknown
}

const SUCCESS_TTL_MS = 60 * 60_000
const EMPTY_TTL_MS = 5 * 60_000
const ERROR_TTL_MS = 60_000
const REQUEST_TIMEOUT_MS = 15_000

const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<CodexAvailableModelOption[]>>()

function cacheKey(ssh?: SshConfig | null, wsl?: WslConfig | null): string {
  if (ssh) return `ssh:${ssh.user}@${ssh.host}:${ssh.port ?? 22}:${ssh.keyPath ?? ''}`
  if (wsl) return `wsl:${wsl.distro}`
  return 'local'
}

function normalizeModels(result: unknown): CodexAvailableModelOption[] {
  const data = (result as { data?: unknown } | undefined)?.data
  if (!Array.isArray(data)) return []

  return data
    .map((raw): (CodexAvailableModelOption & { isDefault?: boolean }) | null => {
      const model = raw as CodexModel
      const id = typeof model.model === 'string'
        ? model.model
        : typeof model.id === 'string'
          ? model.id
          : undefined
      if (!id) return null
      const displayName = typeof model.displayName === 'string' && model.displayName.trim()
        ? model.displayName.trim()
        : id
      return {
        id,
        label: displayName,
        isDefault: model.isDefault === true,
      }
    })
    .filter((model): model is CodexAvailableModelOption & { isDefault?: boolean } => model !== null)
    .sort((a, b) => {
      if (a.isDefault && !b.isDefault) return -1
      if (!a.isDefault && b.isDefault) return 1
      return a.label.localeCompare(b.label)
    })
    .map(({ isDefault: _isDefault, ...model }) => model)
}

function readCached(key: string): CodexAvailableModelOption[] | undefined {
  const cached = cache.get(key)
  if (!cached || cached.expiresAt <= Date.now()) return undefined
  return cached.value
}

function writeCache(key: string, value: CodexAvailableModelOption[], ttlMs: number): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs })
}

async function queryCodexAvailableModels(
  cwd: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<CodexAvailableModelOption[]> {
  return new Promise((resolve, reject) => {
    const runner = createRunner({ ssh: ssh ?? undefined, wsl: wsl ?? undefined })
    const proc = runner.spawn({
      binary: 'codex',
      args: ['app-server', '--listen', 'stdio://'],
      workDir: cwd,
      keepStdinOpen: true,
    })

    let stdoutBuffer = ''
    let stderrBuffer = ''
    let settled = false
    let initialized = false

    const finish = (error: Error | null, models?: CodexAvailableModelOption[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
      if (error) reject(error)
      else resolve(models ?? [])
    }

    const send = (message: object) => {
      proc.stdin?.write(JSON.stringify(message) + '\n')
    }

    const timer = setTimeout(() => {
      finish(new Error(`Timed out while asking codex for available models${stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : ''}`))
    }, REQUEST_TIMEOUT_MS)

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue
        let parsed: JsonRpcMessage
        try {
          parsed = JSON.parse(line) as JsonRpcMessage
        } catch {
          continue
        }

        if (parsed.id === 1) {
          if (parsed.error) {
            const message = typeof parsed.error === 'string' ? parsed.error : parsed.error.message
            finish(new Error(message || 'codex initialize failed'))
            return
          }
          if (!initialized) {
            initialized = true
            send({ method: 'initialized', params: {} })
            send({ id: 2, method: 'model/list', params: { includeHidden: false } })
          }
          continue
        }

        if (parsed.id === 2) {
          if (parsed.error) {
            const message = typeof parsed.error === 'string' ? parsed.error : parsed.error.message
            finish(new Error(message || 'codex model/list failed'))
            return
          }
          finish(null, normalizeModels(parsed.result))
          return
        }
      }
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf8')
    })

    proc.on('error', (error) => finish(error))
    proc.on('close', (code) => {
      if (!settled && code !== 0 && code !== null) {
        finish(new Error(`codex exited with code ${code}${stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : ''}`))
      }
    })

    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'polycode',
          title: 'PolyCode',
          version: '0.13.0',
        },
      },
    })
  })
}

export async function listCodexAvailableModels(options: {
  cwd?: string | null
  ssh?: SshConfig | null
  wsl?: WslConfig | null
} = {}): Promise<CodexAvailableModelOption[]> {
  const key = cacheKey(options.ssh, options.wsl)
  const cached = readCached(key)
  if (cached) return cached

  const existing = inFlight.get(key)
  if (existing) return existing

  const cwd = options.cwd || (options.ssh || options.wsl ? '~' : homedir())

  const promise = queryCodexAvailableModels(cwd, options.ssh, options.wsl)
    .then((models) => {
      writeCache(key, models, models.length > 0 ? SUCCESS_TTL_MS : EMPTY_TTL_MS)
      return models
    })
    .catch((error) => {
      writeCache(key, [], ERROR_TTL_MS)
      throw error
    })
    .finally(() => {
      inFlight.delete(key)
    })

  inFlight.set(key, promise)
  return promise
}
