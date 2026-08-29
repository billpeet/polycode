/**
 * Writes text without leaking clipboard failures as unhandled rejections.
 *
 * Chromium can reject an otherwise valid clipboard write when the document loses
 * focus between the user gesture and the write. Electron's main-process clipboard
 * does not have that focus restriction, so use it as the fallback.
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      await window.api.invoke('clipboard:writeText', text)
      return true
    } catch {
      return false
    }
  }
}
