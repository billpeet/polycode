// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest'
import { Marked } from 'marked'
import { client } from '../client'
import { loadMarkdownImages, renderMarkdownImage } from '../markdownImages'
import { sanitizeMarkdownHtml } from '../sanitizeMarkdown'
import { handleMarkdownFileLinkClick } from '../markdownFileLinks'

function preview(markdown: string) {
  const parser = new Marked({ renderer: { image: renderMarkdownImage } })
  const container = document.createElement('div')
  container.innerHTML = sanitizeMarkdownHtml(parser.parse(markdown) as string, { codeControls: true })
  return container
}

afterEach(() => vi.restoreAllMocks())

describe('message markdown images', () => {
  it.each([
    ['C:/Temp/evidence/S8-unsaved-override.png', 'C:/Temp/evidence/S8-unsaved-override.png'],
    ['/C:/Temp/my%20image.png', 'C:\\Temp\\my image.png'],
    ['file:///C:/Temp/image.png', 'C:\\Temp\\image.png'],
    ['/tmp/image.png', '/tmp/image.png'],
  ])('loads %s through the file reader and opens the file preview', async (href, path) => {
    const dataUrl = 'data:image/png;base64,aGVsbG8='
    const read = vi.spyOn(client, 'invoke').mockResolvedValue({ content: '', truncated: false, mimeType: 'image/png', dataUrl })
    const container = preview(`![Unsaved override](${href})`)
    loadMarkdownImages(container)
    await vi.waitFor(() => expect(container.querySelector('img')?.src).toBe(dataUrl))
    expect(read).toHaveBeenCalledWith('files:read', path)
    const selectFile = vi.fn()
    const setRightPanelTab = vi.fn()
    expect(handleMarkdownFileLinkClick({ target: container.querySelector('img'), preventDefault: vi.fn() }, { selectFile, setRightPanelTab })).toBe(true)
    expect(selectFile).toHaveBeenCalledWith(path)
    expect(setRightPanelTab).toHaveBeenCalledWith('files')
  })

  it('preserves web images without reading a file and strips unsafe sources', () => {
    const read = vi.spyOn(client, 'invoke')
    const container = preview('![web](https://example.com/image.png) ![unsafe](javascript:alert%281%29)')
    loadMarkdownImages(container)
    expect(container.querySelector('img')?.src).toBe('https://example.com/image.png')
    expect(container.querySelectorAll('img')[1].hasAttribute('src')).toBe(false)
    expect(read).not.toHaveBeenCalled()
  })

  it('keeps a readable, clickable fallback for a missing image', async () => {
    vi.spyOn(client, 'invoke').mockResolvedValue(null)
    const container = preview('![Missing evidence](C:/missing.png)')
    loadMarkdownImages(container)
    await vi.waitFor(() => expect(container.querySelector('img')).toBeNull())
    expect(container.querySelector('a')?.textContent).toBe('Missing evidence')
  })

  it('ignores a pending read after the content changes', async () => {
    let resolve!: (value: null) => void
    vi.spyOn(client, 'invoke').mockReturnValue(new Promise<null>((done) => { resolve = done }))
    const container = preview('![Evidence](C:/image.png)')
    const cancel = loadMarkdownImages(container)
    cancel()
    resolve(null)
    await Promise.resolve()
    expect(container.querySelector('img')).not.toBeNull()
  })
})
