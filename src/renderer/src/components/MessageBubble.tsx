import MarkdownContent from './MarkdownContent'
import ToolCallBlock from './ToolCallBlock'
import ThinkingBlock from './ThinkingBlock'
import { MessageEntry } from './MessageStream'
import { parseFileMentions } from './FileMention'

interface Props {
  entry: MessageEntry
}

export default function MessageBubble({ entry }: Props) {
  const { message, metadata, result, resultMetadata } = entry
  const isUser = message.role === 'user'
  const isToolCall = metadata?.type === 'tool_call' || metadata?.type === 'tool_use'
  const isToolResult = metadata?.type === 'tool_result'

  if (metadata?.type === 'thinking') {
    return <ThinkingBlock message={message} />
  }

  if (isToolCall) {
    return <ToolCallBlock message={message} metadata={metadata} result={result} resultMetadata={resultMetadata} />
  }

  // Standalone tool_result (no matching call found) — shouldn't happen often but handle gracefully
  if (isToolResult) {
    return <ToolCallBlock message={message} metadata={metadata} result={null} resultMetadata={null} />
  }

  const isError = message.role === 'system' || metadata?.type === 'error'
  const mentionNodes = parseFileMentions(
    message.content,
    isUser ? 'message-user' : 'message-assistant'
  )
  const hasMentionComponents = mentionNodes.some((node) => typeof node !== 'string')

  if (isError) {
    return (
      <div className="flex justify-start">
        <div
          className="max-w-2xl rounded-lg px-4 py-2 text-sm font-mono"
          style={{ background: '#3b0000', color: '#f87171', border: '1px solid #7f1d1d' }}
        >
          <span className="mr-2 font-bold">Error:</span>
          <span className="whitespace-pre-wrap">{message.content}</span>
        </div>
      </div>
    )
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-2xl rounded-lg px-4 py-2 text-sm${isUser ? ' user-bubble' : ''}`}
        style={{
          background: isUser ? 'var(--color-claude)' : 'var(--color-surface)',
          color: isUser ? '#fff' : 'var(--color-text)',
          border: isUser ? 'none' : '1px solid var(--color-border)'
        }}
      >
        {hasMentionComponents ? (
          <div className="whitespace-pre-wrap break-words">{mentionNodes}</div>
        ) : (
          <MarkdownContent content={message.content} />
        )}
      </div>
    </div>
  )
}
