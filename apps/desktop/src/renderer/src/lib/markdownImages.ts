import { Renderer, type Tokens } from 'marked'
import { client } from './client'
import { markdownFilePathFromHref } from './markdownFileLinks'
import { escapeAttr } from './markdownLinkRenderer'

export function renderMarkdownImage(this: Renderer, token: Tokens.Image): string {
  const path = markdownFilePathFromHref(token.href)
  if (!path) return Renderer.prototype.image.call(this, token)

  const encodedPath = escapeAttr(encodeURIComponent(path))
  const title = token.title ? ` title="${escapeAttr(token.title)}"` : ''
  return `<a href="#" data-file-path="${encodedPath}"><img data-image-path="${encodedPath}" alt="${escapeAttr(token.text)}"${title}></a>`
}

/** Resolve local images after sanitizing, using the same reader as the file panel. */
export function loadMarkdownImages(container: HTMLElement): () => void {
  let cancelled = false
  const reads = new Map<string, ReturnType<typeof readImage>>()
  function readImage(path: string) {
    return client.invoke('files:read', path)
  }
  for (const image of container.querySelectorAll<HTMLImageElement>('img[data-image-path]')) {
    const path = markdownFilePathFromHref(image.dataset.imagePath ?? '')
    if (!path) continue
    let read = reads.get(path)
    if (!read) {
      read = readImage(path)
      reads.set(path, read)
    }
    void read.then((file) => {
      if (cancelled) return
      if (file?.mimeType?.startsWith('image/') && file.dataUrl?.startsWith(`data:${file.mimeType};base64,`)) {
        image.src = file.dataUrl
      } else {
        image.replaceWith(document.createTextNode(image.alt || 'Image unavailable'))
      }
    }).catch(() => {
      if (!cancelled) image.replaceWith(document.createTextNode(image.alt || 'Image unavailable'))
    })
  }
  return () => { cancelled = true }
}
