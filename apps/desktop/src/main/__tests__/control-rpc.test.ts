import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invokeChannelHandler: vi.fn(async () => 'handled'),
}))

vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('../app-lifecycle', () => ({ runAppOperation: (fn: () => unknown) => fn() }))
vi.mock('../ipc/channel-handlers', () => ({
  invokeChannelHandler: mocks.invokeChannelHandler,
  isMigratedChannel: () => true,
}))

import { handleControlRpc, type ControlRpcHost } from '../control/control-rpc'

const host = {
  window: { id: 'window' },
  runLifecycle: { id: 'run-lifecycle' },
} as unknown as ControlRpcHost

describe('handleControlRpc', () => {
  it('hands a remote caller the Run lifecycle, so routines:* work off the desktop', async () => {
    mocks.invokeChannelHandler.mockClear()

    await expect(handleControlRpc(host, 'routines:runNow', ['routine-1'])).resolves.toBe('handled')

    expect(mocks.invokeChannelHandler).toHaveBeenCalledWith(
      'routines:runNow',
      { window: host.window, origin: 'remote', runLifecycle: host.runLifecycle },
      ['routine-1'],
    )
  })

  it('still refuses a channel the registry keeps local', async () => {
    mocks.invokeChannelHandler.mockClear()

    await expect(handleControlRpc(host, 'settings:get', ['key'])).rejects.toThrow(/Unsupported remote control channel: settings:get/)
    expect(mocks.invokeChannelHandler).not.toHaveBeenCalled()
  })
})
