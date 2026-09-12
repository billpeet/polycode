import { client } from './client'

/**
 * UI preferences: which project and thread were open, sidebar width, layout mode, and
 * the like. They describe *this client's* view, so they belong to the client, not to
 * the host — a browser driving a Remote Host must not overwrite the desktop's selection.
 *
 * In Electron they live where they always have, in the host's `settings` table. In a
 * browser they live in `localStorage`, scoped to the page origin (one host per origin).
 *
 * Only the keys listed here go through this module; anything else the renderer keeps in
 * `settings:*` is host state and stays on the direct channel.
 */
export type PrefKey =
  | 'selectedProjectId'
  | 'selectedThreadId'
  | 'sidebar:viewMode'
  | 'sidebar:width'
  | 'layout:mode'
  | 'projects:sortMode'
  | 'favourites:combos'
  /**
   * A path on the host, so strictly host state; kept browser-local anyway rather than
   * widen `settings:get` to remote callers, which would expose every key it holds.
   */
  | 'default_source_dir'

const STORAGE_PREFIX = 'polycode:pref:'

function storageKey(key: PrefKey): string {
  return `${STORAGE_PREFIX}${key}`
}

export async function getPref(key: PrefKey): Promise<string | null> {
  if (client.kind === 'electron') {
    return client.invoke('settings:get', key)
  }
  return localStorage.getItem(storageKey(key))
}

export async function setPref(key: PrefKey, value: string): Promise<void> {
  if (client.kind === 'electron') {
    await client.invoke('settings:set', key, value)
    return
  }
  localStorage.setItem(storageKey(key), value)
}
