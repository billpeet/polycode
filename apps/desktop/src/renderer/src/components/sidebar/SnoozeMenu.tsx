import { useEffect, useRef, useState } from 'react'
import { formatWakeTime, resolveSnoozePreset, SNOOZE_PRESETS } from '@polycode/shared'

export { timeUntil } from '@polycode/shared'

/**
 * Wake-time picker: presets plus a custom date-time escape hatch.
 *
 * Resolution happens here, client-side, and only the resolved absolute instant
 * is sent. "Morning" means morning where the user is — not where the host
 * machine happens to be, which matters when driving a host in another timezone.
 */
export default function SnoozeMenu({
  onSnooze,
  onClose,
}: {
  onSnooze: (untilIso: string) => void
  onClose: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [custom, setCustom] = useState('')

  // Resolved once per open, so every label in the menu agrees on "now".
  const [now] = useState(() => new Date())

  useEffect(() => {
    function onPointerDown(event: MouseEvent): void {
      if (!containerRef.current?.contains(event.target as Node)) onClose()
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  function commitCustom(): void {
    if (!custom) return
    // `datetime-local` yields a wall-clock string with no zone; `new Date` reads
    // it as local, which is exactly the intent.
    const at = new Date(custom)
    if (Number.isNaN(at.getTime()) || at <= new Date()) return
    onSnooze(at.toISOString())
  }

  return (
    <div
      ref={containerRef}
      className="absolute right-0 top-full z-50 mt-1 w-52 overflow-hidden rounded shadow-lg"
      style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)' }}
      >
        Snooze until
      </div>

      {SNOOZE_PRESETS.map((preset) => {
        const at = resolveSnoozePreset(preset.id, now)
        return (
          <button
            key={preset.id}
            onClick={() => onSnooze(at.toISOString())}
            className="flex w-full items-baseline justify-between gap-2 px-2 py-1.5 text-left text-xs transition-colors hover:bg-white/10"
            style={{ color: 'var(--color-text)' }}
          >
            <span>{preset.label}</span>
            <span className="flex-shrink-0 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
              {formatWakeTime(at, now)}
            </span>
          </button>
        )
      })}

      <div className="flex items-center gap-1 px-2 py-1.5" style={{ borderTop: '1px solid var(--color-border)' }}>
        <input
          type="datetime-local"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitCustom()
          }}
          className="min-w-0 flex-1 rounded px-1 py-0.5 text-[11px] outline-none"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text)',
          }}
        />
        <button
          onClick={commitCustom}
          disabled={!custom}
          className="flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] transition-colors hover:bg-white/10 disabled:opacity-40"
          style={{ color: 'var(--color-text-muted)' }}
        >
          Set
        </button>
      </div>
    </div>
  )
}
