import { beforeEach, describe, expect, it } from 'bun:test'
import { extractTodosFromMessages, useTodoStore, type Todo } from '../todos'
import type { Message } from '../../types/ipc'

function makeMessage(content: string, metadata: Record<string, unknown> | null): Message {
  return {
    id: `${content}-${Math.random()}`,
    thread_id: 'thread-1',
    session_id: null,
    role: 'assistant',
    content,
    metadata: metadata ? JSON.stringify(metadata) : null,
    created_at: new Date().toISOString(),
  }
}

describe('todo store extraction', () => {
  beforeEach(() => {
    useTodoStore.setState({ todosByThread: {} })
  })

  it('prefers the latest Codex todo_list result so completed items are preserved', () => {
    const messages: Message[] = [
      makeMessage('todo_list', {
        type: 'tool_call',
        items: [
          { text: 'First task', completed: false },
          { text: 'Second task', completed: false },
        ],
      }),
      makeMessage('', {
        type: 'tool_result',
        tool_use_id: 'item_1',
        items: [
          { text: 'First task', completed: true },
          { text: 'Second task', completed: true },
        ],
      }),
    ]

    expect(extractTodosFromMessages(messages)).toEqual<Todo[]>([
      { content: 'First task', activeForm: '', status: 'completed' },
      { content: 'Second task', activeForm: '', status: 'completed' },
    ])
  })

  it('clears stale todos when the latest persisted messages contain no todo payload', () => {
    useTodoStore.getState().setTodos('thread-1', [
      { content: 'Stale task', activeForm: '', status: 'pending' },
    ])

    useTodoStore.getState().syncFromMessages('thread-1', [
      makeMessage('No todos here', null),
      makeMessage('Done.', { type: 'text' }),
    ])

    expect(useTodoStore.getState().todosByThread['thread-1']).toBeUndefined()
  })
})
