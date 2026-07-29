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
  archivedThreadCount,
  archiveProject,
  archiveThread,
  checkoutLocation,
  createCommand,
  createLocation,
  createProject,
  createThread,
  deleteCommand,
  deleteLocation,
  deleteProject,
  deleteThread,
  getLastUsedProviderAndModel,
  getLocationForThread,
  getThreadModifiedFiles,
  listArchivedProjects,
  listArchivedThreads,
  listCommands,
  listLocations,
  listProjects,
  listThreads,
  returnLocationToPool,
  setThreadGitBranchIfUnset,
  threadExists,
  threadHasMessages,
  unarchiveProject,
  unarchiveThread,
  updateCommand,
  updateLocation,
  updateProject,
  updateThreadCodexPersonality,
  updateThreadCodexReasoningSummary,
  updateThreadCursorContext,
  updateThreadCursorThinking,
  updateThreadModel,
  updateThreadName,
  updateThreadPermissionMode,
  updateThreadProviderAndModel,
  updateThreadReasoningLevel,
  updateThreadStatus,
  updateThreadUnread,
  updateThreadWsl,
  updateThreadYoloMode,
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
import { emitAppEvent } from '../app-events'
import { getCachedGitBranch } from '../git'
import { getThreadLogs } from '../thread-logger'
import {
  getEffectiveWorkingDir,
  getLocalPathError,
  getSshConfigForThread,
  getWorkingDirForThread,
  getWslConfigForThread,
} from './thread-context'

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

  // ── Thread session lifecycle and interaction ──────────────────────────────
  //
  // Every channel below reaches the thread's Session, either the live one
  // (`sessionManager.get`, which yields `undefined` after a restart and is why the
  // optional chaining is load-bearing rather than defensive) or one created on demand
  // (`sessionManager.getOrCreate`).
  //
  // The four context lookups are always evaluated in the same order — working dir, then
  // ssh, then wsl — because each hits db/queries and the pre-fold implementations pinned
  // that order on both transports.

  'threads:start': (ctx, threadId) => {
    if (!threadExists(threadId)) return
    const pathError = getLocalPathError(threadId)
    if (pathError) throw new Error(pathError)
    const session = sessionManager.getOrCreate(
      threadId,
      getEffectiveWorkingDir(threadId),
      ctx.window,
      getSshConfigForThread(threadId),
      getWslConfigForThread(threadId),
    )
    if (!session.isRunning()) return session.start()
  },

  // `cleanBackgroundTerminals` is passed through raw. The IPC path used to declare a
  // `= false` parameter default and the control-RPC path declared nothing, but neither
  // could ever matter: both normalise with `=== true` immediately below, which maps
  // `undefined`, `null` and `false` alike to `false`. That is the opposite of the
  // `commands:create` case, where the downstream default was a *parameter* default that
  // `null` sails past — here the normalisation is in the body and absorbs both.
  'threads:stop': (ctx, threadId, cleanBackgroundTerminals) => {
    const session = sessionManager.get(threadId)
    if (session?.isRunning()) return session.stop(cleanBackgroundTerminals === true)
    // No live session (e.g. after a restart) — force-reset the stuck status in the DB and
    // tell the renderer, which would otherwise show a thread that can never finish.
    updateThreadStatus(threadId, 'idle')
    emitAppEvent(ctx.window, `thread:status:${threadId}`, 'idle')
    return emitAppEvent(ctx.window, `thread:pid:${threadId}`, null)
  },

  'threads:reset': (ctx, threadId) => {
    sessionManager.reset(threadId)
    updateThreadStatus(threadId, 'idle')
    emitAppEvent(ctx.window, `thread:status:${threadId}`, 'idle')
    return emitAppEvent(ctx.window, `thread:pid:${threadId}`, null)
  },

  'threads:getPid': (_ctx, threadId) => sessionManager.get(threadId)?.getPid() ?? null,

  /**
   * The one channel whose two pre-fold implementations deliberately differed, and the
   * first real use of `ctx.origin`.
   *
   * A message that arrives over the remote transport was typed on another device, which
   * has already rendered it optimistically. The local renderer has not, so it needs to be
   * told — but *only* it. Sending on `window.webContents` directly rather than through
   * `emitAppEvent` is what keeps the echo off the SSE stream: `emitAppEvent` also
   * publishes to the app event bus, and the originating device would merge that echo back
   * in as a duplicate of the message it is already showing.
   */
  'threads:send': (ctx, threadId, content, options) => {
    if (!threadExists(threadId)) {
      sessionManager.remove(threadId)
      console.warn('[channel-handlers] threads:send for missing thread — ignoring', threadId)
      return
    }
    const pathError = getLocalPathError(threadId)
    if (pathError) throw new Error(pathError)
    const session = sessionManager.getOrCreate(
      threadId,
      getEffectiveWorkingDir(threadId),
      ctx.window,
      getSshConfigForThread(threadId),
      getWslConfigForThread(threadId),
    )
    // Deliberately not returned, unlike every other handler here: the echo and the branch
    // capture below must both run after the message is handed over, so there is nothing
    // left to pass through. Both pre-fold paths discarded it too.
    session.sendMessage(content, options)

    if (ctx.origin === 'remote' && !ctx.window.webContents.isDestroyed()) {
      ctx.window.webContents.send(`thread:output:${threadId}`, {
        type: 'text',
        content,
        metadata: { role: 'user', source: 'remote_client' },
      })
    }

    // Capture the git branch on the first message. Fire-and-forget by design — it must
    // not delay the send, and a non-repo working directory is not an error.
    const location = getLocationForThread(threadId)
    if (location) {
      getCachedGitBranch(location.path, location.ssh, location.wsl)
        .then((branch) => { if (branch) setThreadGitBranchIfUnset(threadId, branch) })
        .catch(() => undefined)
    }
  },

  'threads:approvePlan': (_ctx, threadId) => sessionManager.get(threadId)?.approvePlan(),

  'threads:rejectPlan': (_ctx, threadId) => sessionManager.get(threadId)?.rejectPlan(),

  'threads:getQuestions': (_ctx, threadId) =>
    sessionManager.get(threadId)?.getPendingQuestions() ?? [],

  'threads:answerQuestion': (_ctx, threadId, answers, questionComments, generalComment) =>
    sessionManager.get(threadId)?.answerQuestion(answers, questionComments, generalComment),

  'threads:getPendingPermissions': (_ctx, threadId) =>
    sessionManager.get(threadId)?.getPendingPermissions() ?? [],

  // `requestId` is passed through raw on both of these. An omitted one means "the first
  // pending request", and Session.getTargetPermissionRequest tests it for truthiness, so
  // `undefined` and `null` are already equivalent there — a coalesce would be noise.
  'threads:approvePermissions': (_ctx, threadId, requestId) =>
    sessionManager.get(threadId)?.approvePermissions(requestId),

  'threads:denyPermissions': (_ctx, threadId, requestId) =>
    sessionManager.get(threadId)?.denyPermissions(requestId),

  // Note the missing getLocalPathError check, which threads:start and threads:send both
  // have. Both pre-fold paths agreed on its absence, so it is preserved rather than
  // "fixed" here.
  'threads:executePlanInNewContext': (ctx, threadId) => {
    if (!threadExists(threadId)) return
    const session = sessionManager.getOrCreate(
      threadId,
      getEffectiveWorkingDir(threadId),
      ctx.window,
      getSshConfigForThread(threadId),
      getWslConfigForThread(threadId),
    )
    return session.executePlanInNewContext()
  },

  'threads:backgroundTerminals:list': async (_ctx, threadId) =>
    (await sessionManager.get(threadId)?.listBackgroundTerminals()) ?? [],

  'threads:backgroundTerminals:terminate': async (_ctx, threadId, processId) =>
    (await sessionManager.get(threadId)?.terminateBackgroundTerminal(processId)) ?? false,

  'threads:backgroundTerminals:clean': (_ctx, threadId) =>
    sessionManager.get(threadId)?.cleanBackgroundTerminals(),

  // ── Thread CRUD, archiving and per-thread settings ────────────────────────
  //
  // Twelve of the channels below call `sessionManager.remove(id)` *before* the DB write.
  // That ordering is a convention no type enforces and the reason it matters is one-way:
  // a Session is constructed from the thread row, so a session that outlived the write
  // would keep serving the next message with the old provider/model/reasoning/permission
  // settings until something else happened to evict it. Removing first makes the next
  // message rebuild from the row that was just written.
  //
  // Both pre-fold paths agreed on the whole set and on the ordering, `threads:setUnread`'s
  // deliberate absence included.

  'threads:list': (_ctx, projectId) => listThreads(projectId),

  // The provider/model lookup is load-bearing, not decoration: `createThread` declares
  // `provider = 'claude-code', model = 'claude-opus-4-8'` parameter defaults, so dropping
  // it would still produce a valid-looking thread that had silently stopped inheriting
  // what the project last used.
  'threads:create': (_ctx, projectId, name, locationId) => {
    const { provider, model } = getLastUsedProviderAndModel(projectId)
    return createThread(projectId, name, locationId, provider, model)
  },

  'threads:delete': (_ctx, id) => {
    sessionManager.remove(id)
    return deleteThread(id)
  },

  'threads:archivedCount': (_ctx, projectId) => archivedThreadCount(projectId),

  // `limit`/`offset` are passed through raw, and neither pre-fold path coalesced either.
  // `listArchivedThreads` binds `limit ?? -1, offset ?? 0` *in its own body*, which
  // absorbs `undefined` and `null` alike — the opposite of `commands:create`, where the
  // downstream default is a *parameter* default that an explicit `null` sails past. So a
  // call-site coalesce here would be pure duplication rather than defence in depth.
  'threads:listArchived': (_ctx, projectId, limit, offset) =>
    listArchivedThreads(projectId, limit, offset),

  // The only channel in this batch with a real branch. An archive request for a thread
  // that was never used deletes it outright, and the caller is told which happened so it
  // can word its confirmation correctly. The `'archived' | 'deleted'` literal *is* the
  // contract's result, so — unlike everything else here — neither branch passes its
  // callee's value through; doing so would return a `void`.
  'threads:archive': (_ctx, id) => {
    sessionManager.remove(id)
    if (threadHasMessages(id)) {
      archiveThread(id)
      return 'archived'
    }
    deleteThread(id)
    return 'deleted'
  },

  'threads:unarchive': (_ctx, id) => unarchiveThread(id),

  'threads:updateName': (_ctx, id, name) => updateThreadName(id, name),

  'threads:updateModel': (_ctx, id, model) => {
    sessionManager.remove(id)
    return updateThreadModel(id, model)
  },

  'threads:updateProviderAndModel': (_ctx, id, provider, model) => {
    sessionManager.remove(id)
    return updateThreadProviderAndModel(id, provider, model)
  },

  'threads:updateReasoningLevel': (_ctx, id, reasoningLevel) => {
    sessionManager.remove(id)
    return updateThreadReasoningLevel(id, reasoningLevel)
  },

  'threads:updateCodexPersonality': (_ctx, id, personality) => {
    sessionManager.remove(id)
    return updateThreadCodexPersonality(id, personality)
  },

  'threads:updateCodexReasoningSummary': (_ctx, id, summary) => {
    sessionManager.remove(id)
    return updateThreadCodexReasoningSummary(id, summary)
  },

  // `thinking` is `boolean | null` and `context` is `string | null`: on both of these the
  // null is a *value* ("no override"), not an absent argument, and `false` / `''` are
  // likewise meaningful. Nothing may coalesce or truthiness-test them on the way to the
  // column — they are passed through exactly as received.
  'threads:updateCursorThinking': (_ctx, id, thinking) => {
    sessionManager.remove(id)
    return updateThreadCursorThinking(id, thinking)
  },

  'threads:updateCursorContext': (_ctx, id, context) => {
    sessionManager.remove(id)
    return updateThreadCursorContext(id, context)
  },

  // The odd one out among the setters: read/unread cannot change how the CLI is spawned,
  // so the live session is deliberately left alone. Both pre-fold paths agreed.
  'threads:setUnread': (_ctx, threadId, unread) => updateThreadUnread(threadId, unread),

  'threads:setYolo': (_ctx, threadId, yoloMode) => {
    sessionManager.remove(threadId)
    return updateThreadYoloMode(threadId, yoloMode)
  },

  'threads:setPermissionMode': (_ctx, threadId, permissionMode) => {
    sessionManager.remove(threadId)
    return updateThreadPermissionMode(threadId, permissionMode)
  },

  // Note the ordering, which differs from every other remove-then-write channel above:
  // the message lock is checked *first*, so a refused write does not cost the thread its
  // live session as a side effect. `wslDistro` is written verbatim — a null means "no
  // distro" and goes straight into the column.
  //
  // The two pre-fold paths differed here in form only: control-rpc.ts returned
  // `updateThreadWsl`'s value and ipc/handlers.ts discarded it. The callee is `: void` and
  // the contract's result is `void`, so nothing observable changes either way; the
  // returning form is kept, per the rule above.
  'threads:setWsl': (_ctx, threadId, useWsl, wslDistro) => {
    if (threadHasMessages(threadId)) return // locked after the first message
    sessionManager.remove(threadId)
    return updateThreadWsl(threadId, useWsl, wslDistro)
  },

  // `?? ''` is load-bearing, and is the reason the lookup is not inlined into a template:
  // getThreadModifiedFiles declares `workingDir: string` and joins it as a path, so the
  // null a thread without a location yields must be normalised before it gets there.
  'threads:getModifiedFiles': (_ctx, threadId) =>
    getThreadModifiedFiles(threadId, getWorkingDirForThread(threadId) ?? ''),

  'threads:getLogs': (_ctx, threadId) => getThreadLogs(threadId),
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
