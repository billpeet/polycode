// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ToolCallBlock from '../ToolCallBlock'
import { client } from '../../lib/client'
import type { Message } from '../../types/ipc'

function message(id: string, content: string): Message {
  return { id, content } as Message
}

/** A Codex read: the call names the file, the result carries no text. */
function renderRead(name: string, input: Record<string, unknown>, resultMetadata: Record<string, unknown> = {}, resultContent = '') {
  render(
    <ToolCallBlock
      message={message('call', name)}
      metadata={{ type: 'tool_call', id: 'tool_1', name, input }}
      result={message('result', resultContent)}
      resultMetadata={{ type: 'tool_result', tool_use_id: 'tool_1', ...resultMetadata }}
    />,
  )
  fireEvent.click(screen.getByRole('button'))
}

describe('ToolCallBlock read preview', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows the image a read call targeted', async () => {
    const dataUrl = 'data:image/png;base64,aGVsbG8='
    const read = vi.spyOn(client, 'invoke').mockResolvedValue({ content: '', truncated: false, mimeType: 'image/png', dataUrl })
    renderRead('Read', { file_path: 'C:\\repo\\target\\paper.png' })

    const image = await screen.findByRole('img')
    expect(image.getAttribute('src')).toBe(dataUrl)
    expect(read).toHaveBeenCalledWith('files:read', 'C:\\repo\\target\\paper.png')
    expect(screen.queryByText('Completed')).toBeNull()
  })

  it('previews an ImageView call by its path', async () => {
    const dataUrl = 'data:image/png;base64,aGVsbG8='
    vi.spyOn(client, 'invoke').mockResolvedValue({ content: '', truncated: false, mimeType: 'image/png', dataUrl })
    renderRead('ImageView', { path: '/tmp/screenshot.png' })

    expect((await screen.findByRole('img')).getAttribute('src')).toBe(dataUrl)
  })

  it('prefers an image returned inline with the result over re-reading the file', () => {
    const read = vi.spyOn(client, 'invoke')
    const inline = 'data:image/png;base64,aW5saW5l'
    renderRead('Read', { file_path: 'C:\\repo\\paper.png' }, { content_items: [{ type: 'inputImage', imageUrl: inline }] })

    expect(screen.getByRole('img').getAttribute('src')).toBe(inline)
    expect(read).not.toHaveBeenCalled()
  })

  it('shows the requested range of a text file when the result has no output', async () => {
    vi.spyOn(client, 'invoke').mockResolvedValue({ content: 'one\ntwo\nthree\nfour', truncated: false })
    renderRead('Read', { file_path: '/repo/notes.txt', offset: 1, limit: 2 })

    expect((await screen.findByText(/two/)).textContent).toBe('two\nthree')
  })

  it('keeps the provider output for a text read that returned content', () => {
    const read = vi.spyOn(client, 'invoke')
    renderRead('Read', { file_path: '/repo/notes.txt' }, {}, 'file body from provider')

    expect(screen.getByText('file body from provider')).toBeTruthy()
    expect(read).not.toHaveBeenCalled()
  })

  it('falls back to Completed when the file cannot be read', async () => {
    vi.spyOn(client, 'invoke').mockResolvedValue(null)
    renderRead('Read', { file_path: 'C:\\repo\\gone.png' })

    expect(await screen.findByText('Completed')).toBeTruthy()
  })

  it('does not read relative paths', () => {
    const read = vi.spyOn(client, 'invoke')
    renderRead('Read', { file_path: 'target/paper.png' })

    expect(screen.getByText('Completed')).toBeTruthy()
    expect(read).not.toHaveBeenCalled()
  })
})
