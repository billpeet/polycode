import { useEffect, useState } from 'react'

export default function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    window.api.invoke('window:is-maximized').then(setIsMaximized)
  }, [])

  function minimize() {
    window.api.invoke('window:minimize')
  }

  function maximize() {
    setIsMaximized((prev) => !prev)
    window.api.invoke('window:maximize')
  }

  function close() {
    window.api.invoke('window:close')
  }

  return (
    <div
      style={{
        height: 32,
        display: 'flex',
        alignItems: 'center',
        background: 'var(--color-surface)',
        borderBottom: '1px solid var(--color-border)',
        flexShrink: 0,
        position: 'relative',
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      <span
        style={{
          position: 'absolute',
          left: '50%',
          transform: 'translateX(-50%)',
          fontSize: 12,
          color: 'var(--color-text-muted)',
          userSelect: 'none',
          pointerEvents: 'none',
        }}
      >
        Polycode
      </span>

      <div style={{ flex: 1 }} />

      <div
        style={{
          display: 'flex',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        <WinButton onClick={minimize} title="Minimize" hoverColor="var(--color-surface-2)">
          <svg width="10" height="1" viewBox="0 0 10 1">
            <rect width="10" height="1" fill="currentColor" />
          </svg>
        </WinButton>
        <WinButton onClick={maximize} title={isMaximized ? 'Restore' : 'Maximize'} hoverColor="var(--color-surface-2)">
          {isMaximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <rect x="2" y="0" width="8" height="8" stroke="currentColor" strokeWidth="1" />
              <rect x="0" y="2" width="8" height="8" fill="var(--color-surface)" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </WinButton>
        <WinButton onClick={close} title="Close" hoverColor="#cc2222" hoverTextColor="#ffffff">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2" />
            <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </WinButton>
      </div>
    </div>
  )
}

interface WinButtonProps {
  onClick: () => void
  title: string
  hoverColor: string
  hoverTextColor?: string
  children: React.ReactNode
}

function WinButton({ onClick, title, hoverColor, hoverTextColor, children }: WinButtonProps) {
  const [hovered, setHovered] = useState(false)

  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 46,
        height: 32,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: hovered ? hoverColor : 'transparent',
        border: 'none',
        color: hovered && hoverTextColor ? hoverTextColor : 'var(--color-text-muted)',
        cursor: 'default',
        transition: 'background 0.1s, color 0.1s',
        padding: 0,
      }}
    >
      {children}
    </button>
  )
}
