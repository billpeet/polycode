import { useCliHealthStore } from '../../stores/cliHealth'

export default function CliHealthIndicator({ threadId }: { threadId: string }) {
  const health = useCliHealthStore((s) => s.healthByThread[threadId])

  if (!health || health.status === 'idle') return null

  if (health.status === 'checking') {
    return (
      <span title="Checking CLI availability…" style={{ color: 'var(--color-text-muted)', lineHeight: 1 }}>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="animate-spin">
          <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.418A6 6 0 1 1 8 2v1z" />
        </svg>
      </span>
    )
  }

  if (health.status === 'ok') {
    return (
      <span
        title={`CLI available${health.result?.currentVersion ? ` (v${health.result.currentVersion})` : ''}`}
        style={{ color: '#4ade80', lineHeight: 1 }}
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="2,8 6,12 14,4" />
        </svg>
      </span>
    )
  }

  const msg = health.status === 'unavailable'
    ? 'CLI not found - install it or update the path'
    : `CLI check failed: ${health.error ?? 'unknown error'}`

  return (
    <span title={msg} style={{ color: '#f87171', lineHeight: 1 }}>
      <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z" />
        <path d="M7.002 11a1 1 0 1 1 2 0 1 1 0 0 1-2 0zM7.1 4.995a.905.905 0 1 1 1.8 0l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 4.995z" />
      </svg>
    </span>
  )
}
