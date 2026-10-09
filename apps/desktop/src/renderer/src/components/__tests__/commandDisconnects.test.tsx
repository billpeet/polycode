// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import CommandLogs from '../CommandLogs'
import ToastStack from '../Toast'
import CommandsEditModal from '../CommandsEditModal'
import { useProjectStore } from '../../stores/projects'
import { useLocationStore } from '../../stores/locations'
import CommandsSection from '../right-panel/CommandsSection'
import { useCommandStore } from '../../stores/commands'
import { useThreadStore } from '../../stores/threads'
import { useToastStore } from '../../stores/toast'
import type { ProjectCommand, Thread } from '../../types/ipc'

const { invoke, write, reset, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(), write: vi.fn(), reset: vi.fn(),
  listeners: new Map<string, Set<(...args: unknown[]) => void>>(),
}))
vi.mock('../../lib/client', () => ({ client: {
  capabilities: { browserPanel: false }, invoke,
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const callbacks = listeners.get(channel) ?? new Set()
    callbacks.add(callback)
    listeners.set(channel, callbacks)
    return () => callbacks.delete(callback)
  },
} }))
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  write = write
  reset = reset
  loadAddon() {}
  open() {}
  attachCustomKeyEventHandler() {}
  dispose() {}
} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }))
vi.mock('../../lib/xtermLinks', () => ({ registerUrlLinks: () => ({ dispose() {} }) }))

const key = 'cmd:loc'
const command = { id: 'cmd', project_id: 'p', name: 'Server', command: 'npm start' } as ProjectCommand
const cached = [{ text: 'cached output', stream: 'stdout', timestamp: 'now' }] as never[]
beforeEach(() => {
  vi.stubGlobal('React', React)
  invoke.mockReset().mockRejectedValue(new Error('[REMOTE_UNAVAILABLE] offline'))
  write.mockClear()
  reset.mockClear()
  listeners.clear()
  useCommandStore.setState({
    byProject: { p: [command] }, statusMap: { [key]: 'running' },
    logsByCommand: { [key]: cached }, portsMap: { [key]: [3000] },
    selectedInstanceByLocation: { loc: key }, pinnedInstancesByLocation: {},
  })
  useThreadStore.setState({
    selectedThreadId: 't', unreadByThread: {},
    byProject: { p: [{ id: 't', project_id: 'p', location_id: 'loc' } as Thread] },
    archivedByProject: {},
  })
  useProjectStore.setState({ projects: [{ id: 'p', name: 'Project' } as never] })
  useLocationStore.setState({ byProject: { p: [] } })
  useToastStore.setState({ toasts: [] })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('settles panel reads, retains cached output and ports, and survives cleanup before rejection', async () => {
  const view = render(<><CommandsSection threadId="t" /><CommandLogs /></>)
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  for (const channel of ['commands:list', 'commands:getStatus', 'commands:getLogs', 'commands:getPid', 'commands:getPorts']) {
    expect(invoke.mock.calls.some(([name]) => name === channel)).toBe(true)
  }
  expect(write).toHaveBeenCalledWith(expect.stringContaining('cached output'))
  expect(useCommandStore.getState().logsByCommand[key]).toBe(cached)
  expect(useCommandStore.getState().portsMap[key]).toEqual([3000])
  view.unmount()
  const rejects: Array<(error: Error) => void> = []
  invoke.mockImplementation(() => new Promise((_, fail) => { rejects.push(fail) }))
  const lateView = render(<CommandLogs />)
  lateView.unmount()
  write.mockClear()
  await act(async () => { rejects.forEach((reject) => reject(new Error('[REMOTE_UNAVAILABLE] offline'))) })
  expect(write).not.toHaveBeenCalled()
  // Vitest fails if any rejected effect/event promise escapes as an unhandled rejection.
})

it.each(['section', 'logs'].flatMap((view) =>
  ['start', 'stop', 'restart'].map((action) => ({ view, action })),
))('handles $action from $view with rollback and a visible connectivity result', async ({ view, action }) => {
  const previous = action === 'start' ? 'idle' : 'running'
  useCommandStore.setState({ statusMap: { [key]: previous } })
  const rendered = render(<>{view === 'section' ? <CommandsSection threadId="t" /> : <CommandLogs />}<ToastStack /></>)
  await act(async () => {})
  const label = action.charAt(0).toUpperCase() + action.slice(1)
  const button = view === 'section' ? rendered.getByRole('button', { name: label }) : rendered.getByTitle(label)
  fireEvent.click(button)
  await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1))
  expect(rendered.getByText(/Remote host connection lost/)).toBeTruthy()
  expect(useCommandStore.getState().statusMap[key]).toBe(previous)
  expect(useCommandStore.getState().logsByCommand[key]).toBe(cached)
  expect(reset).not.toHaveBeenCalled()
  expect(invoke.mock.calls.filter(([channel]) => channel === `commands:${action}`)).toHaveLength(1)
})

it('settles both unread event boundaries during a disconnect', async () => {
  useThreadStore.setState({ selectedThreadId: null, unreadByThread: { t: true } })
  useThreadStore.getState().select('t')
  useThreadStore.getState().setUnread('other', true)
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  expect(invoke).toHaveBeenCalledWith('threads:setUnread', 't', false)
  expect(invoke).toHaveBeenCalledWith('threads:setUnread', 'other', true)
})

it('retains the loaded PID through a failed refresh and resets output only for backend restart events', async () => {
  invoke.mockImplementation(async (channel: string) => channel === 'commands:getPid' ? 321 : [])
  const view = render(<CommandLogs />)
  await waitFor(() => expect(view.getByText('321')).toBeTruthy())
  invoke.mockRejectedValue(new Error('[REMOTE_UNAVAILABLE] offline'))
  await act(async () => { useCommandStore.getState().setStatus(key, 'stopping') })
  expect(view.getByText('321')).toBeTruthy()
  await act(async () => { useCommandStore.getState().setStatus(key, 'running') })
  expect(reset).not.toHaveBeenCalled()
  for (const status of ['stopping', 'stopped', 'running']) {
    await act(async () => { listeners.get(`command:status:${key}`)?.forEach((callback) => callback(status)) })
  }
  expect(reset).toHaveBeenCalledTimes(1)
})

it('settles command-editor hydration and handles deletion failures', async () => {
  const view = render(<><CommandsEditModal projectId="p" onClose={() => {}} /><ToastStack /></>)
  await act(async () => {})
  fireEvent.click(view.getByTitle('Remove command'))
  await waitFor(() => expect(view.getByText(/Remote host connection lost/)).toBeTruthy())
  expect(useCommandStore.getState().byProject.p).toEqual([command])
  expect(invoke.mock.calls.filter(([channel]) => channel === 'commands:delete')).toHaveLength(1)
})

it('distinguishes an unstarted busy refusal from an ambiguous disconnect without retrying', async () => {
  invoke.mockRejectedValue(new Error('RemoteHostBusyError: [REMOTE_REQUEST_TIMEOUT] This request was not started'))
  useCommandStore.setState({ statusMap: { [key]: 'idle' } })
  const view = render(<><CommandsSection threadId="t" /><ToastStack /></>)
  fireEvent.click(view.getByRole('button', { name: 'Start' }))
  await waitFor(() => expect(view.getByText(/The command was not started/)).toBeTruthy())
  expect(useCommandStore.getState().statusMap[key]).toBe('idle')
  expect(invoke.mock.calls.filter(([channel]) => channel === 'commands:start')).toHaveLength(1)
})
