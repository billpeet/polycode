import { useState } from 'react'
import MarkdownContent from './MarkdownContent'
import ToolCallBlock from './ToolCallBlock'
import ThinkingBlock from './ThinkingBlock'
import { MessageEntry } from './MessageStream'
import { parseFileMentions } from './FileMention'
import { markdownToPlainText } from '../lib/markdownToPlainText'

interface Props {
  entry: MessageEntry
}

export default function MessageBubble({ entry }: Props) {
  const { message, metadata, result, resultMetadata } = entry
  const isUser = message.role === 'user'
  const isToolCall = metadata?.type === 'tool_call' || metadata?.type === 'tool_use'
  const isToolResult = metadata?.type === 'tool_result'

  const [copied, setCopied] = useState<'text' | 'markdown' | null>(null)

  const handleCopy = (format: 'text' | 'markdown') => {
    const content = format === 'markdown' ? message.content : markdownToPlainText(message.content)
    navigator.clipboard.writeText(content).then(() => {
      setCopied(format)
      setTimeout(() => setCopied(null), 1800)
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
        <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button
            onClick={() => handleCopy('text')}
            className="flex h-5 w-5 items-center justify-center rounded p-0"
            style={{
              background: isUser ? 'rgba(0,0,0,0.25)' : 'var(--color-border)',
              color: copied === 'text' ? '#4ade80' : (isUser ? '#fff' : 'var(--color-text-muted, var(--color-text))')
            }}
            title={copied === 'text' ? 'Copied text' : 'Copy text'}
            aria-label={copied === 'text' ? 'Copied text' : 'Copy text'}
          >
            <svg
              viewBox="0 0 16 16"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M3 4h10M3 8h8M3 12h6" />
            </svg>
          </button>
          <button
            onClick={() => handleCopy('markdown')}
            className="flex h-5 w-5 items-center justify-center rounded p-0"
            style={{
              background: isUser ? 'rgba(0,0,0,0.25)' : 'var(--color-border)',
              color: copied === 'markdown' ? '#4ade80' : (isUser ? '#fff' : 'var(--color-text-muted, var(--color-text))')
            }}
            title={copied === 'markdown' ? 'Copied Markdown' : 'Copy Markdown'}
            aria-label={copied === 'markdown' ? 'Copied Markdown' : 'Copy Markdown'}
          >
            <svg
              viewBox="0 0 16 16"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
