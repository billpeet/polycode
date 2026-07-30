/**
 * Behavioural coverage for `RemoteControlClient.shouldProxy`.
 *
 * This lives in its own file because `dispatch-characterisation.test.ts` mocks
 * `../remote/client` wholesale — that mock is what keeps the remote-forwarding hop inert for
 * every other test, and it substitutes its own `shouldProxy`. So nothing there exercises the
 * real one, and `shouldProxy` had no behavioural test at all: rewriting it as
 * `isRemoteChannel(channel) || true` passed the entire suite.
 *
 * That matters because it gates every forwarding decision. Always-true would forward every
 * local-only channel — `window:is-maximized`, `settings:set`, `dialog:open-files`, the
 * `remote:*` family — to the remote desktop, where `remote/server.ts` rejects anything
 * outside `CONTROL_RPC_CHANNELS`, so the local UI would throw on ordinary interactions
 * whenever a host was active.
 */
import { describe, expect, it, vi } from 'vitest'
import { CHANNEL_REGISTRY, REMOTE_CHANNELS } from '@polycode/shared'

// Only what constructing the class needs; no ipcMain registration happens at construction.
vi.mock('electron', () => ({
  ipcMain: { handle: () => {}, on: () => {} },
  app: { getPath: () => 'C:/tmp', getVersion: () => '0.0.0', isPackaged: false },
  BrowserWindow: class {},
}))
vi.mock('../db/queries', () => ({
  getSetting: () => null,
  setSetting: () => {},
}))
vi.mock('../app-events', () => ({ emitAppEvent: () => {} }))

const { RemoteControlClient } = await import('../remote/client')

const window = { webContents: { isDestroyed: () => false, send: () => {} } }
const client = new RemoteControlClient(window as unknown as import('electron').BrowserWindow)

describe('RemoteControlClient.shouldProxy', () => {
  it('answers true for exactly the remote-capable channels, and false for the rest', () => {
    const remote = new Set<string>(REMOTE_CHANNELS)
    const wrong = Object.keys(CHANNEL_REGISTRY).filter(
      (channel) => client.shouldProxy(channel) !== remote.has(channel),
    )
    expect(wrong).toEqual([])
    // Non-vacuous in both directions: the registry really does contain some of each.
    expect(Object.keys(CHANNEL_REGISTRY).filter((c) => remote.has(c)).length).toBeGreaterThan(100)
    expect(Object.keys(CHANNEL_REGISTRY).filter((c) => !remote.has(c)).length).toBeGreaterThan(20)
  })

  it('refuses a local-only channel, so it is never forwarded to a host', () => {
    for (const channel of ['window:is-maximized', 'settings:set', 'dialog:open-files', 'remote:getHosts']) {
      expect(CHANNEL_REGISTRY[channel as keyof typeof CHANNEL_REGISTRY]).toMatchObject({ remote: false })
      expect(client.shouldProxy(channel), channel).toBe(false)
    }
  })

  it('accepts a dual-path channel, so desktop-to-desktop control keeps working', () => {
    for (const channel of ['projects:list', 'threads:send', 'git:status', 'forge:pr:list']) {
      expect(client.shouldProxy(channel)).toBe(true)
    }
  })

  it('refuses channels outside the registry entirely', () => {
    // `terminal:write` and `log:write` reach ipcMain.on, not the request/response registry.
    for (const channel of ['', 'unknown:channel', '__proto__', 'constructor', 'toString', 'log:write']) {
      expect(client.shouldProxy(channel), channel).toBe(false)
    }
  })
})
