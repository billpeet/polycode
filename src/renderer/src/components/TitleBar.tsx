import { useEffect, useState } from 'react'
import { RemoteHost } from '../types/ipc'

export default function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false)
  const [hosts, setHosts] = useState<RemoteHost[]>([])
  const [activeHost, setActiveHost] = useState<RemoteHost | null>(null)

  useEffect(() => {
    window.api.invoke('window:is-maximized').then((maximized) => {
      setIsMaximized((prev) => (prev === maximized ? prev : maximized))
    })
    return window.api.on('window:maximized-changed', (maximized) => {
      const next = maximized as boolean
      setIsMaximized((prev) => (prev === next ? prev : next))
    })
  }, [])

  useEffect(() => {
    async function loadRemoteState() {
      const [savedHosts, active] = await Promise.all([
        window.api.invoke('remote:getHosts'),
        window.api.invoke('remote:getActiveHost'),
      ])
      setHosts(savedHosts)
      setActiveHost(active)
    }

    void loadRemoteState()
    const offActive = window.api.on('remote:active-changed', (...args) => {
      setActiveHost((args[0] as RemoteHost | null) ?? null)
      void window.api.invoke('remote:getHosts').then(setHosts).catch(() => undefined)
    })
    const offHosts = window.api.on('remote:hosts-changed', (...args) => {
      setHosts((args[0] as RemoteHost[] | undefined) ?? [])
    })
    return () => {
      offActive()
      offHosts()
    }
  }, [])

  function switchHost(id: string) {
    void window.api.invoke('remote:setActiveHost', id === 'local' ? null : id)
      .then((host) => setActiveHost(host))
      .catch((error) => console.error('[remote] Failed to switch host', error))
  }

  function minimize() {
    window.api.invoke('window:minimize')
  }

  function maximize() {
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
      <div
        style={{
          position: 'absolute',
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        <span
          style={{
            fontSize: 12,
            color: activeHost ? 'var(--color-text)' : 'var(--color-text-muted)',
            userSelect: 'none',
          }}
        >
          PolyCode
        </span>
        <select
          value={activeHost?.id ?? 'local'}
          onChange={(event) => switchHost(event.target.value)}
          title={activeHost ? `Remote: ${activeHost.label}` : 'Local instance'}
          style={{
            height: 22,
            maxWidth: 220,
            borderRadius: 4,
            border: `1px solid ${activeHost ? 'var(--color-claude)' : 'var(--color-border)'}`,
            background: activeHost ? 'color-mix(in srgb, var(--color-claude) 18%, var(--color-surface))' : 'var(--color-surface-2)',
            color: 'var(--color-text)',
            fontSize: 11,
            padding: '0 6px',
            outline: 'none',
          }}
        >
          <option value="local">Local</option>
          {hosts.map((host) => (
            <option key={host.id} value={host.id}>
              Remote: {host.label}
            </option>
          ))}
        </select>
      </div>

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
