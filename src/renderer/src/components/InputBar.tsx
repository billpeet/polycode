import { useState, useRef, useEffect, KeyboardEvent } from 'react'
import { useThreadStore } from '../stores/threads'
import { useMessageStore } from '../stores/messages'
import { useProjectStore } from '../stores/projects'

interface Props {
  threadId: string
}

export default function InputBar({ threadId }: Props) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const send = useThreadStore((s) => s.send)
  const stop = useThreadStore((s) => s.stop)
  const status = useThreadStore((s) => s.statusMap[threadId] ?? 'idle')
  const appendUserMessage = useMessageStore((s) => s.appendUserMessage)

  const projects = useProjectStore((s) => s.projects)
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const project = projects.find((p) => p.id === selectedProjectId)

  const isProcessing = status === 'running'
  const canSend = !isProcessing && value.trim().length > 0

  useEffect(() => {
    function onFocusInput(): void {
      textareaRef.current?.focus()
    }
    window.addEventListener('focus-input', onFocusInput)
    return () => window.removeEventListener('focus-input', onFocusInput)
  }, [])

  async function handleSend(): Promise<void> {
    const trimmed = value.trim()
    if (!trimmed || isProcessing || !project) return

    setValue('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    appendUserMessage(threadId, trimmed)
    await send(threadId, trimmed, project.path)
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

  return (
    <div
      className="flex-shrink-0 border-t px-4 py-3"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
    >
      {status === 'error' && (
        <p className="mb-2 text-xs" style={{ color: '#f87171' }}>
          Session error. Try sending a new message to restart.
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
          placeholder="Message… (Enter to send, Shift+Enter for newline)"
          disabled={isProcessing}
          className="flex-1 resize-none bg-transparent text-sm outline-none"
          style={{ color: 'var(--color-text)', maxHeight: '200px' }}
        />
        {isProcessing ? (
          <button
            onClick={() => stop(threadId)}
            className="flex-shrink-0 rounded px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-80"
            style={{ background: '#f87171', color: '#fff' }}
          >
            Stop
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!canSend}
            className="flex-shrink-0 rounded px-3 py-1.5 text-xs font-medium transition-opacity disabled:opacity-30"
            style={{ background: 'var(--color-claude)', color: '#fff' }}
          >
            Send
          </button>
        )}
      </div>
    </div>
  )
}
