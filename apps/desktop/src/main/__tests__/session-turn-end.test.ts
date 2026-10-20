import type { BrowserWindow } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import type { OutputEvent } from '../../shared/types'
import { Session } from '../session/session'

/**
 * What a Session saves when a Turn ends: output whose final result never came, and a
 * cancelled result for every tool call left without one. Transient output (Codex
 * command deltas) streams to clients but is not saved one row per piece; the item's
 * final result is the record. The driver is irrelevant to this, so a stub stands in.
 */
const h = vi.hoisted(() => ({
  write: vi.fn(),
  emit: vi.fn(),
  findUnanswered: vi.fn((): string[] => []),
  insertCancelled: vi.fn((_threadId: string, _sessionId: string, ids: string[]) =>
    ids.map((id) => ({ id: `cancel-${id}`, metadata: JSON.stringify({ type: 'tool_result', tool_use_id: id, cancelled: true }) }))),
  event: null as null | ((event: OutputEvent) => void),
  done: null as null | ((error?: Error) => void),
}))
vi.mock('electron', () => ({}))
vi.mock('../driver/kimi', () => ({ KimiDriver: class {
  isRunning() { return false }
  sendMessage(_content: string, onEvent: (event: OutputEvent) => void, onDone: (error?: Error) => void) {
    h.event = onEvent
    h.done = onDone
  }
  getPid() { return null }
  stop() {}
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
  getThreadById: () => ({}),
  findUnansweredToolCalls: (...args: unknown[]) => h.findUnanswered(...args),
  insertCancelledToolResults: (...args: unknown[]) => h.insertCancelled(...args),
}, {
  has: () => true,
  get: (target, key) => {
    if (key === 'then') return undefined
    if (key in target) return target[key as keyof typeof target]
    return (...args: unknown[]) => h.write(key, ...args)
  },
}))
afterEach(() => { vi.clearAllMocks() })

function startTurn() {
  const session = new Session('thread-1', '/repo', {} as BrowserWindow)
  const frames: OutputEvent[] = []
  h.emit.mockImplementation((_window: unknown, channel: string, frame: OutputEvent) => {
    if (channel === 'thread:output:thread-1') frames.push(frame)
  })
  session.sendMessage('Run it')
  h.write.mockClear()
  return { session, frames }
}

const delta = (content: string): OutputEvent => ({
  type: 'tool_result', content, metadata: { type: 'tool_result', tool_use_id: 'cmd-1' }, transient: true,
})
const final = (content: string): OutputEvent => ({
  type: 'tool_result', content, metadata: { type: 'tool_result', tool_use_id: 'cmd-1', status: 'completed' },
})
const savedRows = () => h.write.mock.calls.filter(([name]) => name === 'insertMessage').map(([, ...args]) => args)

it('streams output pieces without saving them, then saves the final result once', () => {
  const { frames } = startTurn()
  h.event!(delta('a\n'))
  h.event!(delta('b\n'))
  expect(savedRows()).toEqual([])
  expect(frames.map((frame) => frame.content)).toEqual(['a\n', 'b\n'])
  expect(frames.every((frame) => frame.eventId === undefined)).toBe(true)

  h.event!(final('a\nb\n'))
  expect(savedRows()).toEqual([
    ['thread-1', 'assistant', 'a\nb\n', { type: 'tool_result', tool_use_id: 'cmd-1', status: 'completed' }, 'session-1', expect.any(String)],
  ])
  expect(frames[2]).toMatchObject({ content: 'a\nb\n', eventId: savedRows()[0][5] })
})

it('keeps the streamed output when the final result reports less of it', () => {
  const { frames } = startTurn()
  h.event!(delta('partial output that Codex dropped'))
  h.event!(final(''))
  expect(savedRows()[0][2]).toBe('partial output that Codex dropped')
  expect(frames[1].content).toBe('partial output that Codex dropped')
})

it('saves output whose final result never came when the Turn ends', () => {
  startTurn()
  h.event!(delta('still '))
  h.event!(delta('running'))
  h.done!()
  expect(savedRows()).toEqual([
    ['thread-1', 'assistant', 'still running', { type: 'tool_result', tool_use_id: 'cmd-1' }, 'session-1'],
  ])
})

it('saves output streamed before the user stopped the Turn', () => {
  const { session } = startTurn()
  h.event!(delta('half'))
  session.stop()
  h.event!(delta(' ignored after stop'))
  h.done!()
  expect(savedRows()).toEqual([
    ['thread-1', 'assistant', 'half', { type: 'tool_result', tool_use_id: 'cmd-1' }, 'session-1'],
  ])
})

const toolCall = (id: string): OutputEvent => ({ type: 'tool_call', content: 'Bash', metadata: { type: 'tool_call', id, name: 'Bash', input: {} } })
const result = (id: string): OutputEvent => ({ type: 'tool_result', content: 'ok', metadata: { type: 'tool_result', tool_use_id: id } })
const cancelledIds = () => h.insertCancelled.mock.calls.map(([, , ids]) => ids)

it('cancels only the tool calls left without a result when the Turn ends', () => {
  const { frames } = startTurn()
  h.event!(toolCall('a'))
  h.event!(toolCall('b'))
  h.event!(result('a'))
  h.done!()
  expect(cancelledIds()).toEqual([['b']])
  expect(frames.at(-1)).toMatchObject({ type: 'tool_result', metadata: { tool_use_id: 'b', cancelled: true }, eventId: 'cancel-b' })
})

it('asks the database for calls an earlier run left pending only on the first Turn of a session', () => {
  h.findUnanswered.mockReturnValueOnce(['from-a-crash'])
  const { session } = startTurn()
  h.event!(toolCall('a'))
  h.done!()
  expect(h.findUnanswered).toHaveBeenCalledTimes(1)
  expect(cancelledIds()).toEqual([['a', 'from-a-crash']])

  h.insertCancelled.mockClear()
  session.sendMessage('Again')
  h.event!(toolCall('c'))
  h.event!(result('c'))
  h.done!()
  expect(h.findUnanswered).toHaveBeenCalledTimes(1)
  expect(cancelledIds()).toEqual([[]])
})

it('does not cancel a call whose output was saved because its final result never came', () => {
  startTurn()
  h.event!(toolCall('cmd-1'))
  h.event!(delta('half'))
  h.done!()
  expect(cancelledIds()).toEqual([[]])
})
