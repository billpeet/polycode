import { shell, type BrowserWindow } from 'electron'
import { isOpenableExternalUrl } from './external-url'
import { sendToRenderer } from './app-events'

/** Contains launch failures even when navigation handlers discard the promise. */
export async function openExternalLink(window: BrowserWindow, url: string): Promise<void> {
  try {
    if (!isOpenableExternalUrl(url)) {
      throw new Error('Only HTTP, HTTPS and mail links can be opened. Local file links are not supported.')
    }
    await shell.openExternal(url)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn('[shell] Could not open link:', message)
    sendToRenderer(window, 'shell:open-external-failed', message)
  }
}
