// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { VirtualizerOptions } from '@tanstack/react-virtual'
import MessageStream from '../MessageStream'
import { useMessageStore } from '../../stores/messages'
import { useThreadStore } from '../../stores/threads'
import type { Message } from '../../types/ipc'

// Keep the real virtualizer and range calculation; supply the layout and scroll
// observations that happy-dom cannot calculate.
vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>()
  return {
    ...actual,
    useVirtualizer: (options: VirtualizerOptions<HTMLDivElement, HTMLDivElement>) => actual.useVirtualizer({
      ...options,
      observeElementRect: (_instance, cb) => { cb({ width: 800, height: 300 }) },
      observeElementOffset: (instance, cb) => {
        const el = instance.scrollElement!
        const onScroll = () => cb(el.scrollTop, true)
        el.addEventListener('scroll', onScroll)
        cb(el.scrollTop, false)
        return () => el.removeEventListener('scroll', onScroll)
      },
      measureElement: () => 48,
    }),
  }
})
vi.mock('../renderEntry', () => ({ renderEntry: (entry: { key: string }) => <span>{entry.key}</span> }))
vi.mock('../AgentPrompt', () => ({ default: () => <div>Long agent prompt</div> }))

let headerHeight = 1200
const resizeObservers = new Map<ResizeObserverCallback, Set<Element>>()
beforeEach(() => {
  vi.stubGlobal('React', React)
  resizeObservers.clear()
  vi.stubGlobal('ResizeObserver', class {
    private targets = new Set<Element>()
    constructor(callback: ResizeObserverCallback) { resizeObservers.set(callback, this.targets) }
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { this.targets.clear() }
  })
  headerHeight = 1200
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const scroller = this.closest('.overflow-y-auto') as HTMLElement | null
    const top = this.classList.contains('relative') && scroller ? headerHeight - scroller.scrollTop : 0
    return { top, bottom: top + 48, left: 0, right: 800, width: 800, height: 48, x: 0, y: top, toJSON() {} }
  })
  const message = (id: string, metadata: Record<string, unknown>): Message => ({
    id, thread_id: 'scroll-thread', session_id: 'scroll-session', role: 'assistant',
    content: id, metadata: JSON.stringify(metadata), created_at: '2026-10-15T00:00:00Z',
  })
  useMessageStore.setState({ messagesByThread: {
    'scroll-thread': [
      message('spawn', { type: 'tool_call', id: 'child', name: 'Task', input: { prompt: 'Long agent prompt' } }),
      ...Array.from({ length: 60 }, (_, i) => message(`row-${i}`, {
        type: 'tool_call', id: `tool-${i}`, name: i % 2 ? 'Read' : 'Bash',
        agent_scope: 'subagent', agent_parent_tool_use_id: 'child',
      })),
    ],
  }, messagesBySession: {} })
  useThreadStore.setState({ statusMap: { 'scroll-thread': 'idle' } })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each([false, true])('keeps rows visible below a long isolated-agent prompt, collapse=%s', (collapse) => {
  const view = render(<MessageStream threadId="scroll-thread" agentFilter="agent-child" />)
  const scroller = view.container.querySelector('.overflow-y-auto') as HTMLElement
  if (collapse) {
    headerHeight = 80
    const header = view.container.querySelector('.mb-3')!
    act(() => {
      for (const [callback, targets] of resizeObservers) {
        if (targets.has(header)) callback([], {} as ResizeObserver)
      }
    })
  }
  // The viewport covers rows 2 through 8 after scrolling past the prompt.
  scroller.scrollTop = headerHeight + 2 * 48
  fireEvent.scroll(scroller)
  for (let i = 2; i <= 8; i++) {
    expect(view.container.querySelector(`[data-entry-key="row-${i}"]`), `visible row ${i}`).not.toBeNull()
  }
  const row = view.container.querySelector('[data-entry-key="row-2"]') as HTMLElement
  expect(row.style.transform).toBe('translateY(96px)')
})
