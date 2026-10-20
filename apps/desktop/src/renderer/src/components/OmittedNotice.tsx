import { useState } from 'react'
import { FULL_MESSAGE_LIMIT } from '@polycode/shared'
import { useMessageStore } from '../stores/messages'
import type { Message } from '../types/ipc'

/**
 * Says how much of a very large message a transcript page left out, and fetches the
 * rest on request unless it is too large to render.
 */
export default function OmittedNotice({ message }: { message: Message | null | undefined }) {
  const expandMessage = useMessageStore((s) => s.expandMessage)
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle')
  const omitted = message?.omitted_chars
  if (!message || !omitted) return null

  const fullSize = message.content.length + (message.metadata?.length ?? 0) + omitted
  const canExpand = fullSize <= FULL_MESSAGE_LIMIT.desktop
  const expand = () => {
    setState('loading')
    expandMessage(message).then(() => setState('idle'), () => setState('failed'))
  }

  return (
    <div className="flex items-center gap-2" style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)' }}>
      <span>
        {omitted.toLocaleString()} characters left out
        {canExpand ? '.' : ' — too large to show here.'}
      </span>
      {canExpand && (
        <button
          onClick={expand}
          disabled={state === 'loading'}
          className="rounded px-1.5 py-0.5 hover:opacity-80 disabled:opacity-60"
          style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-muted)', background: 'transparent' }}
        >
          {state === 'loading' ? 'Loading…' : state === 'failed' ? 'Retry' : 'Show all'}
        </button>
      )}
    </div>
  )
}
