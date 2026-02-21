import { Message } from '../types/ipc'
import MarkdownContent from './MarkdownContent'
import ToolCallBlock from './ToolCallBlock'

interface Props {
  message: Message
}

export default function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user'
  const metadata = message.metadata ? safeParseJson(message.metadata) : null
  const isToolCall = metadata?.type === 'tool_call' || metadata?.type === 'tool_result'

  if (isToolCall) {
    return <ToolCallBlock message={message} metadata={metadata} />
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className="max-w-2xl rounded-lg px-4 py-2 text-sm"
        style={{
          background: isUser ? 'var(--color-claude)' : 'var(--color-surface)',
          color: isUser ? '#fff' : 'var(--color-text)',
          border: isUser ? 'none' : '1px solid var(--color-border)'
        }}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <MarkdownContent content={message.content} />
        )}
      </div>
    </div>
  )
}

function safeParseJson(str: string): Record<string, unknown> | null {
  try {
    return JSON.parse(str)
  } catch {
    return null
  }
}
