import { useState } from 'react'
import { marked } from 'marked'
import MarkdownContent from './MarkdownContent'
import ToolCallBlock from './ToolCallBlock'
import ThinkingBlock from './ThinkingBlock'
import { MessageEntry } from './MessageStream'
import { parseFileMentions } from './FileMention'

interface Props {
  entry: MessageEntry
}

function toPlainText(content: string): string {
  const html = marked.parse(content) as string
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  return (tmp.textContent ?? content).trim()
}

export default function MessageBubble({ entry }: Props) {
  const { message, metadata, result, resultMetadata } = entry
  const isUser = message.role === 'user'
  const isToolCall = metadata?.type === 'tool_call' || metadata?.type === 'tool_use'
  const isToolResult = metadata?.type === 'tool_result'

  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    const text = toPlainText(message.content)
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }

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
        className={`group relative max-w-2xl rounded-lg px-4 py-2 text-sm${isUser ? ' user-bubble' : ''}`}
        style={{
          background: isUser ? 'var(--color-claude)' : 'var(--color-surface)',
          color: isUser ? '#fff' : 'var(--color-text)',
          border: isUser ? 'none' : '1px solid var(--color-border)'
        }}
      >
        {hasMentionComponents ? (
          <div className="break-words">
            {mentionNodes.map((node, i) =>
              typeof node === 'string' ? (
                <MarkdownContent key={i} content={node} />
              ) : (
                node
              )
            )}
          </div>
        ) : (
          <MarkdownContent content={message.content} />
        )}
        <button
          onClick={handleCopy}
          className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity text-xs px-1.5 py-0.5 rounded"
          style={{
            background: isUser ? 'rgba(0,0,0,0.25)' : 'var(--color-border)',
            color: isUser ? '#fff' : 'var(--color-text-muted, var(--color-text))'
          }}
        >
          {copied ? 'copied!' : 'copy'}
        </button>
      </div>
    </div>
  )
}
