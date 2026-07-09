import type { MessageEntry, MessageGroup, AgentGroup } from './MessageStream'
import MessageBubble from './MessageBubble'
import ToolCallGroupBlock from './ToolCallGroupBlock'
import AgentGroupBlock from './AgentGroupBlock'

interface RenderEntryOptions {
  /** Callback to isolate the view to a specific agent group (used by AgentGroupBlock header). */
  onIsolateAgent?: (agentKey: string) => void
}

/** Render a single stream entry: a message bubble, a tool-call group, or an agent group. */
export function renderEntry(
  entry: MessageEntry | MessageGroup | AgentGroup,
  options?: RenderEntryOptions
) {
  if (entry.kind === 'agent') {
    return <AgentGroupBlock group={entry} onIsolate={options?.onIsolateAgent} />
  }
  if (entry.kind === 'group') {
    return <ToolCallGroupBlock group={entry} />
  }
  return <MessageBubble entry={entry} />
}
