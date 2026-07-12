import { useCallback, useEffect, useState } from 'react'
import type { BackgroundTerminal } from '../../types/ipc'

export default function BackgroundTerminals({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [terminals, setTerminals] = useState<BackgroundTerminal[]>([])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setTerminals(await window.api.invoke('threads:backgroundTerminals:list', threadId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [threadId])

  useEffect(() => {
    if (!open) return
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [open, refresh])

  async function terminate(processId: string): Promise<void> {
    await window.api.invoke('threads:backgroundTerminals:terminate', threadId, processId)
    await refresh()
  }

  async function cleanAll(): Promise<void> {
    if (!window.confirm('Terminate all background processes started by this Codex thread?')) return
    await window.api.invoke('threads:backgroundTerminals:clean', threadId)
    await refresh()
  }

  return (
    <div className="relative mb-2">
      <button
        onClick={() => setOpen((value) => !value)}
        className="rounded border px-1.5 py-0.5 text-xs"
        style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)', background: 'var(--color-surface)' }}
        title="List Codex background terminal processes"
      >
        Processes{terminals.length > 0 ? ` (${terminals.length})` : ''}
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-1 w-96 rounded-md p-2 shadow-lg" style={{ bottom: '100%', marginBottom: 4, background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold" style={{ color: 'var(--color-text)' }}>Background processes</span>
            <div className="flex gap-2 text-xs">
              <button onClick={() => void refresh()} disabled={loading} style={{ color: 'var(--color-text-muted)' }}>Refresh</button>
              {terminals.length > 0 && <button onClick={() => void cleanAll()} style={{ color: '#f87171' }}>Stop all</button>}
            </div>
          </div>
          {terminals.length === 0 ? (
            <div className="py-2 text-xs" style={{ color: error ? '#f87171' : 'var(--color-text-muted)' }}>{loading ? 'Loading…' : error ?? 'No running background processes.'}</div>
          ) : (
            <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {terminals.map((terminal) => (
                <div key={terminal.processId} className="rounded border p-2" style={{ borderColor: 'var(--color-border)' }}>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs" style={{ color: 'var(--color-text)' }} title={terminal.command}>{terminal.command}</div>
                      <div className="truncate font-mono text-[0.65rem]" style={{ color: 'var(--color-text-muted)' }}>{terminal.cwd}</div>
                      <div className="mt-1 text-[0.65rem]" style={{ color: 'var(--color-text-muted)' }}>
                        process {terminal.processId}{terminal.osPid != null ? ` · PID ${terminal.osPid}` : ''}
                        {terminal.cpuPercent != null ? ` · ${terminal.cpuPercent.toFixed(1)}% CPU` : ''}
                        {terminal.rssKb != null ? ` · ${(terminal.rssKb / 1024).toFixed(1)} MB` : ''}
                      </div>
                    </div>
                    <button onClick={() => void terminate(terminal.processId)} className="text-xs" style={{ color: '#f87171' }}>Stop</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
