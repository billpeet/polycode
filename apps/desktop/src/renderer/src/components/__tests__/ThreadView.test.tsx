// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appShuttingDownMessage } from '@polycode/shared'
import ThreadView from '../ThreadView'
import { useSessionStore } from '../../stores/sessions'
import { useMessageStore } from '../../stores/messages'
import { useThreadStore } from '../../stores/threads'
import { useRemoteConnectionStore } from '../../stores/remoteConnection'
import { useTodoStore } from '../../stores/todos'

const { invoke, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
}))
vi.mock('../../lib/client', () => ({ client: {
  invoke,
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    listeners.set(channel, callback)
    return () => { listeners.delete(channel) }
  },
} }))
vi.mock('../ThreadHeader', () => ({ default: () => null }))
vi.mock('../SessionTabs', () => ({ default: () => null }))
vi.mock('../AgentTabs', () => ({ default: () => null }))
vi.mock('../MessageStream', () => ({ default: () => null }))
vi.mock('../InputBar', () => ({ default: () => null }))

beforeEach(() => {
  vi.stubGlobal('React', React)
  invoke.mockReset().mockResolvedValue([])
  useThreadStore.setState({ byProject: {}, queuedMessageByThread: {}, selectedThreadId: 't' })
  useSessionStore.setState({ sessionsByThread: { t: [] }, activeSessionByThread: { t: 's' } })
  useMessageStore.setState({ messagesBySession: { s: [] }, messagesByThread: { t: [] } })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each(['mount', 'reconnect', 'complete', 'session-switch'].flatMap((trigger) =>
  [false, true].map((unmount) => ({ trigger, unmount })),
))('settles shutdown during $trigger refreshes, unmount=$unmount, and preserves cached state', async ({ trigger, unmount }) => {
  const cached = useMessageStore.getState().messagesBySession.s
  const sessions = useSessionStore.getState().sessionsByThread.t
  const pending: Array<() => void> = []
  const rejectRefreshes = () => invoke.mockImplementation((channel: string) => {
    if (channel === 'sessions:list' || channel === 'messages:listBySession') {
      return new Promise((_, reject) => pending.push(() => reject(new Error(appShuttingDownMessage()))))
    }
    return Promise.resolve([])
  })
  if (trigger === 'mount') rejectRefreshes()
  const view = render(<ThreadView threadId="t" />)
  await act(async () => {})
  const beforeMessages = trigger === 'mount' ? cached : useMessageStore.getState().messagesBySession.s
  const beforeSessions = trigger === 'mount' ? sessions : useSessionStore.getState().sessionsByThread.t
  if (trigger !== 'mount') {
    rejectRefreshes()
    await act(async () => {
      if (trigger === 'complete') listeners.get('thread:complete:t')!('idle')
      if (trigger === 'session-switch') listeners.get('thread:session-switched:t')!('s')
      if (trigger === 'reconnect') useRemoteConnectionStore.setState((s) => ({ reconnectNonce: s.reconnectNonce + 1 }))
    })
  }
  expect(pending.length).toBeGreaterThan(0)
  if (unmount) view.unmount()
  await act(async () => { pending.forEach((reject) => reject()); await new Promise((resolve) => setTimeout(resolve, 0)) })
  expect(useMessageStore.getState().messagesBySession.s).toBe(beforeMessages)
  expect(useSessionStore.getState().sessionsByThread.t).toBe(beforeSessions)
  // Vitest also fails this test file if any promise escapes as an unhandled rejection.
})

it('does not launch refreshes from a completion callback after cleanup', async () => {
  const view = render(<ThreadView threadId="t" />)
  await act(async () => {})
  const complete = listeners.get('thread:complete:t')!
  view.unmount()
  invoke.mockClear()
  complete('idle')
  expect(invoke).not.toHaveBeenCalled()
})

it('does not rebuild todos after an in-flight transcript refresh outlives the view', async () => {
  const view = render(<ThreadView threadId="t" />)
  await act(async () => {})
  let resolveMessages!: (value: unknown[]) => void
  invoke.mockImplementation((channel: string) => channel === 'messages:listBySession'
    ? new Promise((resolve) => { resolveMessages = resolve }) : Promise.resolve([]))
  const sync = vi.spyOn(useTodoStore.getState(), 'syncFromMessages')
  act(() => listeners.get('thread:complete:t')!('idle'))
  view.unmount()
  await act(async () => { resolveMessages([]) })
  expect(sync).not.toHaveBeenCalled()
})

it.each(['sessions:list', 'messages:listBySession'])('preserves unexpected %s failures through the background boundary', async (channel) => {
  const { settleBackgroundIpc } = await import('../../lib/backgroundIpc')
  const failure = new Error('SQLITE_CORRUPT: database disk image is malformed')
  invoke.mockRejectedValue(failure)
  const operation = channel === 'sessions:list'
    ? useSessionStore.getState().fetch('t')
    : useMessageStore.getState().fetchBySession('s')
  await expect(settleBackgroundIpc(operation)).rejects.toBe(failure)
})
