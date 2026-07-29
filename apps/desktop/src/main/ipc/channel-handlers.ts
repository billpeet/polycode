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
// Fire-and-forget GUI launching (VS Code, Explorer, Terminal) — the exception the
// no-restricted-imports rule documents. It is genuinely not "run a command and collect
// output": there is no output to collect and nothing to wait for, so the Runner seam has
// nothing to offer. This exemption used to sit in eslint.config.mjs against
// `ipc/handlers.ts`, which is where `shell:openInTerminal` and `shell:openInVsCode` lived
// before they were folded into the map below; that entry is now stale.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { basename, join } from 'path'
import { pathToFileURL } from 'url'
import { app, clipboard, dialog, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import type { Channel, ChannelArgs, ChannelResult } from '@polycode/shared'
import type { SshConfig, WslConfig } from '../../shared/types'
import {
  archivedThreadCount,
  archiveProject,
  archiveThread,
  checkoutLocation,
  createCommand,
  createLocation,
  createLocationPool,
  createProject,
  createSlashCommand,
  createThread,
  createYouTrackServer,
  deleteCommand,
  deleteLocation,
  deleteLocationPool,
  deleteProject,
  deleteSlashCommand,
  deleteThread,
  deleteYouTrackServer,
  getActiveSession,
  getImportedSessionIds,
  getLastUsedProviderAndModel,
  getLocationForThread,
  getSetting,
  getThreadModifiedFiles,
  importThread,
  listArchivedProjects,
  listArchivedThreads,
  listCommands,
  listLocationPools,
  listLocations,
  listMessages,
  listMessagesBySession,
  listProjects,
  listSessions,
  listSlashCommands,
  listThreads,
  listYouTrackServers,
  returnLocationToPool,
  setSetting,
  setThreadGitBranchIfUnset,
  threadExists,
  threadHasMessages,
  unarchiveProject,
  unarchiveThread,
  updateCommand,
  updateLocation,
  updateLocationPool,
  updateProject,
  updateSlashCommand,
  updateYouTrackServer,
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
import { ptyManager } from '../terminal/manager'
import {
  cleanupThreadAttachments,
  copyAttachmentFromPath,
  getAttachmentDir,
  getFileInfo,
  saveAttachment,
} from '../attachments'
import { checkCliHealth, invalidateCliHealthCache, updateCli } from '../health/checker'
import { listDetectedSkills } from '../skills'
import { listWslDistros, testSshConnection, testWslConnection } from '../host-connection-tests'
import { killByPid, killByPort, runExecFile } from '../process-control'
import { applyUpdate, checkForUpdates, getUpdateState } from '../updater'
import { getLogsDirPath } from '../app-logger'
import { restartWebhookServer } from '../webhook/server'
import type { WebhookConfig } from '../webhook/server'
import { readRemoteServerConfig } from '../remote/config'
import { getPairingInfo } from '../remote/lan'
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
import { createForge } from '../forge'
import { listAllFiles, listDirectory, readFileContent } from '../files'
import { sshListAllFiles, sshListDirectory, sshReadFileContent } from '../ssh'
import { wslListAllFiles, wslListDirectory, wslReadFileContent } from '../wsl'
import { startFileWatch, stopFileWatch } from '../file-watch'
import { listClaudeProjects, listClaudeSessions, parseSessionMessages } from '../claude-history'
import { searchYouTrack, testYouTrackConnection } from '../youtrack'
import { listClaudeAvailableModels } from '../claude-models'
import { listCodexAvailableModels } from '../codex-models'
import { listOpenCodeAvailableModels } from '../opencode-models'
import { listPiAvailableModels } from '../pi-models'
import { listCursorAvailableModels } from '../cursor-models'
import {
  getConfigForPath,
  getEffectiveWorkingDir,
  getLocalPathError,
  getSshConfigForThread,
  getWorkingDirForThread,
  getWslConfigForThread,
  invalidateRepoGitCache,
  windowsPathToWsl,
} from './thread-context'

/**
 * The host context the five `models:*` channels query a CLI in, or `undefined` for "ask
 * the CLI about itself, wherever it happens to live".
 *
 * Shared rather than inlined five times because the three lookups are the whole risk
 * surface of that family — a transposed ssh/wsl or a dropped fallback would still return a
 * plausible model list.
 *
 * `||`, not `??`: `getEffectiveWorkingDir` returns the empty string (not null) for a thread
 * whose location row has gone away, and an empty cwd must fall through to the location
 * lookup rather than be spawned in. Both pre-fold paths had the `||`.
 *
 * The `threadId && threadExists(threadId)` test is truthiness on both pre-fold paths, so
 * `undefined`, `null` and `''` all skip the DB round-trip alike.
 */
function modelQueryOptions(threadId?: string | null):
  | { cwd: string | null; ssh: SshConfig | null; wsl: WslConfig | null }
  | undefined {
  if (!threadId || !threadExists(threadId)) return undefined
  return {
    cwd: getEffectiveWorkingDir(threadId) || getWorkingDirForThread(threadId),
    ssh: getSshConfigForThread(threadId),
    wsl: getWslConfigForThread(threadId),
  }
}

/**
 * The `data:` URL for a file on *this* machine, typed by its extension.
 *
 * Exported because `attachments:saveFromPath` needs the same value on two paths that
 * cannot share a call: the handler below, and the remote-upload hop in `ipc/handlers.ts`,
 * which has to produce the URL *before* it knows whether a remote host is active. Keeping
 * one definition is the only thing stopping the two mime tables from drifting.
 *
 * The table stays inside the function body, exactly as it was in ipc/handlers.ts. At module
 * scope its keys would sit at the same two-space indent the migration tests use to scrape
 * channel names out of this file, and `'.png'` would be reported as an unknown channel.
 */
export function filePathToDataUrl(filePath: string): string {
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
  }
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  return `data:${mimeTypes[ext] || 'application/octet-stream'};base64,${readFileSync(filePath).toString('base64')}`
}

/**
 * The four VS Code helpers and the UNC translator below moved here verbatim from
 * `ipc/handlers.ts`, where they were private to the module.
 *
 * They have exactly one caller each, all of them in the map — `shell:openInVsCode` and
 * `shell:revealInExplorer`. `handlers.ts` cannot export them, because it already imports
 * this module and the dependency would become a cycle; a new module would give
 * single-consumer logic a third home. So they live beside their callers.
 */

async function commandExists(cmd: string): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const sysRoot = process.env.SystemRoot ?? 'C:\\Windows'
      const whereExe = `${sysRoot}\\System32\\where.exe`
      await runExecFile(whereExe, [cmd])
      return true
    }
    await runExecFile('which', [cmd])
    return true
  } catch {
    return false
  }
}

function encodeUriPath(path: string): string {
  return path
    .split('/')
    .map((segment, index) => (index === 0 && segment === '' ? '' : encodeURIComponent(segment)))
    .join('/')
}

function getVsCodeFolderUri(dirPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): string {
  if (wsl) {
    const wslPath = /^[A-Za-z]:[/\\]/.test(dirPath) ? windowsPathToWsl(dirPath) : dirPath
    return `vscode-remote://wsl+${encodeURIComponent(wsl.distro)}${encodeUriPath(wslPath)}`
  }
  if (ssh) {
    const remotePath = dirPath.replace(/\\/g, '/')
    return `vscode-remote://ssh-remote+${encodeURIComponent(ssh.host)}${encodeUriPath(remotePath.startsWith('/') ? remotePath : `/${remotePath}`)}`
  }
  return pathToFileURL(dirPath).toString()
}

async function openFolderInVsCode(dirPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null): Promise<void> {
  const folderUri = getVsCodeFolderUri(dirPath, ssh, wsl)
  const candidates = process.platform === 'win32' ? ['code.cmd', 'code'] : ['code']

  for (const candidate of candidates) {
    if (!(await commandExists(candidate))) continue
    spawn(candidate, ['--folder-uri', folderUri], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref()
    return
  }

  await shell.openExternal(folderUri)
}

/**
 * Convert a WSL-native path to a Windows UNC path so Explorer can open it.
 * e.g. /home/foo/bar in distro "Ubuntu"  →  \\wsl$\Ubuntu\home\foo\bar
 *
 * Handles /mnt/c-style paths specially: /mnt/c/Users/foo → C:\Users\foo
 * so we use the real Windows path rather than going through the WSL filesystem.
 */
function wslPathToUnc(wslPath: string, distro: string): string {
  // /mnt/<drive>/... is a mounted Windows drive — convert back to a native Windows path.
  const mntMatch = wslPath.match(/^\/mnt\/([A-Za-z])(\/.*)?$/)
  if (mntMatch) {
    const drive = mntMatch[1].toUpperCase()
    const rest = (mntMatch[2] ?? '').replace(/\//g, '\\')
    return `${drive}:${rest || '\\'}`
  }
  const rel = wslPath.replace(/\//g, '\\').replace(/^\\+/, '')
  return `\\\\wsl$\\${distro}\\${rel}`
}

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

  // ── Location pools ────────────────────────────────────────────────────────

  'location-pools:list': (_ctx, projectId) => listLocationPools(projectId),

  'location-pools:create': (_ctx, projectId, name) => createLocationPool(projectId, name),

  'location-pools:update': (_ctx, id, name) => updateLocationPool(id, name),

  'location-pools:delete': (_ctx, id) => deleteLocationPool(id),

  // ── Forge: provider-neutral pull requests ─────────────────────────────────
  //
  // All six resolve the repo's host config from repo_locations and hand it to
  // `createForge`, which is what selects the GitHub or Azure DevOps adapter — so the
  // lookup is not decoration, it is how a PR listed over SSH reaches the right API.

  'forge:pr:list': async (_ctx, repoPath) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return (await createForge(repoPath, ssh, wsl)).listPullRequests()
  },

  'forge:pr:current': async (_ctx, repoPath, branch) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return (await createForge(repoPath, ssh, wsl)).getCurrentBranchPullRequest(branch)
  },

  'forge:pr:create': async (_ctx, repoPath, payload) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return (await createForge(repoPath, ssh, wsl)).createPullRequest(payload)
  },

  // The only one of the six that changes the working tree, so it is also the only one that
  // invalidates the git cache — and the invalidation must follow the await, not race it.
  'forge:pr:checkout': async (_ctx, repoPath, prId) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    const result = await (await createForge(repoPath, ssh, wsl)).checkoutPullRequest(prId)
    invalidateRepoGitCache(repoPath)
    return result
  },

  'forge:pr:webUrl': async (_ctx, repoPath) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return (await createForge(repoPath, ssh, wsl)).getPullRequestsWebUrl()
  },

  'forge:repo:webUrl': async (_ctx, repoPath) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return (await createForge(repoPath, ssh, wsl)).getRepoWebUrl()
  },

  // ── Files ─────────────────────────────────────────────────────────────────
  //
  // The only family here that branches on *where the path lives*. Each of the three read
  // channels has a local, an SSH and a WSL backend, and `ssh` is tested first, so a
  // location carrying both configs is served over SSH. Both pre-fold paths agreed on the
  // order; picking the wrong backend returns a plausible-looking answer rather than an
  // error, which is why all three branches are pinned in the characterisation tests.

  'files:list': (_ctx, dirPath) => {
    const { ssh, wsl } = getConfigForPath(dirPath)
    if (ssh) return sshListDirectory(ssh, dirPath)
    if (wsl) return wslListDirectory(wsl, dirPath)
    return listDirectory(dirPath)
  },

  'files:read': (_ctx, filePath) => {
    const { ssh, wsl } = getConfigForPath(filePath)
    if (ssh) return sshReadFileContent(ssh, filePath)
    if (wsl) return wslReadFileContent(wsl, filePath)
    return readFileContent(filePath)
  },

  'files:searchList': (_ctx, rootPath) => {
    const { ssh, wsl } = getConfigForPath(rootPath)
    if (ssh) return sshListAllFiles(ssh, rootPath)
    if (wsl) return wslListAllFiles(wsl, rootPath)
    return listAllFiles(rootPath)
  },

  // fs.watch is local-only, so a remotely-hosted path reports "not watching" rather than
  // failing — the renderer falls back to polling. `ctx.window` is the watcher's event
  // target: the IPC path closed over the window, the control-RPC path took it as a
  // parameter, and both resolved to the same one.
  'files:watchStart': (ctx, filePath) => {
    const { ssh, wsl } = getConfigForPath(filePath)
    if (ssh || wsl) return false
    return startFileWatch(ctx.window, filePath)
  },

  // Note the absence of a getConfigForPath call, unlike watchStart: stopping is keyed on
  // the path alone, and a path that was never watched is a no-op downstream.
  'files:watchStop': (_ctx, filePath) => stopFileWatch(filePath),

  // ── Claude Code history import ────────────────────────────────────────────

  'claude-history:listProjects': () => listClaudeProjects(),

  'claude-history:listSessions': (_ctx, encodedPath) => listClaudeSessions(encodedPath),

  'claude-history:importedIds': (_ctx, projectId) => getImportedSessionIds(projectId),

  // Two things to keep straight, both of which the two pre-fold paths already agreed on:
  // the parsed messages are reshaped (`timestamp` becomes `created_at`, everything else
  // passes through), and the argument order is NOT the channel's — `importThread` takes
  // (projectId, locationId, name, claudeSessionId, messages), so `name` and the file path
  // are not in the slots their positions here suggest.
  'claude-history:import': (_ctx, projectId, locationId, sessionFilePath, sessionId, name) => {
    const importedMessages = parseSessionMessages(sessionFilePath).map((message) => ({
      role: message.role,
      content: message.content,
      metadata: message.metadata,
      created_at: message.timestamp,
    }))
    return importThread(projectId, locationId, name, sessionId, importedMessages)
  },

  // ── YouTrack ──────────────────────────────────────────────────────────────

  // Deliberately serves the stored token, remote transport included: the settings UI needs
  // it to populate the edit form and the mention UI needs it to issue authenticated
  // searches, and both pre-fold paths said so explicitly. Redacting it here would break
  // the mobile client silently.
  'youtrack:servers:list': () => listYouTrackServers(),

  'youtrack:servers:create': (_ctx, name, url, token) => createYouTrackServer(name, url, token),

  'youtrack:servers:update': (_ctx, id, name, url, token) =>
    updateYouTrackServer(id, name, url, token),

  'youtrack:servers:delete': (_ctx, id) => deleteYouTrackServer(id),

  'youtrack:test': (_ctx, url, token) => testYouTrackConnection(url, token),

  'youtrack:search': (_ctx, url, token, query) => searchYouTrack(url, token, query),

  // ── Slash commands ────────────────────────────────────────────────────────

  // `kind: 'command'` is the whole transform: the renderer merges these with detected
  // skills (`skills:list`, still unfolded) onto one palette and branches on the tag.
  //
  // `projectId` is passed through raw. listSlashCommands branches on `if (projectId)` —
  // plain truthiness in its own body — so `undefined`, `null` and `''` are already
  // equivalent there and a call-site coalesce would be pure noise.
  'slash-commands:list': (_ctx, projectId) =>
    listSlashCommands(projectId).map((command) => ({ ...command, kind: 'command' as const })),

  'slash-commands:create': (_ctx, projectId, name, description, prompt) =>
    createSlashCommand(projectId, name, description, prompt),

  'slash-commands:update': (_ctx, id, name, description, prompt) =>
    updateSlashCommand(id, name, description, prompt),

  'slash-commands:delete': (_ctx, id) => deleteSlashCommand(id),

  // ── Available models per provider ─────────────────────────────────────────
  //
  // Five channels over one options builder — see `modelQueryOptions` for why the `||` and
  // the truthiness test are load-bearing. `undefined` is passed explicitly rather than the
  // argument being omitted; the callees all declare `options … = {}`, a parameter default
  // that fires identically either way. (ipc/handlers.ts wrote the zero-argument form and
  // control-rpc.ts the explicit-`undefined` form; this is the one place the two pre-fold
  // implementations were spelled differently.)

  'models:claudeAvailable': (_ctx, threadId) => listClaudeAvailableModels(modelQueryOptions(threadId)),

  'models:codexAvailable': (_ctx, threadId) => listCodexAvailableModels(modelQueryOptions(threadId)),

  'models:opencodeAvailable': (_ctx, threadId) =>
    listOpenCodeAvailableModels(modelQueryOptions(threadId)),

  'models:piAvailable': (_ctx, threadId) => listPiAvailableModels(modelQueryOptions(threadId)),

  'models:cursorAvailable': (_ctx, threadId) =>
    listCursorAvailableModels(modelQueryOptions(threadId)),

  // ── Sessions and messages ─────────────────────────────────────────────────

  'sessions:list': (_ctx, threadId) => listSessions(threadId),

  'sessions:getActive': (_ctx, threadId) => getActiveSession(threadId),

  // The one channel of the five that reaches the live Session rather than the DB: changing
  // which session is active has to reconfigure the running CLI, so it takes the same
  // getOrCreate path threads:start does, with the same (cwd, window, ssh, wsl) ordering.
  //
  // Note the absence of a getLocalPathError check, which threads:start and threads:send
  // both have. The pre-fold paths agreed on its absence, so it is preserved rather than
  // "fixed" here.
  'sessions:switch': (ctx, threadId, sessionId) => {
    if (!threadExists(threadId)) return
    const session = sessionManager.getOrCreate(
      threadId,
      getEffectiveWorkingDir(threadId),
      ctx.window,
      getSshConfigForThread(threadId),
      getWslConfigForThread(threadId),
    )
    return session.switchSession(sessionId)
  },

  'messages:list': (_ctx, threadId) => listMessages(threadId),

  'messages:listBySession': (_ctx, sessionId) => listMessagesBySession(sessionId),

  // ── SSH / WSL connection tests ────────────────────────────────────────────

  'ssh:test': (_ctx, ssh, remotePath) => testSshConnection(ssh, remotePath),

  'wsl:test': (_ctx, wsl, wslPath) => testWslConnection(wsl, wslPath),

  'wsl:list-distros': () => listWslDistros(),

  // ── CLI health and updates ────────────────────────────────────────────────

  'cli:health': (_ctx, provider, connectionType, ssh, wsl) =>
    checkCliHealth(provider, connectionType, ssh, wsl),

  // The only one of the pair that changes anything, so the only one that busts the cache —
  // and the invalidation must follow the await rather than race it, or a health read
  // landing mid-install would repopulate the cache with the pre-update version and the
  // renderer would keep offering the update.
  'cli:update': async (_ctx, provider, connectionType, ssh, wsl) => {
    const result = await updateCli(provider, connectionType, ssh, wsl)
    invalidateCliHealthCache(provider, connectionType, ssh, wsl)
    return result
  },

  // ── Process control ───────────────────────────────────────────────────────

  /**
   * Answers `{ ok, error }` rather than throwing: the renderer shows the message beside a
   * still-listed process, so a rejected invoke would be the wrong shape. The `{ ok: false }`
   * strings are therefore part of the contract, `'Invalid number'` included.
   *
   * `threadId` is passed to a plain truthiness test — an omitted one means "not a thread's
   * process", so `undefined`, `null` and `''` all mean "no WSL config" and skip the lookup.
   *
   * `Number.parseInt`/`Number.isNaN` rather than the globals: the two pre-fold paths were
   * spelled differently and the pair is interchangeable here, because `Number.parseInt`
   * *is* the global `parseInt` and its result is always a number, so `isNaN`'s coercion
   * never gets anything to coerce.
   */
  'process:kill': async (_ctx, target, type, threadId) => {
    try {
      const parsed = Number.parseInt(target, 10)
      if (Number.isNaN(parsed)) return { ok: false, error: 'Invalid number' }
      const wsl = threadId ? getWslConfigForThread(threadId) : null
      if (type === 'pid') {
        await killByPid(parsed, wsl)
      } else {
        await killByPort(parsed, wsl)
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  // ── Skills ────────────────────────────────────────────────────────────────

  // Detected skills are reshaped onto the SlashCommand row so the renderer can merge them
  // with `slash-commands:list` onto one palette; `kind: 'skill'` is the tag it branches on,
  // mirroring `kind: 'command'` there. The array index becomes `sort_order`, and the two
  // timestamps are empty because a skill is a file on disk rather than a row.
  //
  // `cwd ?? null` is redundant — listDetectedSkills branches on `if (cwd)` in its own body,
  // so `undefined`, `null` and `''` are already equivalent there — but both pre-fold paths
  // wrote it and the difference is visible in the call, so it is preserved rather than
  // tidied away.
  'skills:list': (_ctx, provider, cwd) =>
    listDetectedSkills(provider, cwd ?? null).map((skill, index) => ({
      id: skill.id,
      project_id: skill.scope === 'project' ? 'project' : null,
      name: skill.name,
      description: skill.description,
      prompt: skill.invocation,
      sort_order: index,
      created_at: '',
      updated_at: '',
      kind: 'skill' as const,
      scope: skill.scope,
      harness: skill.harness,
      path: skill.path,
      invocation: skill.invocation,
    })),

  // ── Terminal (PTY) ────────────────────────────────────────────────────────
  //
  // `terminal:write` and `terminal:resize` are ALSO registered as `ipcMain.on`
  // fire-and-forget listeners in ipc/handlers.ts, and that pair is the one the renderer
  // actually uses (`window.api.send`, Terminal.tsx and stores/terminal.ts). Those listeners
  // are a different transport shape, outside this registry's remit — see the file header —
  // and are deliberately left where they are. The entries below are the request/response
  // registrations the registry and the contract describe.

  'terminal:spawn': (_ctx, threadId, cols, rows) => {
    const location = getLocationForThread(threadId)
    if (!location) throw new Error('No location associated with this thread')
    const terminalId = `term-${threadId}-${Date.now()}`
    ptyManager.spawn(
      terminalId,
      threadId,
      // The `|| location.path` fallback cannot fire: getEffectiveWorkingDir returns '' only
      // for a thread with no location row, which the guard above has already rejected using
      // the same lookup. Preserved because both pre-fold paths had it and it costs nothing.
      getEffectiveWorkingDir(threadId) || location.path,
      // The connection type comes from the location row, not from which host config
      // happens to be set — that is what decides whether a PTY is local, ssh or wsl.
      location.connection_type,
      cols,
      rows,
      getSshConfigForThread(threadId),
      getWslConfigForThread(threadId),
    )
    // Not the callee's value, unlike the rule below: `spawn` is `: void` and the minted id
    // *is* the contract's result — the renderer needs it to address the terminal.
    return terminalId
  },

  'terminal:write': (_ctx, terminalId, data) => ptyManager.write(terminalId, data),

  'terminal:resize': (_ctx, terminalId, cols, rows) => ptyManager.resize(terminalId, cols, rows),

  'terminal:kill': (_ctx, terminalId) => ptyManager.kill(terminalId),

  'terminal:getBuffer': (_ctx, terminalId) => ptyManager.getBuffer(terminalId),

  // ── Attachments ───────────────────────────────────────────────────────────
  //
  // The one family that spans all three reachability shapes: save/cleanup are local *and*
  // remote, getFileInfo/saveFromPath are local-only, readDataUrl is remote-only. They sit
  // together because both adapters derive reachability from CHANNEL_REGISTRY rather than
  // from which dispatch site happens to carry a registration.

  'attachments:save': (_ctx, dataUrl, filename, threadId) =>
    saveAttachment(dataUrl, filename, threadId),

  // The two pre-fold paths differed here in form only, exactly like `threads:setWsl`:
  // ipc/handlers.ts returned `cleanupThreadAttachments`'s value and control-rpc.ts
  // discarded it and returned undefined. The callee is `: void` and so is the contract's
  // result, so nothing observable changes; the returning form is kept, per the rule above.
  'attachments:cleanup': (_ctx, threadId) => cleanupThreadAttachments(threadId),

  /**
   * Remote-only. Remote clients cannot use the Electron-only `attachment://` protocol, so
   * a saved attachment is served back inline as a data URL.
   *
   * Both path segments come off the wire, hence `basename` on each: `..` in either would
   * otherwise escape the attachment directory and read arbitrary files off the host. The
   * 15 MB cap matches the RPC body limit, so an oversized file refuses rather than
   * producing a response the transport will drop anyway.
   *
   * `getAttachmentDir()` is deliberately outside the try — it creates the directory, and a
   * failure there is a real error rather than "no such attachment". Only the lookup and
   * the read are swallowed into `null`.
   */
  'attachments:readDataUrl': (_ctx, threadId, filename) => {
    const safeName = basename(filename)
    const filePath = join(getAttachmentDir(), basename(threadId), safeName)
    try {
      const info = getFileInfo(filePath)
      if (!info || info.size > 15 * 1024 * 1024) return null
      const data = readFileSync(filePath)
      return `data:${info.mimeType};base64,${data.toString('base64')}`
    } catch {
      return null
    }
  },

  'attachments:getFileInfo': (_ctx, filePath) => getFileInfo(filePath),

  /**
   * Local-only, and the only channel in the map whose remote hop is not a plain
   * same-channel forward: a source path on *this* machine means nothing to a remote host,
   * so `ipc/handlers.ts` reads the file here and uploads it as an `attachments:save`. That
   * hop stays in the adapter; this is the local implementation it falls back to.
   *
   * The read runs BEFORE the copy — an unreadable source must fail without leaving a
   * half-made attachment behind — and the mime type comes from the *source* path's
   * extension, not from the copy's generated filename.
   *
   * `dataUrl` is absent from the channel contract, yet InputBar.tsx destructures it off the
   * result, so it is live: the contract under-declares this one. Preserved as-is — widening
   * the contract is a separate change — and note that `satisfies` does NOT catch it, so the
   * gap is invisible to the build rather than merely tolerated by it.
   */
  'attachments:saveFromPath': (_ctx, sourcePath, threadId) => {
    const dataUrl = filePathToDataUrl(sourcePath)
    return { ...copyAttachmentFromPath(sourcePath, threadId), dataUrl }
  },

  // ── Plans ─────────────────────────────────────────────────────────────────

  // Remote-only: the desktop renderer reads the plan file through the files:* channels,
  // mobile cannot. `?? null` rather than bare optional chaining because the contract's
  // result is `T | null` and JSON.stringify would drop an `undefined` on the way out.
  'plans:getForThread': (_ctx, threadId) =>
    sessionManager.get(threadId)?.getAssociatedPlan() ?? null,

  // ── Desktop shell integration ─────────────────────────────────────────────
  //
  // Everything from here down is `{ local: true, remote: false }`, and — unlike every
  // family above — none of it ever had a `case` in control-rpc.ts. There was one
  // implementation, so nothing here resolves a difference between two; the fold is a pure
  // move, and what the characterisation tests pin is that the channel stays registered on
  // ipcMain and stays refused by `handleControlRpc`.
  //
  // The reason the whole group is local-only is the same one each time: a clipboard, an
  // Explorer window, a native file dialog or a terminal belongs to the machine the user is
  // sitting at, and forwarding it to a phone would open it on the wrong desk.

  'shell:copyPath': (_ctx, dirPath) => clipboard.writeText(dirPath),

  // The one place in the map that deliberately drops its callee's result. `shell.openPath`
  // returns a promise of an *error string* (it resolves rather than rejects), and the
  // pre-fold handler floated it: the invoke replied immediately. Returning it would make
  // every reveal wait for Explorer to come up, and `Promise<string>` is not the contract's
  // `void` anyway. Contrast `app:open-logs-folder` below, which does return it.
  'shell:openInExplorer': (_ctx, dirPath) => { shell.openPath(dirPath) },

  // `ssh`/`wsl` arrive as arguments here rather than from getConfigForPath — the caller
  // decides which remote authority the vscode-remote URI addresses. Both are passed through
  // raw: getVsCodeFolderUri tests each for truthiness in its own body, so `undefined` and
  // `null` are already equivalent there.
  'shell:openInVsCode': (_ctx, dirPath, ssh, wsl) => openFolderInVsCode(dirPath, ssh, wsl),

  // Reveal a specific file in the native file manager (Explorer / Finder), highlighting it.
  // For WSL-native paths, translates to a \\wsl$\<distro>\… UNC path so Explorer can open it.
  // Throws for SSH-hosted paths (cannot reveal a remote file locally).
  'shell:revealInExplorer': (_ctx, filePath) => {
    const { ssh, wsl } = getConfigForPath(filePath)
    if (ssh) {
      throw new Error('Cannot reveal files hosted on a remote SSH location.')
    }
    let revealPath = filePath
    if (wsl && !/^[A-Za-z]:[/\\]/.test(filePath)) {
      revealPath = wslPathToUnc(filePath, wsl.distro)
    }
    return shell.showItemInFolder(revealPath)
  },

  // The candidate list is the behaviour: `wsl` (whatever the host OS is) beats the host
  // platform's own terminal, and on Linux the three candidates are tried in order until one
  // spawns. `wsl` is passed through raw — the branch is a truthiness test in this body.
  'shell:openInTerminal': (_ctx, dirPath, wsl) => {
    if (wsl) {
      // Launch a WSL terminal in the given distro, cd-ing to the WSL path
      const wslPath = /^[A-Za-z]:[/\\]/.test(dirPath) ? windowsPathToWsl(dirPath) : dirPath
      spawn('wsl.exe', ['-d', wsl.distro, '--cd', wslPath], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'win32') {
      spawn('start', ['powershell.exe', '-NoExit', '-Command', `Set-Location '${dirPath.replace(/'/g, "''")}'`], { cwd: dirPath, detached: true, stdio: 'ignore', shell: true }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Terminal', dirPath], { detached: true, stdio: 'ignore' }).unref()
    } else {
      const terms = ['gnome-terminal', 'konsole', 'xterm']
      for (const term of terms) {
        try {
          spawn(term, [], { cwd: dirPath, detached: true, stdio: 'ignore' }).unref()
          break
        } catch { /* try next */ }
      }
    }
  },

  // ── Window controls ───────────────────────────────────────────────────────
  //
  // The first family to need `ctx.window` for its own sake rather than as an event target.
  // Both pre-fold and post-fold that is the same single BrowserWindow: the IPC adapter
  // closed over the one `registerIpcHandlers` was given, and the context carries the same.
  //
  // The push half of this family — `window.on('maximize', …)` sending
  // `window:maximized-changed` — stays in handlers.ts: it is a window event listener, not a
  // channel, and the registry does not inventory push channels.

  'window:minimize': (ctx) => ctx.window.minimize(),

  // A toggle, so the state read is part of the behaviour and not a guard: `isMaximized()`
  // is always called, and exactly one of unmaximize/maximize follows it.
  'window:maximize': (ctx) => ctx.window.isMaximized() ? ctx.window.unmaximize() : ctx.window.maximize(),

  'window:close': (ctx) => ctx.window.close(),

  'window:is-maximized': (ctx) => ctx.window.isMaximized(),

  // ── App info, logs and the auto-updater ───────────────────────────────────

  // `app.getVersion()` is read before the branch and unconditionally, so a dev run computes
  // a version it then throws away. Preserved verbatim: the alternative reading — that dev
  // builds skip the lookup — would be a different (if harmless) behaviour.
  'app:getVersion': () => {
    const version = app.getVersion()
    const packaged = app.isPackaged
    const isDev = !packaged && process.env.NODE_ENV !== 'production'
    if (isDev) return 'Local Dev'
    return `v${version}`
  },

  // Unlike `shell:openInExplorer`, this one *does* pass openPath's promise through — the
  // contract's result is the `string` it resolves to, which is empty on success and an
  // error message otherwise, and the settings UI shows it.
  'app:open-logs-folder': () => shell.openPath(getLogsDirPath()),

  // Two calls, and the *second* one's value is the result. `checkForUpdates` is `: void`
  // and only starts a background check, so there is nothing to pass through from it; the
  // reply is the state as it stands at this instant, not the state after the check lands.
  // The renderer learns about the outcome through the updater's own push events.
  'update:check': () => {
    checkForUpdates()
    return getUpdateState()
  },

  'update:apply': () => ({ success: applyUpdate() }),

  'update:get-state': () => getUpdateState(),

  // ── Native file dialogs ───────────────────────────────────────────────────
  //
  // Both are modal on `ctx.window`, and their cancelled shapes deliberately differ: a
  // directory picker answers `null` and a file picker answers `[]`, because the callers
  // treat "nothing chosen" as an absent value and as an empty list respectively.

  'dialog:open-directory': async (ctx) => {
    const result = await dialog.showOpenDialog(ctx.window, {
      properties: ['openDirectory']
    })
    // The second `?? null` is not redundant with `canceled`: a dialog can return
    // `canceled: false` with an empty selection, and an `undefined` would be dropped by
    // JSON.stringify on the way to the renderer while the contract promises `string | null`.
    return result.canceled ? null : result.filePaths[0] ?? null
  },

  'dialog:open-files': async (ctx) => {
    const result = await dialog.showOpenDialog(ctx.window, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    return result.canceled ? [] : result.filePaths
  },

  // ── Settings and the webhook server ───────────────────────────────────────

  // The generic key/value settings pair, on the same `settings` table the webhook and
  // remote-control configs are stored in. Nothing depends on the order these are registered
  // in — both are plain reads and writes against the DB, with no module init behind them.
  'settings:get': (_ctx, key) => getSetting(key),

  'settings:set': (_ctx, key, value) => setSetting(key, value),

  // The three rows are read individually and each is normalised on the way out, because the
  // never-configured state is three *missing rows* rather than a missing object: disabled,
  // the default port, and an empty token.
  //
  // The `?? '3284'` fires on a missing row only — `??` does not fire on `''` — so a row
  // stored as an empty string yields `parseInt('', 10)`, i.e. NaN, and the renderer would
  // show a blank port. Preserved verbatim; `webhook:setConfig` always writes
  // `String(config.port)` so nothing reachable today can store one, and widening this to
  // `Number.isInteger` would be a fix rather than a fold.
  'webhook:getConfig': () => ({
    enabled: getSetting('webhook:enabled') === 'true',
    port: parseInt(getSetting('webhook:port') ?? '3284', 10),
    token: getSetting('webhook:token') ?? '',
  } satisfies WebhookConfig),

  // The restart comes last and is handed the *incoming* config rather than a re-read of
  // what was just written. Both matter: restarting first would rebind the old port, and
  // re-reading would make the restart depend on the writes having landed.
  'webhook:setConfig': (ctx, config) => {
    setSetting('webhook:enabled', config.enabled ? 'true' : 'false')
    setSetting('webhook:port', String(config.port))
    setSetting('webhook:token', config.token)
    return restartWebhookServer(config, ctx.window)
  },

  // ── Remote control: the two channels that are not the client ──────────────
  //
  // The other nine `remote:*` channels stay registered in `remote/client.ts`. They are
  // methods on the `RemoteControlClient` instance that `registerRemoteControlIpcHandlers`
  // constructs and closes over, and reaching that instance from here would need either the
  // module's `activeClient` variable — today only quit-time bookkeeping, and null after
  // `stopRemoteControlClient()` — or an import of `remote/client.ts`, which imports
  // `control/control-rpc.ts`, which imports this file. Both are worse than leaving them.
  //
  // These two are different in kind: they call module-level functions in `remote/config.ts`
  // and `remote/lan.ts`, neither of which reaches back here, so folding them needs no
  // instance and creates no cycle.

  'remote:getServerConfig': () => readRemoteServerConfig(),

  'remote:getPairingInfo': () => getPairingInfo(),
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
