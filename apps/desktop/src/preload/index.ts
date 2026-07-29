import { contextBridge, ipcRenderer } from 'electron'
import { isLocalChannel } from '@polycode/shared'

export type IpcListener = (...args: unknown[]) => void

const api = {
  /**
   * Request/response calls are allowlisted from the channel registry, which makes it a
   * runtime trust boundary rather than only a typing convenience. Anything renderer code
   * can reach must be declared `local: true` in CHANNEL_REGISTRY.
   *
   * `on` and `send` are deliberately not gated: they carry streaming event channels
   * (`thread:output:${threadId}`, `command:*`, `log:write`) which are per-thread and
   * per-command, so they are not enumerable in the registry.
   */
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!isLocalChannel(channel)) {
      return Promise.reject(
        new Error(`Blocked IPC channel "${channel}" — not declared local in CHANNEL_REGISTRY`),
      )
    }
    return ipcRenderer.invoke(channel, ...args)
  },

  on(channel: string, callback: IpcListener): () => void {
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void =>
      callback(...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },

  send(channel: string, ...args: unknown[]): void {
    ipcRenderer.send(channel, ...args)
  }
}

contextBridge.exposeInMainWorld('api', api)
