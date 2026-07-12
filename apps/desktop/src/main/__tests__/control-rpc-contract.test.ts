import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const mainDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const handlersSource = readFileSync(join(mainDir, 'ipc', 'handlers.ts'), 'utf8')
const rpcSource = readFileSync(join(mainDir, 'control', 'control-rpc.ts'), 'utf8')
const remoteServerSource = readFileSync(join(mainDir, 'remote', 'server.ts'), 'utf8')
const mobileRpcSource = readFileSync(join(mainDir, '..', '..', '..', 'mobile', 'src', 'api', 'rpc.ts'), 'utf8')

function literalChannels(source: string, pattern: RegExp): Set<string> {
  return new Set([...source.matchAll(pattern)].map((match) => match[1]))
}

describe('remote control RPC channel contract', () => {
  const proxyableChannels = literalChannels(handlersSource, /\bproxyable\(\s*['"]([^'"]+)['"]/g)
  const allowlistBody = rpcSource.match(/CONTROL_RPC_CHANNELS\s*=\s*new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? ''
  const allowedChannels = literalChannels(allowlistBody, /['"]([^'"]+)['"]/g)
  const dispatchedChannels = literalChannels(rpcSource, /\bcase\s+['"]([^'"]+)['"]\s*:/g)
  const mobileChannels = literalChannels(mobileRpcSource, /^\s*['"]([^'"]+)['"]\s*:/gm)

  test('every desktop proxyable channel is accepted by the server', () => {
    const missing = [...proxyableChannels].filter((channel) => !allowedChannels.has(channel))
    expect(missing).toEqual([])
  })

  test('server-supported project and location mutations are not local-only', () => {
    const localOnlyChannels = literalChannels(
      handlersSource,
      /\bipcMain\.handle\(\s*['"]((?:projects|locations|location-pools):[^'"]+)['"]/g,
    )
    const incorrectlyLocal = [...localOnlyChannels].filter((channel) => allowedChannels.has(channel))
    expect(incorrectlyLocal).toEqual([])
  })

  test('every allowlisted channel has a dispatcher case', () => {
    const missing = [...allowedChannels].filter((channel) => !dispatchedChannels.has(channel))
    expect(missing).toEqual([])
  })

  test('host-domain operations are wired through every desktop RPC layer', () => {
    const required = [
      'projects:create', 'projects:createFull', 'projects:update', 'projects:delete',
      'projects:archive', 'projects:unarchive',
      'locations:create', 'locations:update', 'locations:delete',
      'locations:createWorktree', 'locations:removeWorktree',
      'locations:suggestPath', 'locations:clone',
      'location-pools:create', 'location-pools:update', 'location-pools:delete',
      'ssh:test', 'wsl:test', 'wsl:list-distros',
      'threads:updateCursorThinking', 'threads:updateCursorContext',
      'git:watchStart', 'git:watchStop',
      'claude-history:listProjects', 'claude-history:listSessions',
      'claude-history:importedIds', 'claude-history:import',
      'youtrack:servers:list', 'youtrack:servers:create', 'youtrack:servers:update',
      'youtrack:servers:delete', 'youtrack:test', 'youtrack:search',
    ]
    for (const channel of required) {
      expect(proxyableChannels.has(channel), `${channel} is not proxyable`).toBe(true)
      expect(allowedChannels.has(channel), `${channel} is not allowlisted`).toBe(true)
      expect(dispatchedChannels.has(channel), `${channel} is not dispatched`).toBe(true)
      expect(mobileChannels.has(channel), `${channel} is missing from the mobile RPC map`).toBe(true)
    }
  })

  test('obsolete plan file handlers are not retained as local-only IPC', () => {
    expect(handlersSource).not.toMatch(/ipcMain\.handle\(\s*['"]plans:(?:list|read)['"]/)
  })

  test('remote git watcher events remain on the SSE stream', () => {
    expect(remoteServerSource).toContain("channel === 'git:repoChanged'")
  })
})
