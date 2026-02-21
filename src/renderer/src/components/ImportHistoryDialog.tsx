import { useState, useEffect } from 'react'
import { ClaudeProject, ClaudeSession } from '../types/ipc'
import { useThreadStore } from '../stores/threads'

interface Props {
  projectId: string
  projectPath: string
  onClose: () => void
  onImported: () => void
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

function normalizePath(p: string): string {
  return p.toLowerCase().replace(/\\/g, '/')
}

export default function ImportHistoryDialog({ projectId, projectPath, onClose, onImported }: Props) {
  const [sessions, setSessions] = useState<ClaudeSession[]>([])
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')

  const importFromHistory = useThreadStore((s) => s.importFromHistory)

  // Load sessions for matching Claude project on mount
  useEffect(() => {
    async function loadSessions() {
      setLoading(true)
      try {
        const [projects, importedIds] = await Promise.all([
          window.api.invoke('claude-history:listProjects') as Promise<ClaudeProject[]>,
          window.api.invoke('claude-history:importedIds', projectId) as Promise<string[]>
        ])

        // Find matching project by path
        const normalizedProjectPath = normalizePath(projectPath)
        const match = projects.find(p => normalizePath(p.decodedPath) === normalizedProjectPath)

        if (!match) {
          setError(`No Claude Code history found for this project.\nPath: ${projectPath}`)
          setLoading(false)
          return
        }

        const allSessions = await window.api.invoke('claude-history:listSessions', match.encodedPath) as ClaudeSession[]

        // Filter out already imported sessions
        const importedSet = new Set(importedIds)
        const availableSessions = allSessions.filter(s => !importedSet.has(s.sessionId))
        setSessions(availableSessions)
      } catch (err) {
        setError(String(err))
      } finally {
        setLoading(false)
      }
    }
    loadSessions()
  }, [projectId, projectPath])

  async function handleImport(session: ClaudeSession) {
    setImporting(true)
    setError('')
    try {
      const name = session.slug || session.firstMessage.slice(0, 50) || 'Imported thread'
      await importFromHistory(projectId, session.filePath, session.sessionId, name)
      onImported()
      onClose()
    } catch (err) {
      setError(String(err))
      setImporting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={onClose}
    >
      <div
        className="w-[500px] max-h-[70vh] rounded-lg shadow-2xl flex flex-col"
        style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b" style={{ borderColor: 'var(--color-border)' }}>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
            Import from Claude Code
          </h2>
          <p className="text-xs font-mono truncate" style={{ color: 'var(--color-text-muted)' }}>
            {projectPath}
          </p>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-2">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Loading...</span>
            </div>
          )}

          {!loading && error && (
            <div className="px-3 py-8 text-center text-xs whitespace-pre-line" style={{ color: 'var(--color-text-muted)' }}>
              {error}
            </div>
          )}

          {!loading && !error && sessions.length === 0 && (
            <div className="px-3 py-8 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
              No new sessions to import.
              <br />
              <span className="opacity-60">All Claude Code sessions have already been imported.</span>
            </div>
          )}

          {!loading && !error && sessions.map((session) => (
            <button
              key={session.sessionId}
              onClick={() => handleImport(session)}
              disabled={importing}
              className="w-full text-left px-3 py-2.5 rounded hover:bg-white/5 transition-colors disabled:opacity-50"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate" style={{ color: 'var(--color-text)' }}>
                    {session.slug || session.firstMessage || session.sessionId.slice(0, 8)}
                  </div>
                  {session.slug && session.firstMessage && (
                    <div className="text-xs truncate mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                      {session.firstMessage}
                    </div>
                  )}
                </div>
                <div className="flex-shrink-0 text-right">
                  <div className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                    {session.messageCount} msgs
                  </div>
                  <div className="text-[10px]" style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>
                    {relativeTime(session.lastActivity)}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t flex justify-end" style={{ borderColor: 'var(--color-border)' }}>
          <button
            onClick={onClose}
            className="rounded px-4 py-1.5 text-xs"
            style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
