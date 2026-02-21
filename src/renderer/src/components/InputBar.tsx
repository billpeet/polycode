import { useState, useRef, KeyboardEvent } from 'react'
import { useThreadStore } from '../stores/threads'
import { useMessageStore } from '../stores/messages'


interface Props {
  threadId: string
}

export default function InputBar({ threadId }: Props) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const send = useThreadStore((s) => s.send)
  const status = useThreadStore((s) => s.statusMap[threadId] ?? 'idle')
  const appendUserMessage = useMessageStore((s) => s.appendUserMessage)

  async function handleSend(): Promise<void> {
    const trimmed = value.trim()
    if (!trimmed || status !== 'running') return

    setValue('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    // Optimistically add the user message so the streaming indicator fires immediately
    appendUserMessage(threadId, trimmed)

    await send(threadId, trimmed)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  function handleInput(): void {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  const canSend = status === 'running' && value.trim().length > 0

  return (
    <div
      className="flex-shrink-0 border-t px-4 py-3"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
    >
      {status !== 'running' && (
        <p className="mb-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {status === 'error' ? 'Session error. Restart to continue.' : 'Starting session…'}
        </p>
      )}
      <div
        className="flex items-end gap-2 rounded-lg border px-3 py-2"
        style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)' }}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          rows={1}
          placeholder={status === 'running' ? 'Message… (Enter to send, Shift+Enter for newline)' : 'Waiting for session…'}
          disabled={status !== 'running'}
          className="flex-1 resize-none bg-transparent text-sm outline-none"
          style={{ color: 'var(--color-text)', maxHeight: '200px' }}
        />
        <button
          onClick={handleSend}
          disabled={!canSend}
          className="flex-shrink-0 rounded px-3 py-1.5 text-xs font-medium transition-opacity disabled:opacity-30"
          style={{ background: 'var(--color-claude)', color: '#fff' }}
        >
          Send
        </button>
      </div>
    </div>
  )
}
