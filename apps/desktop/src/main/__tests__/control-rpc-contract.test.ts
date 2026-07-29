import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHANNEL_REGISTRY, REMOTE_CHANNELS } from '@polycode/shared'

const mainDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const handlersSource = readFileSync(join(mainDir, 'ipc', 'handlers.ts'), 'utf8')
const rpcSource = readFileSync(join(mainDir, 'control', 'control-rpc.ts'), 'utf8')
const remoteServerSource = readFileSync(join(mainDir, 'remote', 'server.ts'), 'utf8')

function literalChannels(source: string, pattern: RegExp): Set<string> {
  return new Set([...source.matchAll(pattern)].map((match) => match[1]))
}

describe('remote control RPC channel contract', () => {
  const proxyableChannels = literalChannels(handlersSource, /\bproxyable\(\s*['"]([^'"]+)['"]/g)
  const directlyProxiedChannels = literalChannels(
    handlersSource,
    /\bipcMain\.handle\(\s*['"]([^'"]+)['"][\s\S]{0,250}?remoteClient\.invokeIfActive\(\s*['"]\1['"]/g,
  )
  const allowedChannels = new Set<string>(REMOTE_CHANNELS)
  const dispatchedChannels = literalChannels(rpcSource, /\bcase\s+['"]([^'"]+)['"]\s*:/g)

  test('desktop proxyable registrations equal local and remote registry entries', () => {
    const expected = Object.entries(CHANNEL_REGISTRY)
      .filter(([, capabilities]) => capabilities.local && capabilities.remote)
      .map(([channel]) => channel)
    expect([...new Set([...proxyableChannels, ...directlyProxiedChannels])].sort()).toEqual(expected.sort())
  })

  test('server-supported project and location mutations are not local-only', () => {
    const localOnlyChannels = literalChannels(
      handlersSource,
      /\bipcMain\.handle\(\s*['"]((?:projects|locations|location-pools):[^'"]+)['"]/g,
    )
    const incorrectlyLocal = [...localOnlyChannels].filter((channel) => allowedChannels.has(channel))
    expect(incorrectlyLocal).toEqual([])
  })

  test('every remote registry channel has a dispatcher case', () => {
    const missing = [...allowedChannels].filter((channel) => !dispatchedChannels.has(channel))
    expect(missing).toEqual([])
  })

  test('remote-only channels are explicit', () => {
    const remoteOnly = Object.entries(CHANNEL_REGISTRY)
      .filter(([, capabilities]) => !capabilities.local && capabilities.remote)
      .map(([channel]) => channel)
    expect(remoteOnly).toEqual(['attachments:readDataUrl', 'plans:getForThread'])
  })

  test('local-only remote-control adapter channels are explicit', () => {
    const localOnlyRemoteControlChannels = Object.entries(CHANNEL_REGISTRY)
      .filter(([channel, capabilities]) => channel.startsWith('remote:') && capabilities.local && !capabilities.remote)
      .map(([channel]) => channel)
    expect(localOnlyRemoteControlChannels).toEqual([
      'remote:getServerConfig',
      'remote:setServerConfig',
      'remote:regenerateServerToken',
      'remote:getHosts',
      'remote:addHost',
      'remote:updateHost',
      'remote:removeHost',
      'remote:setActiveHost',
      'remote:getActiveHost',
      'remote:testHost',
      'remote:getPairingInfo',
    ])
  })

  test('origin-specific behavior is explicit', () => {
    expect(CHANNEL_REGISTRY['threads:send']).toMatchObject({ originAware: true })
  })

  test('obsolete plan file handlers are not retained as local-only IPC', () => {
    expect(handlersSource).not.toMatch(/ipcMain\.handle\(\s*['"]plans:(?:list|read)['"]/)
  })

  test('remote git watcher events remain on the SSE stream', () => {
    expect(remoteServerSource).toContain("channel === 'git:repoChanged'")
  })
})
