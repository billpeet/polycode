/**
 * Invariants for the completed fold of the dispatch sites into one typed handler map
 * (`ipc/channel-handlers.ts`).
 *
 * The risk these guard against is specific and has precedent in this repo: a migration
 * that declares a new seam, moves part of the work across, and leaves the old
 * implementation in place — so the codebase ends up with *more* dispatch sites than it
 * started with. These tests make that state fail the build.
 *
 * The migration is finished, so the assertions here now describe a *finished* state rather
 * than a shrinking one: every channel is in the map, and none of the four sites they
 * came from — `ipc/handlers.ts`, `control/control-rpc.ts`, and latterly `remote/client.ts`
 * — registers or dispatches a channel of its own any more.
 *
 * The other half is in the type system, and it is no longer a criterion to be flipped: the
 * map is checked against `ChannelHandlerMap`, not `Partial<>`, so a channel added to
 * `CHANNEL_REGISTRY` without an implementation fails the build. `channel-handlers.ts` also
 * carries the type-level proof that `CtxFor` still discriminates — it has to live in a
 * source file, because `tsconfig.node.json` excludes every `__tests__` directory and vitest
 * transpiles without type checking, so a type assertion here would be checked by nothing.
 */
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHANNEL_REGISTRY, LOCAL_CHANNELS, REMOTE_CHANNELS } from '@polycode/shared'

const mainDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const handlersSource = readFileSync(join(mainDir, 'ipc', 'handlers.ts'), 'utf8')
const rpcSource = readFileSync(join(mainDir, 'control', 'control-rpc.ts'), 'utf8')
const handlerMapSource = readFileSync(join(mainDir, 'ipc', 'channel-handlers.ts'), 'utf8')
const clientSource = readFileSync(join(mainDir, 'remote', 'client.ts'), 'utf8')

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
    // Folding a local-only channel is fine — control-rpc.ts's `isRemoteChannel` guard keeps
    // it off the network — but it must be a deliberate act, so record which ones are in
    // that state.
    expect(localOnlyButFolded).toEqual([
      // Routine management is deliberately desktop-only in v1; escalated runs
      // reach mobile through the ordinary thread channels instead.
      'routines:list',
      'routines:create',
      'routines:update',
      'routines:delete',
      'routines:setEnabled',
      'routines:runNow',
      'routines:listRuns',
      'routines:dismissRun',
      'routines:runHasUnshippedWork',
      'attachments:getFileInfo',
      'attachments:saveFromPath',
      'shell:copyPath',
      'shell:openInExplorer',
      'shell:openInVsCode',
      'shell:revealInExplorer',
      'shell:openInTerminal',
      'window:minimize',
      'window:maximize',
      'window:close',
      'window:is-maximized',
      'app:getVersion',
      'app:open-logs-folder',
      'update:check',
      'update:apply',
      'update:get-state',
      'dialog:open-directory',
      'dialog:open-files',
      'settings:get',
      'settings:set',
      'webhook:getConfig',
      'webhook:setConfig',
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

  test('remote/client.ts registers no channels at all', () => {
    // It was the fourth registration site, and the last one to empty: the nine `remote:*`
    // channels it held were folded once it became clear the `RemoteControlClient` *instance*
    // could arrive through `LocalHandlerContext` and its *type* through an `import type`.
    // This is the assertion that used to enumerate those nine; re-pointed at the finished
    // state rather than deleted, because "a channel is registered somewhere other than the
    // MIGRATED_CHANNELS loop" is exactly the state the whole migration existed to remove.
    expect([...clientSource.matchAll(/\bipcMain\.handle\(\s*'([^']+)'/g)]).toEqual([])
    // Stronger, and the visible consequence: the file no longer reaches Electron's ipcMain
    // at all. It takes a window, it does not talk to the renderer's dispatcher.
    expect(clientSource).toMatch(/^import \{ BrowserWindow \} from 'electron'$/m)
  })

  test('the client type reaches the map without a runtime import edge', () => {
    // The one silent-failure mode of the whole approach. `import type` is erased, so it
    // creates no runtime edge; changing this single word to a value import would reintroduce
    // the cycle the nine were left unfolded for, and *nothing else in the suite would
    // notice* — the dispatch harness mocks `../remote/client` away, so it cannot see it.
    expect(handlerMapSource).toMatch(
      /^import type \{ RemoteControlClient \} from '\.\.\/remote\/client'$/m,
    )
    // Module-scoped, not name-scoped. Forbidding only a value import *of that identifier*
    // let a value import of any OTHER name from the same module slip through — e.g. adding
    // `import { registerRemoteControlIpcHandlers } from '../remote/client'` alongside, which
    // reintroduces the runtime edge just as effectively.
    expect(handlerMapSource).not.toMatch(/^import (?!type )[^\n]*'\.\.\/remote\/client'/m)

    // The other half: the cycle edge is also gone at its source. `shouldProxy` used to read
    // `CONTROL_RPC_CHANNELS` out of control-rpc.ts — the same set as `isRemoteChannel`, but
    // via the module that imports the handler map — and the two writing channels pulled in
    // remote/server.ts, which imports control-rpc.ts too. Neither import remains, so the
    // `import type` above is belt-and-braces rather than the sole defence.
    // Matched against import statements, not against any mention: `shouldProxy` documents
    // why it does not read `CONTROL_RPC_CHANNELS`, and that comment names the module.
    expect(clientSource).toContain('isRemoteChannel(channel)')
    expect(clientSource).not.toMatch(/^import .*'\.\.\/control\/control-rpc'/m)
    expect(clientSource).not.toMatch(/^import .*'\.\/server'/m)
  })

  test('the handler map is total, not partial', () => {
    // The completion criterion, made permanent. Through the migration this was
    // `Partial<ChannelHandlerMap>` and the criterion was "drop the Partial and read the
    // errors". It is dropped: adding a channel to CHANNEL_REGISTRY without an implementation
    // is now a build failure rather than something a later round would notice.
    expect(handlerMapSource).toContain('} satisfies ChannelHandlerMap')
    expect(handlerMapSource).not.toContain('Partial<ChannelHandlerMap>')
  })

  test('the type-level proof that CtxFor discriminates is still in place', () => {
    // It cannot be asserted from here — `tsconfig.node.json` excludes every `__tests__` dir
    // and vitest does not type-check — so this only pins that they have not been deleted from
    // the file `pnpm typecheck` does cover.
    //
    // All FOUR, not a subset. Each catches something the others do not, and the two that
    // were originally left out are the ones that matter most:
    // `_RemoteOnlyChannelCannotReachTheClient` is the only one that fails if `CtxFor` is
    // re-keyed on `RemoteChannel & LocalChannel`, and
    // `_HandlerContextHasNoLocalCapabilities` is the only one that fails if the capabilities
    // are declared optional on `HandlerContext` — both verified by mutation.
    for (const assertion of [
      '_LocalOnlyChannelReachesTheClient',
      '_DualPathChannelCannotReachTheClient',
      '_RemoteOnlyChannelCannotReachTheClient',
      '_HandlerContextHasNoLocalCapabilities',
    ]) {
      expect(handlerMapSource, assertion).toContain(assertion)
    }
  })

  test('no remote-only channel is reachable through the folded path', () => {
    const local = new Set<string>(LOCAL_CHANNELS)
    const remoteOnlyButFolded = migratedChannels.filter((channel) => !local.has(channel))
    expect(remoteOnlyButFolded).toEqual(['attachments:readDataUrl', 'plans:getForThread'])
    // The mirror image of the test above, and the half that had no assertion. The
    // MIGRATED_CHANNELS loop calls `ipcMain.handle` for every channel it is given, so
    // without this guard folding a `local: false` channel would register it in the renderer's
    // reach. The preload allowlist would still refuse it, but that is the *other* layer of
    // the same trust boundary: `local: false` is supposed to mean "no handler exists".
    expect(handlersSource).toContain('if (!isLocalChannel(channel)) continue')
  })

  test('every channel in the registry is folded, and each exactly once', () => {
    const total = Object.keys(CHANNEL_REGISTRY).length
    // This was a bare progress counter while the fold was in flight. It is an assertion now:
    // the map is complete, so the count is the invariant rather than the report. `satisfies
    // ChannelHandlerMap` catches a *missing* implementation at compile time; this catches the
    // scrape and the registry disagreeing — a channel key at the wrong indent, or a duplicate
    // key, which the compiler is happy to let the later one win.
    expect(new Set(migratedChannels).size).toBe(migratedChannels.length)
    expect([...migratedChannels].sort()).toEqual(Object.keys(CHANNEL_REGISTRY).sort())
    console.info(`[channel migration] complete — ${migratedChannels.length}/${total} channels folded`)
  })
})
