// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TitleBar from '../TitleBar'

/**
 * The title bar is the one surface every capability flag reaches: window controls, the
 * host switcher, and the "which host am I on" indicator that means something different
 * in a browser (always remote) than on the desktop (only when a host is selected).
 */

const CONNECTED = { hostId: 'web', phase: 'connected', reconnectAttempt: 0, error: null, latencyMs: null, changedAt: '' }

// Only consulted when `window.api` is absent; the Electron case below never reaches it.
vi.mock('../../lib/webClient', () => ({
  WEB_CAPABILITIES: Object.freeze({
    windowControls: false, shell: false, nativeDialogs: false, browserPanel: false,
    updates: false, remoteHosts: false, routines: false, webhook: false,
  }),
  getWebClient: () => ({
    invoke: vi.fn(async () => CONNECTED),
    on: vi.fn(() => () => {}),
    send: vi.fn(),
    onSlowInvoke: vi.fn(() => () => {}),
  }),
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function electronBridge() {
  return {
    invoke: vi.fn(async (channel: string) => {
      switch (channel) {
        case 'window:is-maximized': return false
        case 'remote:getHosts': return []
        case 'remote:getActiveHost': return null
        case 'remote:getConnectionState':
          return { ...CONNECTED, hostId: null, phase: 'local' }
        default: return null
      }
    }),
    on: vi.fn(() => () => {}),
    send: vi.fn(),
    onSlowInvoke: vi.fn(() => () => {}),
  }
}

describe('TitleBar under Electron', () => {
  it('renders window controls and the host switcher', async () => {
    vi.stubGlobal('window', { ...window, api: electronBridge() })
    render(<TitleBar />)

    expect(await screen.findByTitle('Minimize')).toBeTruthy()
    expect(screen.getByTitle('Close')).toBeTruthy()
    expect(screen.getByRole('combobox')).toBeTruthy()
  })
})

describe('TitleBar in a browser', () => {
  it('renders neither window controls nor a host switcher', () => {
    vi.stubGlobal('window', { ...window, api: undefined })
    render(<TitleBar />)

    expect(screen.queryByTitle('Minimize')).toBeNull()
    expect(screen.queryByTitle('Close')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.getByText('PolyCode')).toBeTruthy()
  })
})
