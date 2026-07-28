import { useState, useRef, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface TooltipProps {
  content: ReactNode
  side?: 'right' | 'top' | 'bottom'
  contentClassName?: string
  children: ReactNode
}

export function Tooltip({ content, side = 'right', contentClassName, children }: TooltipProps) {
  const [show, setShow] = useState(false)
  const [tooltipStyle, setTooltipStyle] = useState<CSSProperties>()
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const anchorRef = useRef<HTMLDivElement | null>(null)

  function onEnter() {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return

    if (side === 'right') {
      setTooltipStyle({
        position: 'fixed',
        left: rect.right + 8,
        top: rect.top + rect.height / 2,
        transform: 'translateY(-50%)',
      })
    } else if (side === 'bottom') {
      setTooltipStyle({
        position: 'fixed',
        left: rect.left + rect.width / 2,
        top: rect.bottom + 8,
        transform: 'translateX(-50%)',
      })
    } else {
      setTooltipStyle({
        position: 'fixed',
        left: rect.left + rect.width / 2,
        top: rect.top - 8,
        transform: 'translate(-50%, -100%)',
      })
    }

    timeoutRef.current = setTimeout(() => setShow(true), 400)
  }

  function onLeave() {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current)
    }
    setShow(false)
  }

  return (
    <div ref={anchorRef} className="relative" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      {children}
      {show && tooltipStyle && typeof document !== 'undefined'
        ? createPortal(
            <div
              className={`z-[9999] whitespace-nowrap rounded px-2 py-1 text-xs pointer-events-none ${contentClassName ?? ''}`}
              style={{
                ...tooltipStyle,
                background: 'var(--color-surface-2)',
                color: 'var(--color-text)',
                border: '1px solid var(--color-border)',
                boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
              }}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
