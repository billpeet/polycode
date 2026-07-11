import { contextBridge, ipcRenderer } from 'electron'

export type IpcListener = (...args: unknown[]) => void

const api = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
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
