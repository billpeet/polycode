import { useState, useRef, type ReactNode } from 'react'

interface TooltipProps {
  content: string
  side?: 'right' | 'top' | 'bottom'
  children: ReactNode
}

export function Tooltip({ content, side = 'right', children }: TooltipProps) {
  const [show, setShow] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function onEnter() {
    timeoutRef.current = setTimeout(() => setShow(true), 400)
  }

  function onLeave() {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current)
    }
    setShow(false)
  }

  const positionClass =
    side === 'right' ? 'left-full top-1/2 -translate-y-1/2 ml-2'
    : side === 'top' ? 'bottom-full left-1/2 -translate-x-1/2 mb-2'
    : 'top-full left-1/2 -translate-x-1/2 mt-2'

  return (
    <div className="relative" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      {children}
      {show && (
        <div
          className={`absolute z-50 whitespace-nowrap rounded px-2 py-1 text-xs pointer-events-none ${positionClass}`}
          style={{
            background: 'var(--color-surface-2)',
            color: 'var(--color-text)',
            border: '1px solid var(--color-border)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          }}
        >
          {content}
        </div>
      )}
    </div>
  )
}
