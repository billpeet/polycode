import type { Message, OutputEvent } from './types'

/** Parse a message's JSON metadata column, returning null on absence or corruption. */
export function parseMetadata(metadata: string | null): Record<string, unknown> | null {
  if (!metadata) return null
  try {
    return JSON.parse(metadata) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Stable grouping key identifying which agent (main or a specific sub-agent)
 * produced a message. Used to prevent merging text/thinking across agent scopes.
 */
export function agentKey(metadata: Record<string, unknown> | null): string {
  const taskId = metadata?.agent_task_id
  if (typeof taskId === 'string' && taskId) return taskId
  const parentToolUseId = metadata?.agent_parent_tool_use_id
  if (typeof parentToolUseId === 'string' && parentToolUseId) return parentToolUseId
  return 'main'
}

/**
 * Determine the display role for a streamed OutputEvent: an explicit
 * metadata.role wins (e.g. question answers echoed as 'user'), errors render
 * as 'system', everything else as 'assistant'.
 */
export function eventRole(event: OutputEvent): Message['role'] {
  const metaRole = event.metadata?.role
  if (metaRole === 'user' || metaRole === 'assistant' || metaRole === 'system') return metaRole
  return event.type === 'error' ? 'system' : 'assistant'
}

/**
 * Append a streamed message to a list, merging consecutive same-scope
 * text/thinking chunks and same-tool_use_id tool_result chunks into the
 * previous bubble. This encodes the streaming display rules shared by the
 * desktop renderer and the mobile app.
 */
export function appendOrMergeMessage(messages: Message[], incoming: Message, event: OutputEvent): Message[] {
  const previous = messages[messages.length - 1]
  if (!previous || previous.role !== incoming.role) {
    return [...messages, incoming]
  }

  const previousMetadata = parseMetadata(previous.metadata)
  const nextMetadata = event.metadata ?? null

  // Never merge across agent scopes: main-scope assistant text followed by
  // sub-agent assistant text (both role 'assistant') must stay separate bubbles.
  const sameScope = agentKey(previousMetadata) === agentKey(nextMetadata)

  if (event.type === 'text') {
    // User-role events (question answers, remote-client sends) are discrete
    // messages, never streaming chunks — don't merge them into the previous
    // bubble or fuse consecutive user messages together.
    if (nextMetadata?.role === 'user' || previousMetadata?.role === 'user') {
      return [...messages, incoming]
    }
    const previousType = previousMetadata?.type
    if (!previousType && sameScope) {
      return [
        ...messages.slice(0, -1),
        {
          ...previous,
          content: previous.content + incoming.content,
          created_at: incoming.created_at,
        },
      ]
    }
    return [...messages, incoming]
  }

  if (event.type === 'thinking') {
    const previousType = previousMetadata?.type
    // Never merge sub-agent task lifecycle bubbles (started/progress/notification): each
    // carries unique per-event metadata (status, usage) that deriveAgentMeta relies on.
    // Merging keeps the *previous* metadata, which would drop a terminal "completed"
    // notification and leave the agent group stuck showing "running".
    const isTaskBubble =
      previousMetadata?.source === 'claude_task' || nextMetadata?.source === 'claude_task'
    if (previousType === 'thinking' && sameScope && !isTaskBubble) {
      return [
        ...messages.slice(0, -1),
        {
          ...previous,
          content: previous.content + incoming.content,
          created_at: incoming.created_at,
        },
      ]
    }
    return [...messages, incoming]
  }

  if (event.type === 'tool_result') {
    // Only merge into a *previous tool_result* streaming chunk for the same tool_use_id.
    // Guard on the previous type: task lifecycle bubbles (e.g. a "Subagent completed"
    // notification) carry the spawning Task/Agent tool_use_id in their metadata, so
    // without this check the sub-agent's main-scope tool_result would clobber the
    // notification — destroying its metadata and leaving the agent group stuck "running".
    const previousIsToolResult = previousMetadata?.type === 'tool_result'
    const previousToolUseId = typeof previousMetadata?.tool_use_id === 'string' ? previousMetadata.tool_use_id : null
    const nextToolUseId = typeof nextMetadata?.tool_use_id === 'string' ? nextMetadata.tool_use_id : null
    if (!previousIsToolResult || !previousToolUseId || !nextToolUseId || previousToolUseId !== nextToolUseId) {
      return [...messages, incoming]
    }

    const previousContent = previous.content
    const nextContent =
      incoming.content.startsWith(previousContent)
        ? incoming.content
        : previousContent + incoming.content

    return [
      ...messages.slice(0, -1),
      {
        ...previous,
        content: nextContent,
        metadata: incoming.metadata,
        created_at: incoming.created_at,
      },
    ]
  }

  return [...messages, incoming]
}
