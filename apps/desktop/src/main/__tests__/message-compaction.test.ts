import { describe, expect, it } from 'vitest'
import { foldMessages, type Message } from '@polycode/shared'

function thinkingMessage(id: string, content: string, itemId: string, summaryIndex: number): Message {
  return {
    id,
    thread_id: 'thread-1',
    session_id: 'session-1',
    role: 'assistant',
    content,
    metadata: JSON.stringify({
      type: 'thinking',
      source: 'codex_reasoning_summary',
      turn_id: 'turn-1',
      item_id: itemId,
      summary_index: summaryIndex,
    }),
    created_at: `2026-07-13T00:00:0${id}.000Z`,
  }
}

describe('message compaction', () => {
  it('keeps consecutive assistant messages from different agent scopes separate', () => {
    const messages: Message[] = [
      {
        id: '1',
        thread_id: 'thread-1',
        session_id: 'session-1',
        role: 'assistant',
        content: 'Main agent',
        metadata: null,
        created_at: '2026-07-13T00:00:01.000Z',
      },
      {
        id: '2',
        thread_id: 'thread-1',
        session_id: 'session-1',
        role: 'assistant',
        content: 'Sub-agent',
        metadata: JSON.stringify({ agent_task_id: 'task-1' }),
        created_at: '2026-07-13T00:00:02.000Z',
      },
    ]

    expect(foldMessages(messages)).toEqual(messages)
  })

  it('keeps claude task lifecycle messages separate', () => {
    const messages: Message[] = [
      {
        id: '1',
        thread_id: 'thread-1',
        session_id: 'session-1',
        role: 'assistant',
        content: 'Subagent started',
        metadata: JSON.stringify({ type: 'thinking', source: 'claude_task', status: 'running' }),
        created_at: '2026-07-13T00:00:01.000Z',
      },
      {
        id: '2',
        thread_id: 'thread-1',
        session_id: 'session-1',
        role: 'assistant',
        content: 'Subagent completed',
        metadata: JSON.stringify({ type: 'thinking', source: 'claude_task', status: 'completed' }),
        created_at: '2026-07-13T00:00:02.000Z',
      },
    ]

    expect(foldMessages(messages)).toEqual(messages)
  })

  it('cleans persisted Codex summary markers and separates distinct summary parts', () => {
    const compacted = foldMessages([
      thinkingMessage('1', 'Reasoning summary updated.', 'reason-1', 0),
      thinkingMessage('2', '**Planning the change**', 'reason-1', 0),
      thinkingMessage('3', ' safely', 'reason-1', 0),
      thinkingMessage('4', '**Running verification**', 'reason-1', 1),
      thinkingMessage('5', '**Reporting results**', 'reason-2', 0),
    ])

    expect(compacted).toHaveLength(1)
    expect(compacted[0].content).toBe(
      '**Planning the change** safely\n\n**Running verification**\n\n**Reporting results**',
    )
  })
})
