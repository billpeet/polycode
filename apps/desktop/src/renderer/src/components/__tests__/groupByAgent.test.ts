import { describe, it, expect } from 'vitest'
import { groupByAgent, collectActiveAgents, findAgentGroup, agentStatsLabel } from '../MessageStream'
import type { Message } from '../../types/ipc'

let seq = 0
function msg(
  role: Message['role'],
  content: string,
  metadata: Record<string, unknown> | null
): Message {
  seq += 1
  return {
    id: `m-${seq}`,
    thread_id: 't1',
    session_id: 's1',
    role,
    content,
    metadata: metadata ? JSON.stringify(metadata) : null,
    created_at: new Date(seq * 1000).toISOString(),
  }
}

describe('groupByAgent', () => {
  it('returns a plain paired list when there are no sub-agents', () => {
    const messages = [
      msg('user', 'hi', null),
      msg('assistant', 'hello', { agent_scope: 'main' }),
    ]
    const entries = groupByAgent(messages)
    expect(entries.every((e) => e.kind !== 'agent')).toBe(true)
  })

  it('groups a dispatched sub-agent under an AgentGroup anchored at its Task tool_call', () => {
    const messages = [
      msg('user', 'do a search', null),
      msg('assistant', 'dispatching', { agent_scope: 'main' }),
      // Main-scope Task tool_call (id X) that spawns the sub-agent
      msg('assistant', 'Task', { type: 'tool_call', id: 'X', name: 'Task', input: {}, agent_scope: 'main' }),
      // Sub-agent output (parent === X)
      msg('assistant', 'agent thinking', { type: 'thinking', agent_scope: 'subagent', agent_parent_tool_use_id: 'X', agent_task_id: 'T', agent_subagent_type: 'Explore', agent_status: 'running' }),
      msg('assistant', 'Read', { type: 'tool_call', id: 'r1', name: 'Read', input: {}, agent_scope: 'subagent', agent_parent_tool_use_id: 'X', agent_task_id: 'T' }),
      // Task tool_result back to main (parent null)
      msg('assistant', 'done', { type: 'tool_result', tool_use_id: 'X' }),
    ]
    const entries = groupByAgent(messages)
    const agentGroups = entries.filter((e) => e.kind === 'agent')
    expect(agentGroups.length).toBe(1)
    const group = agentGroups[0]
    if (group.kind !== 'agent') throw new Error('expected agent group')
    expect(group.key).toBe('agent-X')
    expect(group.parentToolUseId).toBe('X')
    expect(group.taskId).toBe('T')
    expect(group.label).toBe('Explore')
    expect(group.status).toBe('running')
    expect(group.entries.length).toBeGreaterThan(0)

    // Isolation lookups work
    expect(findAgentGroup(entries, 'agent-X')).toBe(group)
    expect(collectActiveAgents(entries).map((a) => a.key)).toEqual(['agent-X'])
  })

  it('nests a sub-agent inside its parent sub-agent (does not recurse infinitely)', () => {
    const messages = [
      msg('assistant', 'Task', { type: 'tool_call', id: 'X', name: 'Task', input: {}, agent_scope: 'main' }),
      // Outer agent X spawns inner agent via a Task tool_call with id Y (X's own tool call → parent X)
      msg('assistant', 'Task', { type: 'tool_call', id: 'Y', name: 'Task', input: {}, agent_scope: 'subagent', agent_parent_tool_use_id: 'X', agent_subagent_type: 'outer' }),
      // Inner agent Y output (parent Y)
      msg('assistant', 'inner text', { agent_scope: 'subagent', agent_parent_tool_use_id: 'Y', agent_subagent_type: 'inner', agent_status: 'completed' }),
    ]
    const entries = groupByAgent(messages)
    const outer = entries.find((e) => e.kind === 'agent')
    if (!outer || outer.kind !== 'agent') throw new Error('expected outer agent group')
    expect(outer.key).toBe('agent-X')
    const inner = outer.entries.find((e) => e.kind === 'agent')
    if (!inner || inner.kind !== 'agent') throw new Error('expected nested inner agent group')
    expect(inner.key).toBe('agent-Y')
    expect(inner.label).toBe('Inner')
    // findAgentGroup descends into nesting
    expect(findAgentGroup(entries, 'agent-Y')).toBe(inner)
  })

  it('marks a group completed once a terminal task_notification arrives', () => {
    const messages = [
      msg('assistant', 'Task', { type: 'tool_call', id: 'X', name: 'Task', input: {}, agent_scope: 'main' }),
      msg('assistant', 'agent thinking', { type: 'thinking', agent_scope: 'subagent', agent_parent_tool_use_id: 'X', agent_status: 'running' }),
      msg('assistant', 'Subagent completed', { type: 'thinking', source: 'claude_task', task_event: 'notification', status: 'completed', agent_scope: 'subagent', agent_parent_tool_use_id: 'X', agent_status: 'completed' }),
    ]
    const entries = groupByAgent(messages)
    const group = entries.find((e) => e.kind === 'agent')
    if (!group || group.kind !== 'agent') throw new Error('expected agent group')
    expect(group.status).toBe('completed')
    // Completed agents are not "active"
    expect(collectActiveAgents(entries)).toEqual([])
  })

  it('captures the full prompt from the spawning Task tool_call', () => {
    const fullPrompt = 'Generate a single clever joke in Swahili. Return only the joke and its English translation.'
    const messages = [
      msg('assistant', 'Task', { type: 'tool_call', id: 'X', name: 'Task', input: { description: 'joke in Swahili', subagent_type: 'general-purpose', prompt: fullPrompt }, agent_scope: 'main' }),
      msg('assistant', 'a joke', { type: 'text', agent_scope: 'subagent', agent_parent_tool_use_id: 'X', agent_subagent_type: 'general-purpose', agent_status: 'running' }),
    ]
    const entries = groupByAgent(messages)
    const group = entries.find((e) => e.kind === 'agent')
    if (!group || group.kind !== 'agent') throw new Error('expected agent group')
    expect(group.prompt).toBe(fullPrompt)
  })

  it('humanizes the subagent type and hides Subagent started/completed status bubbles', () => {
    const messages = [
      msg('assistant', 'Task', { type: 'tool_call', id: 'X', name: 'Task', input: {}, agent_scope: 'main' }),
      msg('assistant', '**Subagent started:** general-purpose', { type: 'thinking', source: 'claude_task', task_event: 'started', agent_scope: 'subagent', agent_parent_tool_use_id: 'X', agent_subagent_type: 'general-purpose', agent_description: 'Generate a joke in Swahili', agent_status: 'running' }),
      msg('assistant', 'a joke', { type: 'text', agent_scope: 'subagent', agent_parent_tool_use_id: 'X', agent_subagent_type: 'general-purpose', agent_status: 'running' }),
      msg('assistant', '**Subagent completed:** ...', { type: 'thinking', source: 'claude_task', task_event: 'notification', status: 'completed', agent_scope: 'subagent', agent_parent_tool_use_id: 'X', agent_subagent_type: 'general-purpose', agent_status: 'completed' }),
    ]
    const entries = groupByAgent(messages)
    const group = entries.find((e) => e.kind === 'agent')
    if (!group || group.kind !== 'agent') throw new Error('expected agent group')
    expect(group.label).toBe('General Purpose')
    expect(group.description).toBe('Generate a joke in Swahili')
    expect(group.status).toBe('completed')
    // The started/completed status bubbles are filtered out of the visible entries.
    const hasStatusBubble = group.entries.some(
      (e) => e.kind === 'single' && e.metadata?.source === 'claude_task'
    )
    expect(hasStatusBubble).toBe(false)
    // The actual sub-agent text is still present.
    expect(group.entries.some((e) => e.kind === 'single' && e.message.content === 'a joke')).toBe(true)
  })

  it('surfaces sub-agent usage on the group and hides Subagent update bubbles', () => {
    const messages = [
      msg('assistant', 'Task', { type: 'tool_call', id: 'X', name: 'Task', input: {}, agent_scope: 'main' }),
      msg('assistant', '**Subagent update:** …', { type: 'thinking', source: 'claude_task', task_event: 'progress', last_tool_name: 'Read', usage: { total_tokens: 17379, tool_uses: 1, duration_ms: 3112 }, agent_scope: 'subagent', agent_parent_tool_use_id: 'X', agent_status: 'running' }),
      msg('assistant', '**Subagent completed:** …', { type: 'thinking', source: 'claude_task', task_event: 'notification', status: 'completed', usage: { total_tokens: 39777, tool_uses: 3, duration_ms: 204275 }, agent_scope: 'subagent', agent_parent_tool_use_id: 'X', agent_status: 'completed' }),
    ]
    const entries = groupByAgent(messages)
    const group = entries.find((e) => e.kind === 'agent')
    if (!group || group.kind !== 'agent') throw new Error('expected agent group')
    // The terminal notification usage wins.
    expect(group.usage?.totalTokens).toBe(39777)
    expect(group.usage?.toolUses).toBe(3)
    expect(agentStatsLabel(group)).toBe('3 tools · 39.8k tokens')
    // No claude_task status/update bubbles remain in the transcript.
    expect(group.entries.some((e) => e.kind === 'single' && e.metadata?.source === 'claude_task')).toBe(false)
  })

  it('shows the last running tool in the stats while active', () => {
    const messages = [
      msg('assistant', 'Task', { type: 'tool_call', id: 'X', name: 'Task', input: {}, agent_scope: 'main' }),
      msg('assistant', '**Subagent update:** …', { type: 'thinking', source: 'claude_task', task_event: 'progress', last_tool_name: 'Grep', usage: { total_tokens: 1200, tool_uses: 2 }, agent_scope: 'subagent', agent_parent_tool_use_id: 'X', agent_status: 'running' }),
    ]
    const group = groupByAgent(messages).find((e) => e.kind === 'agent')
    if (!group || group.kind !== 'agent') throw new Error('expected agent group')
    expect(agentStatsLabel(group)).toBe('2 tools · 1.2k tokens · Grep')
  })

  it('does not merge or hang on an orphaned sub-agent whose Task anchor is missing', () => {
    const messages = [
      msg('assistant', 'orphan output', { agent_scope: 'subagent', agent_parent_tool_use_id: 'Z', agent_subagent_type: 'ghost' }),
    ]
    const entries = groupByAgent(messages)
    const group = entries.find((e) => e.kind === 'agent')
    if (!group || group.kind !== 'agent') throw new Error('expected fallback agent group')
    expect(group.key).toBe('agent-Z')
  })
})
