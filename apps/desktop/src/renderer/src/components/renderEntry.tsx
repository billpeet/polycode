import type { MessageEntry, MessageGroup, AgentGroup } from './MessageStream'
import MessageBubble from './MessageBubble'
import ToolCallGroupBlock from './ToolCallGroupBlock'
import AgentGroupBlock from './AgentGroupBlock'
import UiErrorBoundary from './UiErrorBoundary'

interface RenderEntryOptions {
  /** Callback to isolate the view to a specific agent group (used by AgentGroupBlock header). */
  onIsolateAgent?: (agentKey: string) => void
}

/** Render a single stream entry: a message bubble, a tool-call group, or an agent group. */
export function renderEntry(
  entry: MessageEntry | MessageGroup | AgentGroup,
  options?: RenderEntryOptions
) {
  let content
  if (entry.kind === 'agent') {
    content = <AgentGroupBlock group={entry} onIsolate={options?.onIsolateAgent} />
  } else if (entry.kind === 'group') {
    content = <ToolCallGroupBlock group={entry} />
  } else {
    content = <MessageBubble entry={entry} />
  }

  return (
    <UiErrorBoundary context={`Transcript entry (${entry.key})`} variant="entry" resetKeys={[entry]}>
      {content}
    </UiErrorBoundary>
  )
}
