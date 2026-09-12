import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Gauge, RefreshCw } from 'lucide-react'
import { subscriptionUsageProviderFor, type Provider, type SubscriptionUsageSnapshot, type SubscriptionUsageWindow } from '../../types/ipc'
import { client } from '../../lib/client'

const REFRESH_INTERVAL_MS = 5 * 60 * 1000

function formatReset(resetsAt: number | null, now: number): string {
  if (!resetsAt) return 'Reset time unavailable'
  const seconds = Math.max(0, Math.round(resetsAt - now / 1000))
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `Resets in ${days}d ${hours}h`
  if (hours > 0) return `Resets in ${hours}h ${minutes}m`
  return `Resets in ${minutes}m`
}

function formatAge(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 60) return 'Updated just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `Updated ${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Updated ${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `Updated ${days} day${days === 1 ? '' : 's'} ago`
}

function windowElapsedPercent(window: SubscriptionUsageWindow, now: number): number | null {
  if (!window.resetsAt || !window.durationMinutes) return null
  const durationSeconds = window.durationMinutes * 60
  const remainingSeconds = window.resetsAt - now / 1000
  return Math.max(0, Math.min(100, (1 - remainingSeconds / durationSeconds) * 100))
}

function windowPercent(window: SubscriptionUsageWindow): number | null {
  return window.usedPercent == null ? null : Math.max(0, Math.min(100, window.usedPercent))
}

type Pace = { label: string; color: string; ahead: boolean }

function describePace(used: number | null, elapsed: number | null): Pace | null {
  if (used == null || elapsed == null) return null
  const delta = Math.round(used - elapsed)
  if (Math.abs(delta) <= 3) return { label: 'On pace', color: 'var(--color-text-muted)', ahead: false }
  if (delta > 0) return { label: `${delta} pts ahead of pace`, color: '#fbbf24', ahead: true }
  return { label: `${-delta} pts under pace`, color: '#4ade80', ahead: false }
}

function tightestWindow(windows: SubscriptionUsageWindow[]): SubscriptionUsageWindow | null {
  return windows.reduce<SubscriptionUsageWindow | null>((tightest, window) => {
    if (window.usedPercent == null) return tightest
    return !tightest || (tightest.usedPercent ?? -1) < window.usedPercent ? window : tightest
  }, null)
}

export default function SubscriptionUsageIndicator({ threadId, provider, model }: { threadId: string; provider: Provider; model?: string }) {
  const usageProvider = subscriptionUsageProviderFor(provider, model)
  const supported = usageProvider !== null
  const [snapshot, setSnapshot] = useState<SubscriptionUsageSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    if (!supported) return
    setLoading(true)
    setError(null)
    try {
      setSnapshot(await client.invoke('subscription-usage:get', threadId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Usage unavailable')
    } finally {
      setLoading(false)
    }
  }, [supported, threadId])

  useEffect(() => {
    if (!supported) return
    const initialRefresh = window.setTimeout(() => void refresh(), 0)
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS)
    return () => {
      window.clearTimeout(initialRefresh)
      window.clearInterval(interval)
    }
  }, [provider, model, refresh, supported])

  useEffect(() => {
    if (!open) return
    const tick = window.setInterval(() => setNow(Date.now()), 30_000)
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => {
      window.clearInterval(tick)
      document.removeEventListener('mousedown', close)
    }
  }, [open])

  const currentSnapshot = snapshot?.provider === usageProvider ? snapshot : null
  const tightest = useMemo(() => tightestWindow(currentSnapshot?.windows ?? []), [currentSnapshot])
  if (!supported) return null

  const percent = tightest ? windowPercent(tightest) : null
  const accent = percent != null && percent >= 90
    ? '#f87171'
    : percent != null && percent >= 70
      ? '#fbbf24'
      : 'var(--color-text-muted)'
  const providerLabel = usageProvider === 'codex' ? 'OpenAI' : usageProvider === 'glm' ? 'Z.ai' : 'Anthropic'

  return (
    <div ref={rootRef} className="relative mb-2">
      <button
        type="button"
        onClick={() => {
          setNow(Date.now())
          setOpen((value) => !value)
        }}
        className="flex h-[26px] items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors hover:bg-white/5"
        style={{ color: accent, border: '1px solid var(--color-border)', background: open ? 'var(--color-surface)' : 'transparent' }}
        title={`${providerLabel} subscription usage`}
      >
        <Gauge size={13} strokeWidth={1.8} />
        {loading && !currentSnapshot ? 'Usage…' : percent == null ? 'Usage' : `${Math.round(percent)}%`}
      </button>

      {open && (
        <div
          className="absolute bottom-[46px] right-0 z-50 w-72 overflow-hidden rounded-xl shadow-2xl"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
        >
          <div className="flex items-start justify-between px-3.5 pb-3 pt-3.5" style={{ borderBottom: '1px solid var(--color-border)' }}>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--color-text-muted)' }}>
                {providerLabel} quota
              </div>
              <div className="mt-0.5 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {currentSnapshot?.plan ? `${currentSnapshot.plan} plan · ` : ''}{currentSnapshot ? formatAge(currentSnapshot.observedAt, now) : 'No snapshot yet'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              className="rounded-md p-1.5 transition-colors hover:bg-white/5 disabled:opacity-40"
              style={{ color: 'var(--color-text-muted)' }}
              title="Refresh usage"
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>

          <div className="space-y-3 p-3.5">
            {currentSnapshot?.windows.map((window) => {
              const used = windowPercent(window)
              const elapsed = windowElapsedPercent(window, now)
              const pace = describePace(used, elapsed)
              const fill = used != null && used >= 90
                ? '#f87171'
                : pace?.ahead || (used != null && used >= 70)
                  ? '#fbbf24'
                  : usageProvider === 'codex' ? '#60a5fa' : usageProvider === 'glm' ? '#34d399' : 'var(--color-claude)'
              return (
                <div key={window.id}>
                  <div className="mb-1.5 flex items-baseline justify-between">
                    <span className="text-xs font-medium" style={{ color: 'var(--color-text)' }}>{window.label}</span>
                    <span className="font-mono text-xs tabular-nums" style={{ color: used != null && used >= 90 ? '#f87171' : 'var(--color-text-muted)' }}>
                      {used == null ? '—' : `${Math.round(used)}% used`}
                    </span>
                  </div>
                  <div className="relative py-1.5">
                    <div className="h-2 overflow-hidden rounded-full" style={{ background: 'rgba(255,255,255,0.07)' }}>
                      <div
                        className="h-full rounded-full transition-[width] duration-500"
                        style={{ width: `${used ?? 0}%`, background: fill }}
                      />
                    </div>
                    {elapsed != null && (
                      <div
                        className="pointer-events-none absolute top-0 bottom-0 w-0.5 -translate-x-1/2 rounded-full bg-white/80"
                        style={{ left: `${elapsed}%`, boxShadow: '0 0 0 1px var(--color-surface)' }}
                        title={`${Math.round(elapsed)}% of window elapsed`}
                      />
                    )}
                  </div>
                  <div className="mt-0.5 flex items-baseline justify-between text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                    <span>{formatReset(window.resetsAt, now)}{elapsed == null ? '' : ` · ${Math.round(elapsed)}% elapsed`}</span>
                    {pace && <span className="font-medium" style={{ color: pace.color }}>{pace.label}</span>}
                  </div>
                </div>
              )
            })}

            {!loading && currentSnapshot?.windows.length === 0 && (
              <div className="text-xs leading-5" style={{ color: 'var(--color-text-muted)' }}>
                No subscription quota was returned. Check that this provider is signed in with a subscription account.
              </div>
            )}
            {error && <div className="text-xs leading-5" style={{ color: '#f87171' }}>{error}</div>}
            {loading && !currentSnapshot && <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Reading provider quota…</div>}
          </div>
        </div>
      )}
    </div>
  )
}
