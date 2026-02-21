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

  const isError = message.role === 'system' || metadata?.type === 'error'

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
