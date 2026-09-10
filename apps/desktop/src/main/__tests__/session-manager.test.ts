import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const writers = vi.hoisted(() => new Set<string>())
vi.mock('../session/session', () => ({
  Session: class {
    constructor(private threadId: string) {
      if (writers.has(threadId)) throw new Error(`thread ${threadId} already has an active writer`)
      writers.add(threadId)
    }
    isRunning() { return false }
    transportChanged() { return false }
    stop() { writers.delete(this.threadId) }
    forceReset() { writers.delete(this.threadId) }
  },
}))

import { sessionManager } from '../session/manager'

afterEach(() => {
  sessionManager.stopAll()
  writers.clear()
})

describe('session writer ownership', () => {
  it('releases an idle provider before model change or archive restoration resumes it', () => {
    const window = {} as BrowserWindow
    sessionManager.getOrCreate('thread-1', '/repo', window)
    sessionManager.remove('thread-1')
    expect(() => sessionManager.getOrCreate('thread-1', '/repo', window)).not.toThrow()
  })

  it('releases idle providers on shutdown', () => {
    sessionManager.getOrCreate('thread-1', '/repo', {} as BrowserWindow)
    sessionManager.stopAll()
    expect(writers.size).toBe(0)
  })
})
