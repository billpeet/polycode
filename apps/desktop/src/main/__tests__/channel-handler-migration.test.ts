/**
 * Invariants for the in-progress fold of the two dispatch sites into one typed
 * handler map (`ipc/channel-handlers.ts`).
 *
 * The risk this guards against is specific and has precedent in this repo: a migration
 * that declares a new seam, moves part of the work across, and leaves the old
 * implementation in place — so the codebase ends up with *more* dispatch sites than it
 * started with. These tests make that state fail the build.
 *
 * The other half of the completion criterion is in the type system: change
 * `Partial<ChannelHandlerMap>` to `ChannelHandlerMap` in channel-handlers.ts and the
 * compiler lists every channel still outstanding.
 */
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHANNEL_REGISTRY, REMOTE_CHANNELS } from '@polycode/shared'

const mainDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const handlersSource = readFileSync(join(mainDir, 'ipc', 'handlers.ts'), 'utf8')
const rpcSource = readFileSync(join(mainDir, 'control', 'control-rpc.ts'), 'utf8')
const handlerMapSource = readFileSync(join(mainDir, 'ipc', 'channel-handlers.ts'), 'utf8')

const migratedChannels = [...handlerMapSource.matchAll(/^ {2}'([^']+)':/gm)].map((m) => m[1])

describe('channel handler map migration', () => {
  test('the map is not empty and every entry is a real channel', () => {
    expect(migratedChannels.length).toBeGreaterThan(0)
    const unknown = migratedChannels.filter((channel) => !(channel in CHANNEL_REGISTRY))
    expect(unknown).toEqual([])
  })

  test('a folded channel has no leftover registration in handlers.ts', () => {
    const stragglers = migratedChannels.filter((channel) =>
      new RegExp(`\\bproxyable\\(\\s*'${channel}'`).test(handlersSource) ||
      new RegExp(`\\bipcMain\\.handle\\(\\s*'${channel}'`).test(handlersSource),
    )
    expect(stragglers).toEqual([])
  })

  test('a folded channel has no leftover case in control-rpc.ts', () => {
    const stragglers = migratedChannels.filter((channel) =>
      new RegExp(`\\bcase\\s+'${channel}'\\s*:`).test(rpcSource),
    )
    expect(stragglers).toEqual([])
  })

  test('the ipcMain adapter registers folded channels generically', () => {
    // If this loop is removed, every folded channel silently stops being reachable
    // from the renderer — with no other assertion catching it.
    expect(handlersSource).toMatch(/for \(const channel of MIGRATED_CHANNELS\)/)
    expect(handlersSource).toContain("origin: 'local'")
  })

  test('the control-RPC adapter derives reachability from the registry', () => {
    // The guard must be `isRemoteChannel`, not "does the switch have a case". Otherwise
    // folding a local-only channel would quietly expose it over the network.
    expect(rpcSource).toMatch(/isMigratedChannel\(channel\) && isRemoteChannel\(channel\)/)
    expect(rpcSource).toContain("origin: 'remote'")
  })

  test('no local-only channel is reachable through the folded path', () => {
    const remote = new Set<string>(REMOTE_CHANNELS)
    const localOnlyButFolded = migratedChannels.filter((channel) => !remote.has(channel))
    // Folding a local-only channel is fine — the adapter guard handles it — but it must
    // be a deliberate act, so record which ones are in that state.
    expect(localOnlyButFolded).toEqual([])
  })

  test('reports migration progress', () => {
    const total = Object.keys(CHANNEL_REGISTRY).length
    const remaining = total - migratedChannels.length
    // Not an assertion about the target, just a visible counter in the test output.
    expect(migratedChannels.length + remaining).toBe(total)
    console.info(
      `[channel migration] ${migratedChannels.length}/${total} channels folded, ${remaining} remaining`,
    )
  })
})
