import { homedir } from 'os'
import type { ModelOption, SshConfig, WslConfig } from '../shared/types'
import { KimiConnection, kimiConfig, kimiModels, record } from './driver/kimi-acp'

type QueryOptions = { cwd?: string | null; ssh?: SshConfig | null; wsl?: WslConfig | null; model?: string | null }
const cache = new Map<string, { expires: number; models: ModelOption[] }>()
const inFlight = new Map<string, Promise<ModelOption[]>>()

export function listKimiAvailableModels({ forceRefresh, ...options }: QueryOptions & { forceRefresh?: boolean } = {}): Promise<ModelOption[]> {
  const key = JSON.stringify(options)
  const cached = forceRefresh ? undefined : cache.get(key)
  if (cached && cached.expires > Date.now()) return Promise.resolve(cached.models)
  const pending = inFlight.get(key)
  if (pending) return pending
  const query = queryModels(options).then((models) => {
    cache.set(key, { expires: Date.now() + 60_000, models })
    return models
  }).finally(() => inFlight.delete(key))
  inFlight.set(key, query)
  return query
}

async function queryModels(options: QueryOptions): Promise<ModelOption[]> {
  const connection = new KimiConnection({ ...options, workingDir: options.cwd || (options.ssh || options.wsl ? '~' : homedir()) },
    (_method, _params, id) => { if (id !== undefined) connection.reject(id, 'Model discovery does not run tools') },
    () => undefined,
  )
  let sessionId: string | undefined
  try {
    await connection.start()
    const setup = record(await connection.request('session/new', { cwd: options.cwd || (options.ssh || options.wsl ? '~' : homedir()), mcpServers: [] }))
    sessionId = typeof setup.sessionId === 'string' ? setup.sessionId : undefined
    if (!sessionId) throw new Error('Kimi Code model discovery returned no session ID')
    const configured = options.model && options.model !== 'default'
      ? await connection.request('session/set_config_option', { sessionId, configId: 'model', value: options.model }) : setup
    const models = kimiModels(kimiConfig(configured))
    // Changing the probe's selected model must not relabel the CLI's saved default.
    models[0] = kimiModels(kimiConfig(setup))[0]
    return models
  } finally {
    if (sessionId) {
      // Only delete the empty session created by this probe, never a user's session.
      const method = record(connection.capabilities.sessionCapabilities).delete !== undefined ? 'session/delete' : 'session/close'
      await connection.request(method, { sessionId }, 3000).catch(() => undefined)
    }
    connection.close()
  }
}
