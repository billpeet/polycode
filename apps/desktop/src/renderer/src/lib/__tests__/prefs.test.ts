import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPref, setPref } from '../prefs'

afterEach(() => vi.unstubAllGlobals())

describe('prefs under Electron', () => {
  it('reads and writes the host settings table on the channels the app always used', async () => {
    const invoke = vi.fn().mockResolvedValue('full')
    vi.stubGlobal('window', { api: { invoke } })

    await expect(getPref('layout:mode')).resolves.toBe('full')
    await setPref('layout:mode', 'split')

    expect(invoke).toHaveBeenCalledWith('settings:get', 'layout:mode')
    expect(invoke).toHaveBeenCalledWith('settings:set', 'layout:mode', 'split')
  })
})

describe('prefs in a browser', () => {
  function fakeStorage(): Storage {
    const map = new Map<string, string>()
    return {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
      clear: () => map.clear(),
      key: () => null,
      get length() { return map.size },
    }
  }

  it('keeps preferences in localStorage and never touches the host', async () => {
    const storage = fakeStorage()
    vi.stubGlobal('window', {})
    vi.stubGlobal('localStorage', storage)

    await expect(getPref('selectedThreadId')).resolves.toBeNull()
    await setPref('selectedThreadId', 'thread-1')

    await expect(getPref('selectedThreadId')).resolves.toBe('thread-1')
    expect(storage.getItem('polycode:pref:selectedThreadId')).toBe('thread-1')
  })
})
