import type { OutputEvent } from '../../shared/types'

export type CodexAgentStatus = 'running' | 'completed' | 'failed' | 'stopped'

type AgentRecord = {
  threadId: string
  parentThreadId: string
  parentToolUseId: string
  path?: string
  description?: string
  status: CodexAgentStatus
  totalTokens: number
  toolUses: number
}

export type CodexAgentObservation = {
  registeredThreadIds: string[]
  activityThreadId?: string
}

function itemFrom(params: Record<string, unknown> | undefined): Record<string, unknown> | null {
  return params?.item && typeof params.item === 'object'
    ? params.item as Record<string, unknown>
    : null
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function statusFrom(value: unknown): CodexAgentStatus | null {
  switch (value) {
    case 'pendingInit':
    case 'running':
    case 'inProgress':
      return 'running'
    case 'completed':
      return 'completed'
    case 'interrupted':
    case 'shutdown':
      return 'stopped'
    case 'errored':
    case 'failed':
    case 'notFound':
      return 'failed'
    default:
      return null
  }
}

function activityStatus(value: unknown): CodexAgentStatus {
  return value === 'interrupted' ? 'stopped' : 'running'
}

function agentType(path: string | undefined): string | undefined {
  if (!path) return undefined
  const parts = path.split('/').filter(Boolean)
  return parts.at(-1)
}

/**
 * Tracks Codex's thread graph and hides its multi-thread app-server protocol
 * behind the same `agent_*` message metadata consumed by the renderer.
 */
export class CodexAgentTracker {
  private readonly agents = new Map<string, AgentRecord>()

  observeNotification(
    method: string,
    params: Record<string, unknown> | undefined,
  ): CodexAgentObservation {
    const observation: CodexAgentObservation = { registeredThreadIds: [] }
    if (method !== 'item/started' && method !== 'item/completed') return observation

    const item = itemFrom(params)
    if (!item || typeof item.id !== 'string') return observation
    const parentThreadId = typeof params?.threadId === 'string' ? params.threadId : ''

    if (item.type === 'subAgentActivity' && typeof item.agentThreadId === 'string') {
      const threadId = item.agentThreadId
      const previous = this.agents.get(threadId)
      // `interacted` identifies the target of an interaction, which can be the
      // existing root thread. Only a `started` activity establishes a new child;
      // later activity kinds may update an agent we already know about.
      if (!previous && item.kind !== 'started') return observation
      const startsAgent = item.kind === 'started'
      this.register({
        threadId,
        parentThreadId: startsAgent ? parentThreadId : previous?.parentThreadId ?? parentThreadId,
        parentToolUseId: startsAgent ? item.id : previous?.parentToolUseId ?? item.id,
        path: typeof item.agentPath === 'string' ? item.agentPath : undefined,
        description: previous?.description,
        status: activityStatus(item.kind),
      })
      observation.registeredThreadIds.push(threadId)
      observation.activityThreadId = threadId
      return observation
    }

    if (item.type !== 'collabAgentToolCall') return observation
    const tool = typeof item.tool === 'string' ? item.tool : ''
    if (tool !== 'spawnAgent' && tool !== 'sendInput' && tool !== 'resumeAgent') {
      this.applyAgentStates(item.agentsStates)
      return observation
    }

    const receiverThreadIds = stringArray(item.receiverThreadIds)
    const states = item.agentsStates && typeof item.agentsStates === 'object'
      ? item.agentsStates as Record<string, Record<string, unknown>>
      : {}
    for (const threadId of receiverThreadIds) {
      const previous = this.agents.get(threadId)
      const observedStatus = statusFrom(states[threadId]?.status)
      const startsAgent = tool === 'spawnAgent' || !previous
      this.register({
        threadId,
        parentThreadId: startsAgent
          ? typeof item.senderThreadId === 'string' ? item.senderThreadId : parentThreadId
          : previous.parentThreadId,
        parentToolUseId: startsAgent ? item.id : previous.parentToolUseId,
        path: previous?.path,
        description: startsAgent && typeof item.prompt === 'string' ? item.prompt : previous?.description,
        status: observedStatus ?? 'running',
      })
      observation.registeredThreadIds.push(threadId)
    }
    this.applyAgentStates(item.agentsStates)
    return observation
  }

  hasAgent(threadId: string): boolean {
    return this.agents.has(threadId)
  }

  hasRunningAgents(): boolean {
    for (const agent of this.agents.values()) {
      if (agent.status === 'running') return true
    }
    return false
  }

  markTurnStarted(threadId: string): void {
    const agent = this.agents.get(threadId)
    if (agent) agent.status = 'running'
  }

  markTurnCompleted(
    threadId: string,
    status: unknown,
    usage?: Record<string, unknown>,
  ): OutputEvent | null {
    const agent = this.agents.get(threadId)
    if (!agent) return null
    agent.status = statusFrom(status) ?? 'completed'

    const inputTokens = Number(usage?.inputTokens ?? usage?.input_tokens ?? 0)
    const cachedInputTokens = Number(usage?.cachedInputTokens ?? usage?.cached_input_tokens ?? 0)
    const outputTokens = Number(usage?.outputTokens ?? usage?.output_tokens ?? 0)
    const turnTokens = [inputTokens, cachedInputTokens, outputTokens]
      .filter(Number.isFinite)
      .reduce((total, value) => total + value, 0)
    agent.totalTokens += turnTokens

    return {
      type: 'thinking',
      content: `**Subagent ${agent.status}:** ${agent.path ?? threadId}`,
      metadata: {
        type: 'thinking',
        source: 'codex_subagent',
        task_event: 'notification',
        status: agent.status,
        usage: {
          total_tokens: agent.totalTokens,
          tool_uses: agent.toolUses,
        },
        ...this.metadataForAgent(agent),
      },
    }
  }

  recordEvents(threadId: string, events: OutputEvent[]): void {
    const agent = this.agents.get(threadId)
    if (!agent) return
    agent.toolUses += events.filter((event) => event.type === 'tool_call').length
  }

  scopeEvents(threadId: string, events: OutputEvent[]): OutputEvent[] {
    const agent = this.agents.get(threadId)
    const scope = agent ? this.metadataForAgent(agent) : { agent_scope: 'main' }
    return events.map((event) => ({
      ...event,
      metadata: { ...(event.metadata ?? {}), ...scope },
    }))
  }

  scopeActivity(threadId: string, events: OutputEvent[]): OutputEvent[] {
    const agent = this.agents.get(threadId)
    if (!agent) return events
    return events.map((event) => ({
      ...event,
      metadata: { ...(event.metadata ?? {}), ...this.metadataForAgent(agent) },
    }))
  }

  clear(): void {
    this.agents.clear()
  }

  private register(next: Omit<AgentRecord, 'totalTokens' | 'toolUses'>): void {
    const previous = this.agents.get(next.threadId)
    this.agents.set(next.threadId, {
      ...next,
      path: next.path ?? previous?.path,
      description: next.description ?? previous?.description,
      totalTokens: previous?.totalTokens ?? 0,
      toolUses: previous?.toolUses ?? 0,
    })
  }

  private applyAgentStates(value: unknown): void {
    if (!value || typeof value !== 'object') return
    for (const [threadId, rawState] of Object.entries(value as Record<string, unknown>)) {
      if (!rawState || typeof rawState !== 'object') continue
      const agent = this.agents.get(threadId)
      const status = statusFrom((rawState as Record<string, unknown>).status)
      if (agent && status) agent.status = status
    }
  }

  private metadataForAgent(agent: AgentRecord): Record<string, unknown> {
    const subagentType = agentType(agent.path) ?? 'codex-agent'
    return {
      agent_scope: 'subagent',
      agent_parent_tool_use_id: agent.parentToolUseId,
      agent_task_id: agent.threadId,
      agent_status: agent.status,
      ...(agent.path ? { agent_description: agent.path, codex_agent_path: agent.path } : {}),
      agent_subagent_type: subagentType,
      ...(agent.description ? { codex_agent_prompt: agent.description } : {}),
      codex_agent_thread_id: agent.threadId,
      codex_parent_thread_id: agent.parentThreadId,
    }
  }
}
