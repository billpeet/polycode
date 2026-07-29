import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHANNEL_REGISTRY, REMOTE_CHANNELS } from '@polycode/shared'

const mainDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const handlersSource = readFileSync(join(mainDir, 'ipc', 'handlers.ts'), 'utf8')
const rpcSource = readFileSync(join(mainDir, 'control', 'control-rpc.ts'), 'utf8')
const remoteServerSource = readFileSync(join(mainDir, 'remote', 'server.ts'), 'utf8')
const handlerMapSource = readFileSync(join(mainDir, 'ipc', 'channel-handlers.ts'), 'utf8')

function literalChannels(source: string, pattern: RegExp): Set<string> {
  return new Set([...source.matchAll(pattern)].map((match) => match[1]))
}

/**
 * Channels folded into the typed handler map. Read from source rather than imported so
 * this file stays free of the database and Electron, like the rest of its assertions.
 */
export const migratedChannels = literalChannels(handlerMapSource, /^ {2}'([^']+)':/gm)

describe('remote control RPC channel contract', () => {
  // A folded channel is registered by the `MIGRATED_CHANNELS` loop in handlers.ts and
  // dispatched by the `isMigratedChannel` branch in control-rpc.ts, so it satisfies both
  // sides without a literal `proxyable(...)` or `case '...':`. These sets shrink to the
  // legacy sites only, and empty out entirely when the migration completes.
  const proxyableChannels = literalChannels(handlersSource, /\bproxyable\(\s*['"]([^'"]+)['"]/g)
  const directlyProxiedChannels = literalChannels(
    handlersSource,
    /\bipcMain\.handle\(\s*['"]([^'"]+)['"][\s\S]{0,250}?remoteClient\.invokeIfActive\(\s*['"]\1['"]/g,
  )
  const allowedChannels = new Set<string>(REMOTE_CHANNELS)
  const dispatchedChannels = new Set<string>([
    ...literalChannels(rpcSource, /\bcase\s+['"]([^'"]+)['"]\s*:/g),
    ...migratedChannels,
  ])

  test('desktop proxyable registrations equal local and remote registry entries', () => {
    const expected = Object.entries(CHANNEL_REGISTRY)
      .filter(([, capabilities]) => capabilities.local && capabilities.remote)
      .map(([channel]) => channel)
    // The folded map is no longer only dual-path: it also holds local-only
    // (`attachments:getFileInfo`, `attachments:saveFromPath`) and remote-only
    // (`attachments:readDataUrl`, `plans:getForThread`) channels, whose reachability comes
    // from the registry guards in the two adapters — `isLocalChannel` in handlers.ts,
    // `isRemoteChannel` in control-rpc.ts. Membership of the map is therefore no longer the
    // same claim as "registered on ipcMain with a remote-forwarding hop", which is what
    // this test is about, so only the dual-path entries count here.
    //
    // The assertion still bites in both directions: a dual-path channel missing from all
    // three sets fails, and a local-only channel appearing in a literal `proxyable(...)`
    // registration fails.
    const dualPathMigrated = [...migratedChannels].filter((channel) => {
      const capabilities = CHANNEL_REGISTRY[channel as keyof typeof CHANNEL_REGISTRY]
      return Boolean(capabilities?.local && capabilities.remote)
    })
    const registered = new Set([...proxyableChannels, ...directlyProxiedChannels, ...dualPathMigrated])
    expect([...registered].sort()).toEqual(expected.sort())
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

  test('pull request operations use only the provider-neutral Forge channels', () => {
    const forgeChannels = Object.keys(CHANNEL_REGISTRY).filter((channel) => channel.startsWith('forge:'))
    expect(forgeChannels).toEqual([
      'forge:pr:list',
      'forge:pr:current',
      'forge:pr:create',
      'forge:pr:checkout',
      'forge:pr:webUrl',
      'forge:repo:webUrl',
    ])
    expect(Object.keys(CHANNEL_REGISTRY).filter((channel) => /^(?:azdo|gh):/.test(channel))).toEqual([])
  })

  test('obsolete plan file handlers are not retained as local-only IPC', () => {
    expect(handlersSource).not.toMatch(/ipcMain\.handle\(\s*['"]plans:(?:list|read)['"]/)
  })

  test('remote git watcher events remain on the SSE stream', () => {
    expect(remoteServerSource).toContain("channel === 'git:repoChanged'")
  })
})
