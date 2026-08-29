import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { emitAppEvent, onAppEvent } from '../app-events'

function fakeWindow(options: { windowDestroyed?: boolean; webContentsDestroyed?: boolean } = {}) {
  const destroyed = options.windowDestroyed || options.webContentsDestroyed
  const send = vi.fn(() => {
    if (destroyed) throw new TypeError('Object has been destroyed')
  })
  const window = {
    isDestroyed: () => options.windowDestroyed ?? false,
    webContents: {
      isDestroyed: () => options.webContentsDestroyed ?? false,
      send,
    },
  } as unknown as BrowserWindow

  return { window, send }
}

describe('emitAppEvent', () => {
  it('sends to the renderer and publishes to the in-process event bus', () => {
    const { window, send } = fakeWindow()
    const listener = vi.fn()
    const unsubscribe = onAppEvent(listener)

    expect(() => emitAppEvent(window, 'test:event', 'payload')).not.toThrow()

    expect(send).toHaveBeenCalledWith('test:event', 'payload')
    expect(listener).toHaveBeenCalledWith({ channel: 'test:event', args: ['payload'] })
    unsubscribe()
  })

  it.each([
    ['window', { windowDestroyed: true }],
    ['webContents', { webContentsDestroyed: true }],
  ])('does not send when the %s has been destroyed, but still publishes in-process', (_name, options) => {
    const { window, send } = fakeWindow(options)
    const listener = vi.fn()
    const unsubscribe = onAppEvent(listener)

    expect(() => emitAppEvent(window, 'test:event', 'payload')).not.toThrow()

    expect(send).not.toHaveBeenCalled()
    expect(listener).toHaveBeenCalledWith({ channel: 'test:event', args: ['payload'] })
    unsubscribe()
  })
})
