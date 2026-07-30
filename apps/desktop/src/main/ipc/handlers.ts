import { basename } from 'path'
import { ipcMain, BrowserWindow } from 'electron'
import { isLocalChannel, isRemoteChannel } from '@polycode/shared'
import { commandManager } from '../commands/manager'
import { ptyManager } from '../terminal/manager'
import { registerRemoteControlIpcHandlers } from '../remote/client'
import { MIGRATED_CHANNELS, filePathToDataUrl, invokeChannelHandler } from './channel-handlers'

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
