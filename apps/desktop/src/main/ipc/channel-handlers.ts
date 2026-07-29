/**
 * The single implementation of every channel, typed against `ChannelContract`.
 *
 * The contract is the interface. Until now two implementations sat behind it —
 * `ipc/handlers.ts` for Electron IPC and `control/control-rpc.ts` for remote control —
 * and neither was checked against it: `proxyable` took `channel: string`, and
 * `handleControlRpc` took `channel: string, args: unknown[]` and cast its way out.
 *
 * This module is the one implementation. Both transports become thin adapters over it.
 *
 * ## What the registry does and does not cover
 *
 * `CHANNEL_REGISTRY` is an inventory of **request/response** channels, not of the whole
 * IPC surface. Fire-and-forget and streaming channels sit outside it by design and have
 * no enumeration anywhere:
 *
 * - `ipcMain.on` channels — `terminal:write`, `terminal:resize` (`ipc/handlers.ts`) and
 *   `log:write` (`main/index.ts`), all invoked from the renderer via `window.api.send`.
 * - Push channels the renderer subscribes to with `window.api.on` — `thread:output:${id}`,
 *   `thread:status:${id}`, `command:*`. These are per-thread and per-command, so they are
 *   not enumerable in a static registry.
 *
 * This is why the preload allowlist gates `invoke` only. Anyone reasoning about
 * "everything the renderer can reach" needs the registry *and* those channels.
 *
 * ## Why this lives in the desktop app and not in `packages/shared`
 *
 * `packages/shared` is dependency-free raw TS with no build step. Handler
 * implementations touch better-sqlite3, Electron and `git.ts`, so they cannot live
 * there. The *types* stay in shared; the map is desktop-only.
 *
 * ## Migration state
 *
 * `channelHandlers` is checked against `Partial<ChannelHandlerMap>`, so every entry
 * present is fully type-checked — arguments and result — against the contract, while
 * channels not yet moved keep their existing implementation.
 *
 * **The completion criterion is mechanical:** change `Partial<ChannelHandlerMap>` below
 * to `ChannelHandlerMap`. The build then lists every channel still missing. When it
 * compiles, the migration is done and the two legacy dispatch sites are empty.
 *
 * `channel-handler-migration.test.ts` enforces the other half: a channel handled here
 * must have no legacy registration left, so a third dispatch site cannot exist.
 */
import { existsSync } from 'fs'
import type { BrowserWindow } from 'electron'
import type { Channel, ChannelArgs, ChannelResult } from '@polycode/shared'
import {
  archiveProject,
  checkoutLocation,
  createCommand,
  createLocation,
  createProject,
  deleteCommand,
  deleteLocation,
  deleteProject,
  listArchivedProjects,
  listCommands,
  listLocations,
  listProjects,
  returnLocationToPool,
  unarchiveProject,
  updateCommand,
  updateLocation,
  updateProject,
} from '../db/queries'
import { sessionManager } from '../session/manager'
import { commandManager } from '../commands/manager'
import {
  cloneLocation,
  createFullProject,
  createLocalWorktree,
  removeWorktreeLocation,
  suggestUniquePath,
} from '../project-admin'
import { projectFaviconDataUrl } from '../project-favicon'

/**
 * What a handler is given besides its arguments.
 *
 * `origin` is the answer to the `originAware` registry flag, which until now was
 * declared on `threads:send` and read by nobody. A handler that behaves differently
 * per transport branches on this rather than existing twice.
 */
export interface HandlerContext {
  window: BrowserWindow
  origin: 'local' | 'remote'
}

export type ChannelHandler<C extends Channel> = (
  ctx: HandlerContext,
  ...args: ChannelArgs<C>
) => ChannelResult<C> | Promise<ChannelResult<C>>

export type ChannelHandlerMap = { [C in Channel]: ChannelHandler<C> }

/**
 * Handlers that have been folded out of the two legacy dispatch sites.
 *
 * Handlers that need neither context nor arguments simply declare fewer parameters —
 * a uniform `ctx` first parameter costs nothing at the call sites that ignore it.
 *
 * **Always pass the callee's result through** — expression body, or an explicit `return`
 * in a braced one. Several of these call functions currently declared `: void`, so
 * discarding the result looks harmless and the contract's `void` means neither
 * `satisfies` nor `tsc` would object. But if such a callee later becomes `async`, a
 * discarding body floats its promise: the transport replies before the work completes and
 * rejections vanish. Returning it costs nothing today and removes that trap.
 */
export const channelHandlers = {
  'projects:list': () => listProjects(),

  'projects:listArchived': () => listArchivedProjects(),

  'projects:favicon': (_ctx, projectId) => {
    const location = listLocations(projectId).find((item) => item.connection_type === 'local')
    return location ? projectFaviconDataUrl(location.path) : null
  },

  'projects:create': (_ctx, name, gitUrl, allowMainBranchCommits) =>
    createProject(name, gitUrl, allowMainBranchCommits ?? true),

  // Atomically provision a brand-new project *and* its first local location in one shot.
  // All filesystem/git work (mkdir + init, clone, remote detection) happens BEFORE any DB
  // rows are written, so a failure never leaves an orphaned project behind.
  'projects:createFull': (_ctx, spec) => createFullProject(spec),

  'projects:update': (_ctx, id, name, gitUrl, allowMainBranchCommits) =>
    updateProject(id, name, gitUrl, allowMainBranchCommits ?? true),

  'projects:delete': (_ctx, id) => {
    sessionManager.stopAll()
    commandManager.stopAll()
    return deleteProject(id)
  },

  'projects:archive': (_ctx, id) => archiveProject(id),

  'projects:unarchive': (_ctx, id) => unarchiveProject(id),

  'locations:list': (_ctx, projectId) => listLocations(projectId),

  'locations:pathExists': (_ctx, path) => existsSync(path),

  // The optional pool/ssh/wsl arguments are passed through raw: db/queries.ts coalesces
  // every one of them before binding, so a `?? null` here would only be duplication.
  'locations:create': (_ctx, projectId, label, connectionType, locationPath, poolId, ssh, wsl) =>
    createLocation(projectId, label, connectionType, locationPath, poolId, ssh, wsl),

  'locations:update': (_ctx, id, label, connectionType, locationPath, poolId, ssh, wsl) =>
    updateLocation(id, label, connectionType, locationPath, poolId, ssh, wsl),

  'locations:delete': (_ctx, id) => deleteLocation(id),

  'locations:createWorktree': (_ctx, parentLocationId, label) =>
    createLocalWorktree(parentLocationId, label),

  'locations:removeWorktree': (_ctx, id) => removeWorktreeLocation(id),

  'locations:clone': (_ctx, projectId, label, gitUrl, clonePath) =>
    cloneLocation(projectId, label, gitUrl, clonePath),

  'locations:suggestPath': (_ctx, baseDir, repoName) => suggestUniquePath(baseDir, repoName),

  'locations:checkout': (_ctx, id) => checkoutLocation(id),

  'locations:returnToPool': (_ctx, id) => returnLocationToPool(id),

  'commands:list': (_ctx, projectId) => listCommands(projectId),

  // `cwd`/`shell` are passed through raw — db/queries.ts coalesces both with `?? null`
  // before binding and again in the returned object, so a `?? null` here would duplicate.
  //
  // `runOnWorktreeCreate ?? false` is NOT the same kind of redundancy and must stay.
  // Downstream the default is a *parameter default* (`runOnWorktreeCreate = false`), which
  // fires on `undefined` only — `null` sails straight past it and would land verbatim in
  // the returned ProjectCommand's `run_on_worktree_create`, a field typed `boolean`.
  //
  // How `null` could get here: over the remote transport, args are JSON. Note the exact
  // mechanism, because it is easy to state wrongly — an *omitted* trailing argument
  // produces a SHORTER array and still arrives as `undefined`, which is fine. It is an
  // explicitly-`undefined` element that JSON.stringify maps to `null`.
  //
  // Today no caller does that: stores/commands.ts:97,107 already coalesce before invoking,
  // and mobile's allowlist (api/rpc.ts:84-90) excludes create/update entirely. So this is
  // defence in depth against a future caller, not a live bug — and it also preserves both
  // pre-fold paths verbatim, which is reason enough on its own.
  'commands:create': (_ctx, projectId, name, command, cwd, shell, runOnWorktreeCreate) =>
    createCommand(projectId, name, command, cwd, shell, runOnWorktreeCreate ?? false),

  'commands:update': (_ctx, id, name, command, cwd, shell, runOnWorktreeCreate) =>
    updateCommand(id, name, command, cwd, shell, runOnWorktreeCreate ?? false),

  'commands:delete': (_ctx, id) => {
    commandManager.stopAllInstances(id)
    return deleteCommand(id)
  },

  'commands:start': (_ctx, commandId, locationId) => commandManager.start(commandId, locationId),

  'commands:stop': (_ctx, commandId, locationId) => commandManager.stop(commandId, locationId),

  'commands:restart': (_ctx, commandId, locationId) =>
    commandManager.restart(commandId, locationId),

  'commands:getStatus': (_ctx, commandId, locationId) =>
    commandManager.getStatus(commandId, locationId),

  'commands:getLogs': (_ctx, commandId, locationId) =>
    commandManager.getLogs(commandId, locationId),

  'commands:getPid': (_ctx, commandId, locationId) => commandManager.getPid(commandId, locationId),

  'commands:getPorts': (_ctx, commandId, locationId) =>
    commandManager.getPorts(commandId, locationId),
} satisfies Partial<ChannelHandlerMap>

export type MigratedChannel = keyof typeof channelHandlers

export const MIGRATED_CHANNELS = Object.keys(channelHandlers) as MigratedChannel[]

const MIGRATED_CHANNEL_SET: ReadonlySet<string> = new Set<string>(MIGRATED_CHANNELS)

export function isMigratedChannel(channel: string): channel is MigratedChannel {
  return MIGRATED_CHANNEL_SET.has(channel)
}

/**
 * Transport-facing entry point. Both adapters funnel through here.
 *
 * The cast is contained to this one line: callers reach it having already narrowed
 * `channel` with `isMigratedChannel`, and every entry in the map was type-checked
 * against the contract at its definition.
 */
export async function invokeChannelHandler(
  channel: MigratedChannel,
  ctx: HandlerContext,
  args: unknown[],
): Promise<unknown> {
  const handler = channelHandlers[channel] as (ctx: HandlerContext, ...rest: unknown[]) => unknown
  // `async` rather than `Promise.resolve(handler(...))`: the latter evaluates the call
  // outside any try, so a handler that throws *synchronously* would throw synchronously
  // out of this function instead of rejecting. Both current callers sit inside async
  // bodies and absorb it, but a future third caller would not, and the returned type says
  // it cannot happen.
  return handler(ctx, ...args)
}
