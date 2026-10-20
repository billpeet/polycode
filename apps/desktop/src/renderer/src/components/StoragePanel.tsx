import { useCallback, useEffect, useState } from 'react'
import type { StorageInfo } from '@polycode/shared'
import { client } from '../lib/client'

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  return `${Math.max(bytes / 1024, 0).toFixed(0)} KB`
}

/** This machine's database: its size, the background output cleanup, and compaction. */
export function StoragePanel() {
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [compacting, setCompacting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    client.invoke('storage:getInfo').then(setInfo, (failure: unknown) => setError(String(failure)))
  }, [])

  useEffect(() => {
    refresh()
    // Follow the cleanup while it runs.
    const interval = window.setInterval(refresh, 3_000)
    return () => window.clearInterval(interval)
  }, [refresh])

  const compact = () => {
    setCompacting(true)
    setError(null)
    client.invoke('storage:compact').then(
      (next) => { setInfo(next); setCompacting(false) },
      (failure: unknown) => { setError(String(failure)); setCompacting(false) },
    )
  }

  const muted = { color: 'var(--color-text-muted)' }
  return (
    <div className="flex flex-col gap-4 text-sm" style={{ color: 'var(--color-text)' }}>
      <div>
        <div className="font-medium">Database</div>
        <div className="text-xs" style={muted}>
          {info
            ? `${formatBytes(info.fileBytes)} on disk, of which ${formatBytes(info.freeBytes)} is free space left by deleted rows.`
            : 'Reading…'}
        </div>
      </div>

      {info && (
        <div>
          <div className="font-medium">Codex output cleanup</div>
          <div className="text-xs" style={muted}>
            {info.cleanup.done
              ? `Finished. ${info.cleanup.deletedRows.toLocaleString()} redundant output rows removed.`
              : `Running in the background: ${Math.round(info.cleanup.progress * 100)}%, ${info.cleanup.deletedRows.toLocaleString()} redundant output rows removed so far. Transcripts look the same before and after.`}
          </div>
        </div>
      )}

      {info && (
        <div className="flex flex-col gap-2">
          <div className="font-medium">Compact</div>
          <div className="text-xs" style={muted}>
            Rewrites the database file without its free space. PolyCode stops responding until it
            finishes, which can take a minute or two for a large database, and it needs about as
            much free disk space as the file's size.
          </div>
          <div>
            <button
              onClick={compact}
              disabled={compacting || !info.cleanup.done || info.freeBytes === 0}
              className="rounded px-2.5 py-1 text-xs hover:opacity-90 disabled:opacity-50"
              style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
              title={info.cleanup.done ? undefined : 'Available once the cleanup has finished'}
            >
              {compacting ? 'Compacting…' : `Compact database${info.freeBytes > 0 ? ` (free ${formatBytes(info.freeBytes)})` : ''}`}
            </button>
          </div>
        </div>
      )}

      {error && <div className="text-xs" style={{ color: '#f87171' }}>{error}</div>}
    </div>
  )
}
