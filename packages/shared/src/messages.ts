import type { Message, OutputEvent } from './types'

const LEGACY_CODEX_REASONING_SUMMARY_MARKER = 'Reasoning summary updated.'

function isCodexReasoningSummary(metadata: Record<string, unknown> | null): boolean {
  return metadata?.source === 'codex_reasoning_summary'
}

function isSameCodexReasoningSummaryPart(
  previous: Record<string, unknown> | null,
  next: Record<string, unknown> | null,
): boolean {
  return previous?.item_id === next?.item_id && previous?.summary_index === next?.summary_index
}

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
 * Fold accumulator. `tailMetadata` caches the parsed metadata of the last message so a
 * long run of appends never re-parses the tail's JSON on every step.
 */
interface FoldState {
  messages: Message[]
  tailMetadata: Record<string, unknown> | null
}

function replaceTail(state: FoldState, message: Message, metadata: Record<string, unknown> | null): void {
  state.messages[state.messages.length - 1] = message
  state.tailMetadata = metadata
}

function pushTail(state: FoldState, message: Message, metadata: Record<string, unknown> | null): void {
  state.messages.push(message)
  state.tailMetadata = metadata
}

/**
 * Append a streamed message to the accumulator, merging consecutive same-scope
 * text/thinking chunks and same-tool_use_id tool_result chunks into the
 * previous bubble. This encodes the streaming display rules shared by the
 * desktop renderer and the mobile app.
 *
 * Mutates `state` in place. The previous implementation rebuilt the array on
 * every step (`[...messages, incoming]`), which made folding O(n²): a real 74k-row
 * session took 28s to fold on the Electron main thread (the SQLite read took 0.3s),
 * and the renderer re-folded the whole transcript on every streamed chunk.
 */
function appendOrMergeMessage(state: FoldState, incoming: Message): void {
  const nextMetadata = parseMetadata(incoming.metadata)
  const incomingType = nextMetadata?.type

  // Older Polycode versions turned Codex's structural summaryPartAdded
  // notification into this visible sentence. Ignore it when replayed by an
  // older remote or encountered in an in-flight stream during an upgrade.
  if (
    incomingType === 'thinking' &&
    incoming.content === LEGACY_CODEX_REASONING_SUMMARY_MARKER &&
    isCodexReasoningSummary(nextMetadata)
  ) {
    return
  }

  const { messages } = state
  const previous = messages[messages.length - 1]
  if (!previous || previous.role !== incoming.role) {
    pushTail(state, incoming, nextMetadata)
    return
  }

  const previousMetadata = state.tailMetadata

  // Never merge across agent scopes: main-scope assistant text followed by
  // sub-agent assistant text (both role 'assistant') must stay separate bubbles.
  const sameScope = agentKey(previousMetadata) === agentKey(nextMetadata)

  if (!incomingType || incomingType === 'text') {
    // User-role events (question answers, remote-client sends) are discrete
    // messages, never streaming chunks — don't merge them into the previous
    // bubble or fuse consecutive user messages together.
    if (nextMetadata?.role === 'user' || previousMetadata?.role === 'user') {
      pushTail(state, incoming, nextMetadata)
      return
    }
    const previousType = previousMetadata?.type
    if ((!previousType || previousType === 'text') && sameScope) {
      replaceTail(
        state,
        {
          ...previous,
          content: previous.content + incoming.content,
          created_at: incoming.created_at,
        },
        previousMetadata,
      )
      return
    }
    pushTail(state, incoming, nextMetadata)
    return
  }

  if (incomingType === 'thinking') {
    const previousType = previousMetadata?.type
    // Never merge sub-agent task lifecycle bubbles (started/progress/notification): each
    // carries unique per-event metadata (status, usage) that deriveAgentMeta relies on.
    // Merging keeps the *previous* metadata, which would drop a terminal "completed"
    // notification and leave the agent group stuck showing "running".
    const isTaskBubble =
      previousMetadata?.source === 'claude_task' || nextMetadata?.source === 'claude_task'
    if (previousType === 'thinking' && sameScope && !isTaskBubble) {
      const isCodexSummaryPair =
        isCodexReasoningSummary(previousMetadata) && isCodexReasoningSummary(nextMetadata)
      const separator =
        isCodexSummaryPair && !isSameCodexReasoningSummaryPart(previousMetadata, nextMetadata)
          ? '\n\n'
          : ''
      replaceTail(
        state,
        {
          ...previous,
          content: previous.content + separator + incoming.content,
          // Track the current tail part so subsequent deltas for that part do
          // not receive another separator.
          metadata: isCodexSummaryPair ? incoming.metadata : previous.metadata,
          created_at: incoming.created_at,
        },
        isCodexSummaryPair ? nextMetadata : previousMetadata,
      )
      return
    }
    pushTail(state, incoming, nextMetadata)
    return
  }

  if (incomingType === 'tool_result') {
    // Only merge into a *previous tool_result* streaming chunk for the same tool_use_id.
    // Guard on the previous type: task lifecycle bubbles (e.g. a "Subagent completed"
    // notification) carry the spawning Task/Agent tool_use_id in their metadata, so
    // without this check the sub-agent's main-scope tool_result would clobber the
    // notification — destroying its metadata and leaving the agent group stuck "running".
    const previousIsToolResult = previousMetadata?.type === 'tool_result'
    const previousToolUseId = typeof previousMetadata?.tool_use_id === 'string' ? previousMetadata.tool_use_id : null
    const nextToolUseId = typeof nextMetadata?.tool_use_id === 'string' ? nextMetadata.tool_use_id : null
    if (!previousIsToolResult || !previousToolUseId || !nextToolUseId || previousToolUseId !== nextToolUseId) {
      pushTail(state, incoming, nextMetadata)
      return
    }

    if (nextMetadata?.authoritative === true) {
      replaceTail(state, { ...incoming, id: previous.id }, nextMetadata)
      return
    }

    const previousContent = previous.content
    const nextContent =
      incoming.content.startsWith(previousContent)
        ? incoming.content
        : previousContent + incoming.content

    replaceTail(
      state,
      {
        ...previous,
        content: nextContent,
        metadata: incoming.metadata,
        created_at: incoming.created_at,
      },
      nextMetadata,
    )
    return
  }

  pushTail(state, incoming, nextMetadata)
}

/**
 * Fold persisted or streamed messages into their display form using the same
 * merge rules in every caller. O(n); returns a new array.
 */
export function foldMessages(messages: Message[]): Message[] {
  const state: FoldState = { messages: [], tailMetadata: null }
  for (const message of messages) appendOrMergeMessage(state, message)
  return state.messages
}

/**
 * Append one streamed message to an already-folded transcript, returning a new
 * array (the input is not mutated, so it is safe for immutable stores). O(n) in
 * the pointer copy only — it never re-folds the prefix, which is what made every
 * streamed chunk O(n²) before.
 */
export function appendFoldedMessage(folded: Message[], incoming: Message): Message[] {
  const messages = folded.slice()
  const tail = messages[messages.length - 1]
  const state: FoldState = { messages, tailMetadata: tail ? parseMetadata(tail.metadata) : null }
  appendOrMergeMessage(state, incoming)
  return state.messages
}
