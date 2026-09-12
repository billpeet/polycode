import { afterEach, describe, expect, it, vi } from 'vitest'
import { client, createElectronClient } from '../client'
import { getWebClient } from '../webClient'
import type { WindowApi } from '../../types/ipc'

vi.mock('../webClient', () => {
  const web = {
    kind: 'web',
    capabilities: Object.freeze({
      windowControls: false, shell: false, nativeDialogs: false, browserPanel: false,
      updates: false, remoteHosts: false, routines: false, webhook: false,
    }),
    systemLocale: undefined,
    invoke: vi.fn().mockResolvedValue('web-value'),
    on: vi.fn(() => () => {}),
    send: vi.fn(),
    onSlowInvoke: vi.fn(() => () => {}),
  }
  return { WEB_CAPABILITIES: web.capabilities, getWebClient: () => web }
})

function fakeApi(overrides: Partial<WindowApi> = {}): WindowApi {
  return {
    systemLocale: 'en-AU',
    invoke: vi.fn().mockResolvedValue('value'),
    on: vi.fn(() => () => {}),
    send: vi.fn(),
    onSlowInvoke: vi.fn(() => () => {}),
    ...overrides,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('client under Electron', () => {
  it('reports the electron kind with every capability', () => {
    vi.stubGlobal('window', { api: fakeApi() })

    expect(client.kind).toBe('electron')
    expect(Object.values(client.capabilities).every(Boolean)).toBe(true)
    expect(client.systemLocale).toBe('en-AU')
  })

  it('delegates every member to the preload bridge', async () => {
    const api = fakeApi()
    vi.stubGlobal('window', { api })
    const listener = (): void => {}
    const slowListener = (): void => {}

    await expect(client.invoke('app:getVersion')).resolves.toBe('value')
    client.on('thread:output:t1', listener)
    client.send('terminal:write', 't1', 'ls')
    client.onSlowInvoke(slowListener)

    expect(api.invoke).toHaveBeenCalledWith('app:getVersion')
    expect(api.on).toHaveBeenCalledWith('thread:output:t1', listener)
    expect(api.send).toHaveBeenCalledWith('terminal:write', 't1', 'ls')
    expect(api.onSlowInvoke).toHaveBeenCalledWith(slowListener)
  })

  it('resolves the bridge per call, so a bridge swapped after import is honoured', async () => {
    const first = fakeApi()
    const second = fakeApi()
    vi.stubGlobal('window', { api: first })
    await client.invoke('app:getVersion')

    vi.stubGlobal('window', { api: second })
    await client.invoke('app:getVersion')

    expect(first.invoke).toHaveBeenCalledTimes(1)
    expect(second.invoke).toHaveBeenCalledTimes(1)
  })
})

describe('client without a preload bridge', () => {
  it('reports the web kind with no desktop-only capability', () => {
    vi.stubGlobal('window', {})

    expect(client.kind).toBe('web')
    expect(Object.values(client.capabilities).some(Boolean)).toBe(false)
    expect(client.systemLocale).toBeUndefined()
  })

  it('routes every member to the web client instead', async () => {
    vi.stubGlobal('window', {})
    const web = getWebClient()
    const listener = (): void => {}

    await expect(client.invoke('projects:list')).resolves.toBe('web-value')
    client.on('thread:output:t1', listener)
    client.send('terminal:write', 't1', 'ls')
    client.onSlowInvoke(listener)

    expect(web.invoke).toHaveBeenCalledWith('projects:list')
    expect(web.on).toHaveBeenCalledWith('thread:output:t1', listener)
    expect(web.send).toHaveBeenCalledWith('terminal:write', 't1', 'ls')
    expect(web.onSlowInvoke).toHaveBeenCalledWith(listener)
  })
})

describe('createElectronClient', () => {
  it('binds to the bridge it was given, independent of window.api', async () => {
    const bound = fakeApi()
    vi.stubGlobal('window', { api: fakeApi() })
    const c = createElectronClient(bound)

    await c.invoke('app:getVersion')

    expect(c.kind).toBe('electron')
    expect(c.systemLocale).toBe('en-AU')
    expect(bound.invoke).toHaveBeenCalledWith('app:getVersion')
    expect(window.api?.invoke).not.toHaveBeenCalled()
  })
})
