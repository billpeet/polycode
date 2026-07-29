import { spawn } from 'child_process'
import { basename } from 'path'
import { pathToFileURL } from 'url'
import { app, ipcMain, dialog, BrowserWindow, shell, clipboard } from 'electron'
import { isLocalChannel } from '@polycode/shared'
import { applyUpdate, checkForUpdates, getUpdateState } from '../updater'
import { getSetting, setSetting } from '../db/queries'
import { SshConfig, WslConfig } from '../../shared/types'
import { commandManager } from '../commands/manager'
import { ptyManager } from '../terminal/manager'
import { getCachedGitBranch, getCachedGitStatus, commitChanges, stageFile, stageFiles, unstageFile, stageAll, unstageAll, generateCommitMessage, generateCommitMessageWithContext, generateBranchName, generatePullRequestText, gitPush, gitPushSetUpstream, gitPull, gitPullOrigin, gitPullWithAutoStash, gitFetchRemoteCached, getFileDiff, getCachedCompareToMainChanges, getCompareToMainFileDiff, getCompareToBranchChanges, getCompareToBranchDiff, listCachedBranches, checkoutBranch, createBranch, mergeBranch, findMergedBranches, deleteBranches, gitInit, getRemoteUrl, isGitRepoCached, detectGitHostingProviderCached, getCachedDefaultBranch, discardFileChanges, discardAllChanges, getCachedLastCommit, amendCommit, undoLastCommit, listStashes, createStash, applyStash, popStash, dropStash, forceUnlockRepo, listCommits, listCommitFiles, getCommitFileDiff } from '../git'
import { startRepoGitWatch, stopRepoGitWatch } from '../file-watch'
import { restartWebhookServer, WebhookConfig } from '../webhook/server'
import { getLogsDirPath } from '../app-logger'
import { registerRemoteControlIpcHandlers } from '../remote/client'
import { publishRepositoryBranch } from '../publish-branch-adapter'
import { runExecFile } from '../process-control'
import { MIGRATED_CHANNELS, filePathToDataUrl, invokeChannelHandler } from './channel-handlers'
import {
  assertMainBranchCommitAllowed,
  getConfigForPath,
  invalidateRepoGitCache,
  windowsPathToWsl,
} from './thread-context'

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

    proxyable(channel, invokeLocally)
  }

  // ── Dialog ────────────────────────────────────────────────────────────────

  ipcMain.handle('dialog:open-directory', async () => {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  // ── Git ───────────────────────────────────────────────────────────────────

  proxyable('git:branch', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getCachedGitBranch(repoPath, ssh, wsl)
  })

  proxyable('git:status', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getCachedGitStatus(repoPath, ssh, wsl)
  })

  proxyable('git:commit', async (repoPath: string, message: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await assertMainBranchCommitAllowed(repoPath, ssh, wsl)
    await commitChanges(repoPath, message, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:lastCommit', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getCachedLastCommit(repoPath, ssh, wsl)
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

  proxyable('git:generateCommitMessage', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return generateCommitMessage(repoPath, ssh, wsl)
  })

  proxyable('git:generateCommitMessageWithContext', (repoPath: string, filePaths: string[], context: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return generateCommitMessageWithContext(repoPath, filePaths, context, ssh, wsl)
  })

  proxyable('git:generateBranchName', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return generateBranchName(repoPath, ssh, wsl)
  })

  proxyable('git:generatePullRequestText', (repoPath: string, targetBranch: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return generatePullRequestText(repoPath, targetBranch, ssh, wsl)
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
  proxyable('git:stashList', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return listStashes(repoPath, ssh, wsl)
  })

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

  proxyable('git:forceUnlock', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return forceUnlockRepo(repoPath, ssh, wsl)
  })

  proxyable('git:fetchRemote', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return gitFetchRemoteCached(repoPath, ssh, wsl)
  })

  proxyable('git:diff', (repoPath: string, filePath: string, staged: boolean) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getFileDiff(repoPath, filePath, staged, ssh, wsl)
  })

  proxyable('git:compareToMain', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getCachedCompareToMainChanges(repoPath, ssh, wsl)
  })

  proxyable('git:compareDiffToMain', (repoPath: string, filePath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getCompareToMainFileDiff(repoPath, filePath, ssh, wsl)
  })

  proxyable('git:compareToBranch', (repoPath: string, targetBranch: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getCompareToBranchChanges(repoPath, targetBranch, ssh, wsl)
  })

  proxyable('git:compareDiffToBranch', (repoPath: string, targetBranch: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getCompareToBranchDiff(repoPath, targetBranch, ssh, wsl)
  })

  proxyable('git:log', (repoPath: string, opts?: { range?: string; limit?: number }) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return listCommits(repoPath, opts ?? {}, ssh, wsl)
  })

  proxyable('git:commitFiles', (repoPath: string, sha: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return listCommitFiles(repoPath, sha, ssh, wsl)
  })

  proxyable('git:commitDiff', (repoPath: string, sha: string, filePath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getCommitFileDiff(repoPath, sha, filePath, ssh, wsl)
  })

  proxyable('git:branches', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return listCachedBranches(repoPath, ssh, wsl)
  })

  proxyable('git:watchStart', (repoPath: string) => {
    return startRepoGitWatch(window, repoPath, invalidateRepoGitCache)
  })

  proxyable('git:watchStop', (repoPath: string) => {
    stopRepoGitWatch(repoPath)
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

  proxyable('git:findMergedBranches', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return findMergedBranches(repoPath, ssh, wsl)
  })

  proxyable('git:deleteBranches', (repoPath: string, branches: string[]) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return deleteBranches(repoPath, branches, ssh, wsl)
  })

  proxyable('git:init', async (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    await gitInit(repoPath, ssh, wsl)
    invalidateRepoGitCache(repoPath)
  })

  proxyable('git:isRepo', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return isGitRepoCached(repoPath, ssh, wsl)
  })

  proxyable('git:getRemoteUrl', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getRemoteUrl(repoPath, ssh, wsl)
  })

  proxyable('git:hostingProvider', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return detectGitHostingProviderCached(repoPath, ssh, wsl)
  })

  proxyable('git:defaultBranch', (repoPath: string) => {
    const { ssh, wsl } = getConfigForPath(repoPath)
    return getCachedDefaultBranch(repoPath, ssh, wsl)
  })

  ipcMain.handle('dialog:open-files', async () => {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    return result.canceled ? [] : result.filePaths
  })

  // ── Settings ───────────────────────────────────────────────────────────────

  ipcMain.handle('settings:get', (_event, key: string) => {
    return getSetting(key)
  })

  ipcMain.handle('settings:set', (_event, key: string, value: string) => {
    setSetting(key, value)
  })

  // ── Shell helpers ──────────────────────────────────────────────────────────

  ipcMain.handle('shell:copyPath', (_event, dirPath: string) => {
    clipboard.writeText(dirPath)
  })

  ipcMain.handle('shell:openInExplorer', (_event, dirPath: string) => {
    shell.openPath(dirPath)
  })

  ipcMain.handle('shell:openInVsCode', async (_event, dirPath: string, ssh?: SshConfig | null, wsl?: WslConfig | null) => {
    await openFolderInVsCode(dirPath, ssh, wsl)
  })

  // Reveal a specific file in the native file manager (Explorer / Finder), highlighting it.
  // For WSL-native paths, translates to a \\wsl$\<distro>\… UNC path so Explorer can open it.
  // Throws for SSH-hosted paths (cannot reveal a remote file locally).
  ipcMain.handle('shell:revealInExplorer', (_event, filePath: string) => {
    const { ssh, wsl } = getConfigForPath(filePath)
    if (ssh) {
      throw new Error('Cannot reveal files hosted on a remote SSH location.')
    }
    let revealPath = filePath
    if (wsl && !/^[A-Za-z]:[/\\]/.test(filePath)) {
      revealPath = wslPathToUnc(filePath, wsl.distro)
    }
    shell.showItemInFolder(revealPath)
  })

  ipcMain.handle('shell:openInTerminal', (_event, dirPath: string, wsl?: WslConfig | null) => {
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
  })

  // ── Window Controls ────────────────────────────────────────────────────────

  ipcMain.handle('window:minimize',     () => window.minimize())
  ipcMain.handle('window:maximize',     () => window.isMaximized() ? window.unmaximize() : window.maximize())
  ipcMain.handle('window:close',        () => window.close())
  ipcMain.handle('window:is-maximized', () => window.isMaximized())

  window.on('maximize',   () => window.webContents.send('window:maximized-changed', true))
  window.on('unmaximize', () => window.webContents.send('window:maximized-changed', false))

  // ── App info ──────────────────────────────────────────────────────────────

  ipcMain.handle('app:getVersion', () => {
    const version = app.getVersion()
    const packaged = app.isPackaged
    const isDev = !packaged && process.env.NODE_ENV !== 'production'
    if (isDev) return 'Local Dev'
    return `v${version}`
  })

  ipcMain.handle('app:open-logs-folder', () => {
    return shell.openPath(getLogsDirPath())
  })

  // ── Auto-updater ───────────────────────────────────────────────────────────

  ipcMain.handle('update:check', () => {
    checkForUpdates()
    return getUpdateState()
  })

  ipcMain.handle('update:apply', () => {
    return { success: applyUpdate() }
  })

  ipcMain.handle('update:get-state', () => {
    return getUpdateState()
  })

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

  // ── Webhook ─────────────────────────────────────────────────────────────────

  ipcMain.handle('webhook:getConfig', () => {
    return {
      enabled: getSetting('webhook:enabled') === 'true',
      port: parseInt(getSetting('webhook:port') ?? '3284', 10),
      token: getSetting('webhook:token') ?? '',
    } satisfies WebhookConfig
  })

  ipcMain.handle('webhook:setConfig', (_event, config: WebhookConfig) => {
    setSetting('webhook:enabled', config.enabled ? 'true' : 'false')
    setSetting('webhook:port', String(config.port))
    setSetting('webhook:token', config.token)
    restartWebhookServer(config, window)
  })
}
