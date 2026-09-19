import type { BrowserWindow } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import type { OutputEvent } from '../../shared/types'
import { Session } from '../session/session'

const h = vi.hoisted(() => ({
  answer: vi.fn(), write: vi.fn(), emit: vi.fn(),
  event: null as null | ((event: OutputEvent) => void),
}))
vi.mock('electron', () => ({}))
vi.mock('../driver/kimi', () => ({ KimiDriver: class {
  isRunning() { return false }
  sendMessage(_content: string, onEvent: (event: OutputEvent) => void) { h.event = onEvent }
  getPid() { return null }
  stop() {}
  answerStructuredQuestion = h.answer
} }))
vi.mock('../driver/claude', () => ({ ClaudeDriver: class {} }))
vi.mock('../driver/codex', () => ({ CodexDriver: class {} }))
vi.mock('../driver/opencode', () => ({ OpenCodeDriver: class {} }))
vi.mock('../driver/pi', () => ({ PiDriver: class {} }))
vi.mock('../driver/cursor', () => ({ CursorDriver: class {} }))
vi.mock('../driver/grok', () => ({ GrokDriver: class {} }))
vi.mock('../system-text', () => ({ generateTitle: () => Promise.resolve('Title') }))
vi.mock('../thread-logger', () => ({ logThreadEvent: () => {} }))
vi.mock('../app-events', () => ({ emitAppEvent: (...args: unknown[]) => h.emit(...args) }))
vi.mock('../db/queries', () => new Proxy({
  getOrCreateActiveSession: () => ({ id: 'session-1', claude_session_id: null }),
  getThreadProvider: () => 'kimi-code', getThreadModel: () => 'default',
  getThreadById: () => ({ kimi_thinking: 'on' }), cancelPendingToolCalls: () => [],
}, {
  has: () => true,
  get: (target, key) => {
    if (key === 'then') return undefined
    if (key in target) return target[key as keyof typeof target]
    return (...args: unknown[]) => h.write(key, ...args)
  },
}))
afterEach(() => { vi.clearAllMocks(); h.answer.mockReset() })
function pendingQuestion() {
  const session = new Session('thread-1', '/repo', {} as BrowserWindow)
  session.sendMessage('Ask me')
  h.event!({ type: 'question', content: '', metadata: { requestId: 'request-1', questions: [
    { id: 'q0', question: 'Pick', header: 'Pick', multiSelect: true, allowComments: false, options: [{ label: 'A, B', description: '' }, { label: 'C', description: '' }] },
  ] } })
  h.write.mockClear()
  return session
}
it('delivers structured arrays by field ID through Session without splitting labels', () => {
  const session = pendingQuestion()
  session.answerQuestion({ q0: ['A, B', 'C'] })
  expect(h.answer).toHaveBeenCalledExactlyOnceWith('request-1', { q0: ['A, B', 'C'] })
  expect(h.write).toHaveBeenCalledWith('updateThreadStatus', 'thread-1', 'running')
})
it('leaves the interaction pending when typed answer validation fails', () => {
  const session = pendingQuestion()
  h.answer.mockImplementation(() => { throw new Error('Choose an offered option') })
  expect(() => session.answerQuestion({ q0: ['Other'] })).toThrow('offered option')
  expect(h.write).not.toHaveBeenCalled()
  h.answer.mockReset()
  session.answerQuestion({ q0: ['C'] })
  expect(h.answer).toHaveBeenCalledWith('request-1', { q0: ['C'] })
})
it('rejects comments the provider form cannot represent instead of silently dropping them', () => {
  const session = pendingQuestion()
  expect(() => session.answerQuestion({ q0: ['C'] }, {}, 'Extra')).toThrow('without comments')
  expect(h.answer).not.toHaveBeenCalled()
  expect(h.write).not.toHaveBeenCalled()
})
