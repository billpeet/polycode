import { beforeEach, describe, expect, it } from 'bun:test'
import { useMessageStore } from '../messages'
import { groupByAgent } from '../../components/MessageStream'
import type { OutputEvent } from '../../types/ipc'

const THREAD = 'thread-1'

function thinking(content: string, metadata: Record<string, unknown>): OutputEvent {
  return { type: 'thinking', content, metadata }
}

describe('message store streaming merge', () => {
  beforeEach(() => {
    useMessageStore.setState({ messagesByThread: {}, messagesBySession: {} })
  })

  it('merges consecutive same-scope regular thinking bubbles', () => {
    const meta = { type: 'thinking', agent_scope: 'subagent', agent_parent_tool_use_id: 'X' }
    useMessageStore.getState().appendEvent(THREAD, thinking('Hello ', meta))
    useMessageStore.getState().appendEvent(THREAD, thinking('world', meta))
    const msgs = useMessageStore.getState().messagesByThread[THREAD]
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('Hello world')
  })

  it('does not let a sub-agent tool_result clobber the completed notification (shared tool_use_id)', () => {
    // The Agent/Task tool_call, the sub-agent transcript, its terminal notification (which
    // carries the SAME tool_use_id as the Agent call), then the main-scope tool_result for
    // that Agent call. The tool_result must NOT merge into / overwrite the notification.
    const evs: OutputEvent[] = [
      { type: 'tool_call', content: 'Agent', metadata: { type: 'tool_call', id: 'AG', name: 'Agent', input: {}, agent_scope: 'main' } },
      thinking('sub thinking', { type: 'thinking', agent_scope: 'subagent', agent_parent_tool_use_id: 'AG', agent_subagent_type: 'Explore', agent_status: 'running' }),
      { type: 'text', content: 'here is the answer', metadata: { agent_scope: 'subagent', agent_parent_tool_use_id: 'AG', agent_status: 'running' } },
      thinking('**Subagent completed:** here is the answer', { type: 'thinking', source: 'claude_task', task_event: 'notification', status: 'completed', tool_use_id: 'AG', usage: { total_tokens: 500, tool_uses: 1 }, agent_scope: 'subagent', agent_parent_tool_use_id: 'AG', agent_status: 'completed' }),
      { type: 'tool_result', content: 'here is the answer\nagentId: ...', metadata: { type: 'tool_result', tool_use_id: 'AG', is_error: false, agent_scope: 'main' } },
    ]
    for (const e of evs) useMessageStore.getState().appendEvent(THREAD, e)

    const msgs = useMessageStore.getState().messagesByThread[THREAD]
    // The notification survives as a distinct subagent thinking message.
    const notif = msgs.find((m) => { try { return JSON.parse(m.metadata || 'null')?.task_event === 'notification' } catch { return false } })
    expect(notif).toBeTruthy()

    const group = groupByAgent(msgs).find((e) => e.kind === 'agent')
    if (!group || group.kind !== 'agent') throw new Error('expected agent group')
    expect(group.status).toBe('completed')
  })

  it('still merges consecutive tool_result streaming chunks for the same tool_use_id', () => {
    const call: OutputEvent = { type: 'tool_call', content: 'Bash', metadata: { type: 'tool_call', id: 'b1', name: 'Bash', input: {} } }
    const chunk1: OutputEvent = { type: 'tool_result', content: 'line 1\n', metadata: { type: 'tool_result', tool_use_id: 'b1', is_error: false } }
    const chunk2: OutputEvent = { type: 'tool_result', content: 'line 1\nline 2', metadata: { type: 'tool_result', tool_use_id: 'b1', is_error: false } }
    for (const e of [call, chunk1, chunk2]) useMessageStore.getState().appendEvent(THREAD, e)
    const results = useMessageStore.getState().messagesByThread[THREAD].filter((m) => {
      try { return JSON.parse(m.metadata || 'null')?.type === 'tool_result' } catch { return false }
    })
    expect(results).toHaveLength(1)
    expect(results[0].content).toBe('line 1\nline 2')
  })

  it('does NOT merge task lifecycle bubbles, so the group derives completed status', () => {
    const base = { agent_scope: 'subagent', agent_parent_tool_use_id: 'X', agent_subagent_type: 'Plan' }
    // A regular sub-agent thinking, then a progress bubble, then the terminal notification —
    // all adjacent, same scope, all type 'thinking'.
    useMessageStore.getState().appendEvent(THREAD, thinking('reasoning about the plan', { type: 'thinking', ...base, agent_status: 'running' }))
    useMessageStore.getState().appendEvent(THREAD, thinking('**Subagent update:** …', { type: 'thinking', source: 'claude_task', task_event: 'progress', usage: { total_tokens: 1000, tool_uses: 1 }, ...base, agent_status: 'running' }))
    useMessageStore.getState().appendEvent(THREAD, thinking('**Subagent completed:** …', { type: 'thinking', source: 'claude_task', task_event: 'notification', status: 'completed', usage: { total_tokens: 2000, tool_uses: 2 }, ...base, agent_status: 'completed' }))

    const msgs = useMessageStore.getState().messagesByThread[THREAD]
    // The progress and notification bubbles must remain distinct (not merged into one).
    expect(msgs.length).toBe(3)

    // And the derived group must be completed (metadata preserved).
    const anchor: OutputEvent = { type: 'tool_call', content: 'Task', metadata: { type: 'tool_call', id: 'X', name: 'Task', input: {}, agent_scope: 'main' } }
    // Prepend the anchor so the group is spliced at the Task tool_call.
    useMessageStore.setState({ messagesByThread: {} })
    useMessageStore.getState().appendEvent(THREAD, anchor)
    for (const e of [
      thinking('reasoning', { type: 'thinking', ...base, agent_status: 'running' }),
      thinking('**Subagent update:** …', { type: 'thinking', source: 'claude_task', task_event: 'progress', usage: { total_tokens: 1000, tool_uses: 1 }, ...base, agent_status: 'running' }),
      thinking('**Subagent completed:** …', { type: 'thinking', source: 'claude_task', task_event: 'notification', status: 'completed', usage: { total_tokens: 2000, tool_uses: 2 }, ...base, agent_status: 'completed' }),
    ]) {
      useMessageStore.getState().appendEvent(THREAD, e)
    }
    const group = groupByAgent(useMessageStore.getState().messagesByThread[THREAD]).find((x) => x.kind === 'agent')
    if (!group || group.kind !== 'agent') throw new Error('expected agent group')
    expect(group.status).toBe('completed')
    expect(group.usage?.totalTokens).toBe(2000)
  })
})
