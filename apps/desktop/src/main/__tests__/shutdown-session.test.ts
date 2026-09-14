import type { BrowserWindow } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { Session } from '../session/session'
import { resetAppLifecycleForTest, shutdownApp, waitForAppOperations } from '../app-lifecycle'

const h = vi.hoisted(() => ({
  title: vi.fn(), write: vi.fn(), emit: vi.fn(),
  onSessionId: null as null | ((id: string) => void),
}))
vi.mock('electron', () => ({}))
vi.mock('../driver/claude', () => ({
  ClaudeDriver: class {
    constructor(options: { onSessionId: (id: string) => void }) { h.onSessionId = options.onSessionId }
    isRunning() { return false }
    sendMessage() {}
    getPid() { return null }
    stop() {}
  },
}))
vi.mock('../driver/codex', () => ({ CodexDriver: class {} }))
vi.mock('../driver/opencode', () => ({ OpenCodeDriver: class {} }))
vi.mock('../driver/pi', () => ({ PiDriver: class {} }))
vi.mock('../driver/cursor', () => ({ CursorDriver: class {} }))
vi.mock('../driver/grok', () => ({ GrokDriver: class {} }))
vi.mock('../system-text', () => ({ generateTitle: (...args: unknown[]) => h.title(...args) }))
vi.mock('../thread-logger', () => ({ logThreadEvent: () => {} }))
vi.mock('../app-events', () => ({ emitAppEvent: (...args: unknown[]) => h.emit(...args) }))
vi.mock('../db/queries', () => new Proxy({
  getOrCreateActiveSession: () => ({ id: 'session-1', claude_session_id: null }),
  getThreadProvider: () => 'claude',
  getThreadModel: () => 'sonnet',
  cancelPendingToolCalls: () => [],
}, {
  has: () => true,
  get: (target, key) => {
    if (key === 'then') return undefined
    if (key in target) return target[key as keyof typeof target]
    return (...args: unknown[]) => h.write(key, ...args)
  },
}))

afterEach(() => {
  resetAppLifecycleForTest()
  vi.clearAllMocks()
  h.write.mockReset()
})

it('drops late auto-title and provider session-id writes after the session is stopped', async () => {
  let release!: (value: string) => void
  h.title.mockImplementation(() => new Promise<string>((resolve) => { release = resolve }))
  const session = new Session('thread-1', '/repo', {} as BrowserWindow)
  session.sendMessage('initial prompt')
  await shutdownApp({
    stopProducers: () => session.forceReset(),
    awaitProducers: waitForAppOperations,
    closeDatabase: () => h.write.mockImplementation(() => { throw new Error('Database is closed') }),
    finish: () => {},
  })
  h.write.mockClear()
  h.emit.mockClear()
  release('Late generated title')
  h.onSessionId?.('late-session-id')
  await Promise.resolve()
  expect(h.write).not.toHaveBeenCalled()
  expect(h.emit).not.toHaveBeenCalled()
})

it('persists generated titles during normal operation', async () => {
  h.write.mockReset()
  h.title.mockResolvedValue('Generated title')
  const session = new Session('thread-1', '/repo', {} as BrowserWindow)
  session.sendMessage('initial prompt')
  await Promise.resolve()
  expect(h.write).toHaveBeenCalledWith('updateThreadName', 'thread-1', 'Generated title')
})
