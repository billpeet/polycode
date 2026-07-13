import { describe, expect, it } from 'vitest'
import { compactStreamingMessages } from '../db/queries'
import type { MessageRow } from '../db/models'

function thinkingRow(id: string, content: string, itemId: string, summaryIndex: number): MessageRow {
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
  it('cleans persisted Codex summary markers and separates distinct summary parts', () => {
    const compacted = compactStreamingMessages([
      thinkingRow('1', 'Reasoning summary updated.', 'reason-1', 0),
      thinkingRow('2', '**Planning the change**', 'reason-1', 0),
      thinkingRow('3', ' safely', 'reason-1', 0),
      thinkingRow('4', '**Running verification**', 'reason-1', 1),
      thinkingRow('5', '**Reporting results**', 'reason-2', 0),
    ])

    expect(compacted).toHaveLength(1)
    expect(compacted[0].content).toBe(
      '**Planning the change** safely\n\n**Running verification**\n\n**Reporting results**',
    )
  })
})
