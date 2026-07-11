import { useState, useRef, useEffect, useCallback } from 'react'
import { Crosshair } from 'lucide-react'

type Mode = 'pid' | 'port'
type Feedback = { type: 'success' | 'error'; text: string } | null

export default function Assassin({ threadId }: { threadId: string }) {
  const [expanded, setExpanded] = useState(false)
  const [mode, setMode] = useState<Mode>('pid')
  const [value, setValue] = useState('')
  const [loading, setLoading] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Auto-focus input when expanded
  useEffect(() => {
    if (expanded) inputRef.current?.focus()
  }, [expanded])

  // Clear feedback after 3s
  const showFeedback = useCallback((fb: Feedback) => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current)
    setFeedback(fb)
    if (fb) {
      feedbackTimer.current = setTimeout(() => setFeedback(null), 3000)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current)
    }
  }, [])

  const handleKill = useCallback(async () => {
    const trimmed = value.trim()
    if (!trimmed || loading) return
    setLoading(true)
    showFeedback(null)
    try {
      const result = await window.api.invoke('process:kill', trimmed, mode, threadId)
      if (result.ok) {
        showFeedback({ type: 'success', text: `Killed ${mode === 'pid' ? 'PID' : 'port'} ${trimmed}` })
        setValue('')
      } else {
        showFeedback({ type: 'error', text: result.error ?? 'Unknown error' })
      }
    } catch (e: unknown) {
      showFeedback({ type: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setLoading(false)
    }
  }, [value, mode, loading, showFeedback, threadId])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleKill()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setExpanded(false)
      }
    },
    [handleKill],
  )

  const segmentStyle = (active: boolean): React.CSSProperties => ({
    padding: '1px 8px',
    fontSize: 11,
    fontWeight: 500,
    borderRadius: 3,
    border: 'none',
    cursor: 'pointer',
    transition: 'background 0.15s, color 0.15s',
    background: active ? 'rgba(248,113,113,0.2)' : 'transparent',
    color: active ? '#f87171' : 'var(--color-text-muted)',
  })

  return (
    <div
      className="flex items-center gap-2 flex-shrink-0 px-2"
      style={{
        minHeight: 32,
        borderBottom: '1px solid var(--color-border)',
        background: 'var(--color-surface)',
      }}
    >
      {/* Toggle button */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="rounded p-1 hover:bg-white/10 transition-colors flex-shrink-0"
        style={{ color: expanded ? '#f87171' : 'var(--color-text-muted)' }}
        title="Kill process by PID or port"
      >
        <Crosshair size={14} />
      </button>

      {expanded && (
        <>
          {/* PID / Port toggle */}
          <div
            className="flex rounded overflow-hidden flex-shrink-0"
            style={{ background: 'rgba(255,255,255,0.05)' }}
          >
            <button style={segmentStyle(mode === 'pid')} onClick={() => { setMode('pid'); setValue(''); inputRef.current?.focus() }}>
              PID
            </button>
            <button style={segmentStyle(mode === 'port')} onClick={() => { setMode('port'); setValue(''); inputRef.current?.focus() }}>
              Port
            </button>
          </div>

          {/* Input */}
          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            placeholder={mode === 'pid' ? 'PID' : 'Port'}
            value={value}
            onChange={(e) => {
              // Allow only digits
              const v = e.target.value.replace(/\D/g, '')
              setValue(v)
            }}
            onKeyDown={handleKeyDown}
            className="rounded px-2 py-0.5 text-xs outline-none w-20"
            style={{
              background: 'rgba(255,255,255,0.07)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-text)',
            }}
          />

          {/* Kill button */}
          <button
            onClick={handleKill}
            disabled={!value.trim() || loading}
            className="rounded px-2 py-0.5 text-xs font-medium transition-colors disabled:opacity-40"
            style={{
              background: 'rgba(248,113,113,0.2)',
              color: '#f87171',
              border: 'none',
              cursor: !value.trim() || loading ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? '…' : 'Kill'}
          </button>

          {/* Feedback text */}
          {feedback && (
            <span
              className="text-xs truncate"
              style={{
                color: feedback.type === 'success' ? '#4ade80' : '#f87171',
                maxWidth: 200,
              }}
            >
              {feedback.text}
            </span>
          )}
        </>
      )}
    </div>
  )
}
