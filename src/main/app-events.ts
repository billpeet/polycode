import { EventEmitter } from 'events'
import { BrowserWindow } from 'electron'

export interface AppEvent {
  channel: string
  args: unknown[]
}

type AppEventListener = (event: AppEvent) => void

const appEventBus = new EventEmitter()
appEventBus.setMaxListeners(0)

export function emitAppEvent(window: BrowserWindow, channel: string, ...args: unknown[]): void {
  window.webContents.send(channel, ...args)
  appEventBus.emit('event', { channel, args } satisfies AppEvent)
}

export function onAppEvent(listener: AppEventListener): () => void {
  appEventBus.on('event', listener)
  return () => appEventBus.off('event', listener)
}
