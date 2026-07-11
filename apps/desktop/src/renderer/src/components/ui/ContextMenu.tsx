import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface ContextMenuItem {
  /** Unique id — used as the React key. */
  id: string
  /** Label to display. */
  label: ReactNode
  /** Optional leading icon. */
  icon?: ReactNode
  /** Called when the item is activated. The menu closes automatically afterwards. */
  onSelect: () => void | Promise<void>
  /** When true, the item is rendered dimmed and cannot be activated. */
  disabled?: boolean
  /** Tooltip shown on hover. */
  title?: string
  /** Render the item with destructive styling (red label). */
  destructive?: boolean
  /** Show a divider line above this item. */
  separator?: boolean
}

interface ContextMenuProps {
  /** Anchor position in viewport pixels. The menu opens roughly at this point. */
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

/**
 * A lightweight context menu rendered at fixed coordinates.
 * Closes on outside click, Escape, scroll, or window blur.
 * Automatically flips to stay inside the viewport.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ x, y })

  // Close on outside click / Escape / scroll / blur.
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (!ref.current) return
      if (e.target instanceof Node && ref.current.contains(e.target)) return
      onClose()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    function onScroll() { onClose() }
    function onBlur() { onClose() }
    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [onClose])

  // After mount, flip horizontally/vertically if the menu would overflow the viewport.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let nx = x
    let ny = y
    const pad = 4
    if (nx + rect.width + pad > window.innerWidth) nx = Math.max(pad, window.innerWidth - rect.width - pad)
    if (ny + rect.height + pad > window.innerHeight) ny = Math.max(pad, window.innerHeight - rect.height - pad)
    setPos({ x: nx, y: ny })
  }, [x, y])

  return (
    <div
      ref={ref}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[9999] rounded py-1 text-xs shadow-lg"
      style={{
        left: pos.x,
        top: pos.y,
        minWidth: 180,
        background: 'var(--color-surface-2)',
        border: '1px solid var(--color-border)',
        color: 'var(--color-text)',
      }}
    >
      {items.map((item) => (
        <div key={item.id}>
          {item.separator && <div className="my-1" style={{ borderTop: '1px solid var(--color-border)' }} />}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            title={item.title}
            onClick={async () => {
              if (item.disabled) return
              onClose()
              try { await item.onSelect() } catch { /* handled upstream via toast */ }
            }}
            className="w-full flex items-center gap-2 px-2.5 py-1 text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/10"
            style={{ color: item.destructive ? '#f87171' : 'inherit' }}
          >
            {item.icon && <span className="inline-flex items-center justify-center w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>{item.icon}</span>}
            <span className="flex-1 truncate">{item.label}</span>
          </button>
        </div>
      ))}
    </div>
  )
}
