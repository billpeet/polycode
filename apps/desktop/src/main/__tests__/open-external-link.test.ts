import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { shell, type BrowserWindow } from 'electron'
import { openExternalLink } from '../open-external-link'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))

afterEach(() => vi.restoreAllMocks())
beforeEach(() => { vi.mocked(shell.openExternal).mockReset() })

function fakeWindow(destroyed = false) {
  const send = vi.fn()
  const window = {
    isDestroyed: () => destroyed,
    webContents: { isDestroyed: () => destroyed, send },
  } as unknown as BrowserWindow
  return { window, send }
}

it('contains an OS open failure and reports a recoverable error', async () => {
  const { window, send } = fakeWindow()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.mocked(shell.openExternal).mockRejectedValue(new Error('Failed to open: (0x2)'))

  await expect(openExternalLink(window, 'https://example.com')).resolves.toBeUndefined()
  expect(send).toHaveBeenCalledWith('shell:open-external-failed', expect.stringContaining('(0x2)'))
  expect(warn).toHaveBeenCalledOnce()
})

it.each(['https://example.com', 'http://localhost:3000', 'mailto:user@example.com'])(
  'opens an approved URL: %s', async (url) => {
    const { window, send } = fakeWindow()
    vi.mocked(shell.openExternal).mockResolvedValue(undefined)
    await openExternalLink(window, url)
    expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith(url)
    expect(send).not.toHaveBeenCalled()
  },
)

it.each(['javascript:alert(1)', 'ms-msdt:test', 'not a url', 'file:///C:/missing.txt'])(
  'reports a blocked target without launching it: %s', async (url) => {
    const { window, send } = fakeWindow()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(openExternalLink(window, url)).resolves.toBeUndefined()
    expect(shell.openExternal).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('shell:open-external-failed', expect.stringContaining('not supported'))
  },
)

it('does not leak an unhandled rejection when the caller discards the promise', async () => {
  const { window, send } = fakeWindow()
  const unhandled = vi.fn()
  process.on('unhandledRejection', unhandled)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.mocked(shell.openExternal).mockRejectedValue(new Error('Failed to open: (0x2)'))
  try {
    void openExternalLink(window, 'https://example.com')
    await new Promise((resolve) => setImmediate(resolve))
    expect(unhandled).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledOnce()
  } finally {
    process.off('unhandledRejection', unhandled)
  }
})

it('contains a late rejection after the window closes', async () => {
  const { window, send } = fakeWindow(true)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.mocked(shell.openExternal).mockRejectedValue('No protocol handler')
  await expect(openExternalLink(window, 'mailto:user@example.com')).resolves.toBeUndefined()
  expect(send).not.toHaveBeenCalled()
})
