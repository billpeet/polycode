import type { ReactNode } from 'react'

export function SparkleIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v18" />
      <path d="m5.2 7.8 11.6 8.4" />
      <path d="m5.2 16.2 11.6-8.4" />
    </svg>
  )
}

export function SectionHeader({
  label,
  collapsed,
  onToggle,
  badge,
  badgeActive,
  right,
}: {
  label: string
  collapsed: boolean
  onToggle: () => void
  badge?: string
  badgeActive?: boolean
  right?: ReactNode
}) {
  return (
    <div
      className="flex items-center flex-shrink-0"
      style={{ borderBottom: collapsed ? 'none' : '1px solid var(--color-border)' }}
    >
      <button
        onClick={onToggle}
        className="flex flex-1 items-center gap-2 px-3 py-2.5 text-left hover:bg-white/5 transition-colors min-w-0"
        style={{ color: 'var(--color-text)' }}
      >
        <svg
          width="8"
          height="8"
          viewBox="0 0 8 8"
          fill="currentColor"
          style={{
            transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
            flexShrink: 0,
            opacity: 0.5,
          }}
        >
          <path d="M0 2l4 4 4-4z" />
        </svg>
        <span className="text-xs font-semibold">{label}</span>
        {badge && (
          <span
            style={{
              fontSize: '0.6rem',
              fontWeight: 600,
              padding: '1px 5px',
              borderRadius: 999,
              background: badgeActive
                ? 'rgba(232, 123, 95, 0.2)'
                : 'rgba(255,255,255,0.08)',
              color: badgeActive ? 'var(--color-claude)' : 'var(--color-text-muted)',
            }}
          >
            {badge}
          </span>
        )}
      </button>
      {right && <div className="pr-2">{right}</div>}
    </div>
  )
}

export function TabButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider transition-colors"
      style={{
        color: active ? 'var(--color-text)' : 'var(--color-text-muted)',
        borderBottom: active ? '2px solid var(--color-claude)' : '2px solid transparent',
        marginBottom: -1,
      }}
    >
      {label}
    </button>
  )
}
