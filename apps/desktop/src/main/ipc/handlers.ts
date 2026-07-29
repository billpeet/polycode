import { basename } from 'path'
import { ipcMain, BrowserWindow } from 'electron'
import { isLocalChannel, isRemoteChannel } from '@polycode/shared'
import { commandManager } from '../commands/manager'
import { ptyManager } from '../terminal/manager'
import { commitChanges, stageFile, stageFiles, unstageFile, stageAll, unstageAll, gitPush, gitPushSetUpstream, gitPull, gitPullOrigin, gitPullWithAutoStash, checkoutBranch, createBranch, mergeBranch, gitInit, discardFileChanges, discardAllChanges, amendCommit, undoLastCommit, createStash, applyStash, popStash, dropStash } from '../git'
import { registerRemoteControlIpcHandlers } from '../remote/client'
import { publishRepositoryBranch } from '../publish-branch-adapter'
import { MIGRATED_CHANNELS, filePathToDataUrl, invokeChannelHandler } from './channel-handlers'
import {
  assertMainBranchCommitAllowed,
  getConfigForPath,
  invalidateRepoGitCache,
} from './thread-context'

export function registerIpcHandlers(window: BrowserWindow): void {
  commandManager.init(window)
  ptyManager.init(window)
  const remoteClient = registerRemoteControlIpcHandlers(window)
  const proxyable = <T extends unknown[]>(
    channel: string,
    handler: (...args: T) => unknown | Promise<unknown>,
  ): void => {
    ipcMain.handle(channel, async (_event, ...args: T) => {
      const proxied = await remoteClient.invokeIfActive(channel, args)
      if (proxied.handled) return proxied.value
      return handler(...args)
    })
  }

  // ── Folded handlers ───────────────────────────────────────────────────────
  //
  // Channels implemented once in `channel-handlers.ts` and typed against
  // ChannelContract. This adapter's only remaining job for them is the ipcMain
  // registration and the remote-forwarding hop that `proxyable` provides.
  for (const channel of MIGRATED_CHANNELS) {
    // Reachability comes from the registry, not from membership of the map — the mirror of
    // the `isRemoteChannel` guard in control-rpc.ts. Without this, folding a `local: false`
    // channel (`attachments:readDataUrl`, `plans:getForThread`) would register it on
    // ipcMain and make a remote-only channel locally reachable. The preload allowlist would
    // still refuse it, but that is the *other* layer of the same trust boundary, and
    // `local: false` is supposed to mean "no handler exists" rather than "one exists but
    // something else blocks the door".
    if (!isLocalChannel(channel)) continue

    const invokeLocally = (...args: unknown[]): Promise<unknown> =>
      invokeChannelHandler(channel, { window, origin: 'local' }, args)

    // The one folded channel whose remote hop is not "same channel, same arguments".
    // A source path on this machine is meaningless to the host, so with a remote host
    // active the file is read here and uploaded as an `attachments:save`; the local
    // implementation in the handler map is the fallback. `proxyable` cannot express this,
    // and it is forwarding — an adapter concern — so it stays here rather than in the map.
    if (channel === 'attachments:saveFromPath') {
      ipcMain.handle(channel, async (_event, sourcePath: string, threadId: string) => {
        // Encode only when there is actually a host to upload to. `invokeIfActive` returns
        // `handled: true` exactly when `getActiveHost() && shouldProxy(...)`, so hoisting
        // that condition is equivalent — and it keeps the local path to a single read of
        // the file, which the map handler does. Computing the data URL unconditionally
        // here would read and base64 every attachment twice on the common path.
        if (remoteClient.getActiveHost() && remoteClient.shouldProxy('attachments:save')) {
          const dataUrl = filePathToDataUrl(sourcePath)
          const proxied = await remoteClient.invokeIfActive('attachments:save', [
            dataUrl,
            basename(sourcePath),
            threadId,
          ])
          if (proxied.handled && proxied.value && typeof proxied.value === 'object') {
            return { ...proxied.value, dataUrl }
          }
        }
        return invokeLocally(sourcePath, threadId)
      })
      continue
    }

    // The forwarding hop is only meaningful for a channel a remote host could serve.
    // `proxyable` calls `invokeIfActive`, which reads the active host out of settings
    // (a SQLite read) *before* consulting `shouldProxy` — and `shouldProxy` is
    // `isRemoteChannel` underneath, so for a local-only channel that read can only ever
    // lead to "not handled". Pre-fold these were bare `ipcMain.handle` with no hop at all;
    // `window:is-maximized` fires on every titlebar interaction, so it is not free.
    if (isRemoteChannel(channel)) {
      proxyable(channel, invokeLocally)
    } else {
      ipcMain.handle(channel, (_event, ...args: unknown[]) => invokeLocally(...args))
    }
  }

  // ── Git ───────────────────────────────────────────────────────────────────

  proxyable('git:commit', async (repoPath: string, message: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await assertMainBranchCommitAllowed(repoPath, ssh, wsl)
    await commitChanges(repoPath, message, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:amendCommit', async (repoPath: string, message?: string | null) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await assertMainBranchCommitAllowed(repoPath, ssh, wsl)
    await amendCommit(repoPath, message ?? null, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:undoLastCommit', async (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await undoLastCommit(repoPath, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:stage', async (repoPath: string, filePath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await stageFile(repoPath, filePath, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:unstage', async (repoPath: string, filePath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await unstageFile(repoPath, filePath, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:stageAll', async (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await stageAll(repoPath, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:unstageAll', async (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await unstageAll(repoPath, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:stageFiles', async (repoPath: string, filePaths: string[]) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await stageFiles(repoPath, filePaths, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:discardFile', async (repoPath: string, filePath: string, oldPath?: string | null) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await discardFileChanges(repoPath, filePath, oldPath ?? null, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:discardFiles', async (repoPath: string, files: Array<{ path: string; oldPath?: string | null }>) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    // Discard one at a time so one failure doesn't abort the rest
    const errors: Array<{ path: string; error: string }> = []
    for (const file of files) {
      try {
        await discardFileChanges(repoPath, file.path, file.oldPath ?? null, ssh, wsl)
      } catch (err) {
        errors.push({ path: file.path, error: err instanceof Error ? err.message : String(err) })
      }
    }
    if (errors.length > 0) {
      throw new Error(`Failed to discard ${errors.length} file${errors.length !== 1 ? 's' : ''}: ${errors.map((e) => `${e.path} (${e.error})`).join('; ')}`)
    }
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:discardAll', async (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await discardAllChanges(repoPath, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:push', async (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    const result = await gitPush(repoPath, ssh, wsl)
    invalidateRepoGitCache(repoPath)
    return result
  })

  proxyable('git:publishBranch', async (input: import('../../shared/types').PublishBranchInput) => {
    const { ssh, wsl } = getConfigForPath(input.repoPath)
    try {
      return await publishRepositoryBranch(input, ssh, wsl)
    } finally {
      invalidateRepoGitCache(input.repoPath)
    }
  })

  proxyable('git:pushSetUpstream', async (repoPath: string, branch: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    const result = await gitPushSetUpstream(repoPath, branch, ssh, wsl)
    invalidateRepoGitCache(repoPath)
    return result
  })

  proxyable('git:pull', async (repoPath: string, autoStash?: boolean) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    const result = autoStash
      ? await gitPullWithAutoStash(repoPath, true, ssh, wsl)
      : await gitPull(repoPath, ssh, wsl)
    invalidateRepoGitCache(repoPath)
    return result
  })

  proxyable('git:pullOrigin', async (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    const result = await gitPullOrigin(repoPath, ssh, wsl)
    invalidateRepoGitCache(repoPath)
    return result
  })

  // ─── Stash ────────────────────────────────────────────────────────────────
  proxyable('git:stashCreate', async (repoPath: string, opts: { message?: string; includeUntracked?: boolean }) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await createStash(repoPath, opts ?? {}, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:stashApply', async (repoPath: string, ref: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await applyStash(repoPath, ref, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:stashPop', async (repoPath: string, ref: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await popStash(repoPath, ref, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:stashDrop', async (repoPath: string, ref: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await dropStash(repoPath, ref, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:checkout', async (repoPath: string, branch: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await checkoutBranch(repoPath, branch, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:createBranch', async (repoPath: string, name: string, base: string, pullFirst: boolean) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await createBranch(repoPath, name, base, pullFirst, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:merge', async (repoPath: string, source: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    const result = await mergeBranch(repoPath, source, ssh, wsl)
    invalidateRepoGitCache(repoPath)
    return result
  })

  proxyable('git:init', async (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await gitInit(repoPath, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  // ── Window state push ──────────────────────────────────────────────────────
  //
  // Not a channel: `window:maximized-changed` is pushed to the renderer with
  // `window.api.on`, which CHANNEL_REGISTRY does not inventory. The four `window:*`
  // request/response channels this pairs with are folded.

  window.on('maximize',   () => window.webContents.send('window:maximized-changed', true))
  window.on('unmaximize', () => window.webContents.send('window:maximized-changed', false))

  // ── Terminal (PTY) ──────────────────────────────────────────────────────────
  //
  // These two are fire-and-forget `ipcMain.on` listeners, which is how the renderer
  // actually drives a terminal (`window.api.send` — Terminal.tsx, stores/terminal.ts).
  // CHANNEL_REGISTRY inventories request/response channels only, so this transport shape
  // sits outside the fold by design; the matching `invoke` registrations are folded.

  ipcMain.on('terminal:write', (_event, terminalId: string, data: string) => {
    void remoteClient.invokeIfActive('terminal:write', [terminalId, data]).then((proxied) => {
      if (!proxied.handled) ptyManager.write(terminalId, data)
    })
  })

  ipcMain.on('terminal:resize', (_event, terminalId: string, cols: number, rows: number) => {
    void remoteClient.invokeIfActive('terminal:resize', [terminalId, cols, rows]).then((proxied) => {
      if (!proxied.handled) ptyManager.resize(terminalId, cols, rows)
    })
  })
}
