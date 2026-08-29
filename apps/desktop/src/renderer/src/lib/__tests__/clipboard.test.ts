import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writeClipboardText } from '../clipboard'

describe('writeClipboardText', () => {
  const browserWriteText = vi.fn<(text: string) => Promise<void>>()
  const invoke = vi.fn<(channel: string, text: string) => Promise<void>>()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('navigator', { clipboard: { writeText: browserWriteText } })
    vi.stubGlobal('window', { api: { invoke } })
  })

  it('writes through the browser clipboard while the document is focused', async () => {
    browserWriteText.mockResolvedValue(undefined)

    await expect(writeClipboardText('copied text')).resolves.toBe(true)

    expect(browserWriteText).toHaveBeenCalledWith('copied text')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('falls back to Electron when browser clipboard access loses focus', async () => {
    browserWriteText.mockRejectedValue(
      new DOMException('Document is not focused', 'NotAllowedError'),
    )
    invoke.mockResolvedValue(undefined)

    await expect(writeClipboardText('copied text')).resolves.toBe(true)

    expect(invoke).toHaveBeenCalledWith('clipboard:writeText', 'copied text')
  })

  it('reports failure without rejecting when neither clipboard is available', async () => {
    browserWriteText.mockRejectedValue(
      new DOMException('Document is not focused', 'NotAllowedError'),
    )
    invoke.mockRejectedValue(new Error('clipboard unavailable'))

    await expect(writeClipboardText('copied text')).resolves.toBe(false)
  })
})
