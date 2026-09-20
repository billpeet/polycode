import { useEffect, useState } from 'react'
import type { AppProfile, SeedCatalog } from '@polycode/shared'
import { client } from '../lib/client'
import { useProjectStore } from '../stores/projects'
import { useThreadStore } from '../stores/threads'

const controlStyle = { background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }

export function SeedProductionPanel({ profile }: { profile: AppProfile }) {
  const [sourcePath, setSourcePath] = useState(profile.productionDatabasePath)
  const [catalog, setCatalog] = useState<SeedCatalog | null>(null)
  const [mode, setMode] = useState<'threads' | 'projects'>('threads')
  const [projectId, setProjectId] = useState('')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [projectIds, setProjectIds] = useState<string[]>([])
  const [threadIds, setThreadIds] = useState<string[]>([])
  const [loadedRequest, setLoadedRequest] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const browseRequest = JSON.stringify({ sourcePath, projectId: projectId || undefined, search, offset, refresh })
  const loading = loadedRequest !== browseRequest

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      setError('')
      void client.invoke('seed:browse', { sourcePath, projectId: projectId || undefined, search, offset })
        .then((value) => { if (!cancelled) setCatalog(value) })
        .catch((reason: unknown) => { if (!cancelled) { setCatalog(null); setError(String(reason)) } })
        .finally(() => { if (!cancelled) setLoadedRequest(browseRequest) })
    }, 200)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [sourcePath, projectId, search, offset, refresh, browseRequest])

  async function chooseSource(): Promise<void> {
    try {
      const path = await client.invoke('seed:choose-source')
      if (!path) return
      setSourcePath(path)
      setProjectId('')
      setSearch('')
      setOffset(0)
      setProjectIds([])
      setThreadIds([])
      setCatalog(null)
      setNotice('')
      setRefresh((value) => value + 1)
    } catch (reason) { setError(String(reason)) }
  }

  function toggle(ids: string[], id: string): string[] {
    return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id]
  }

  async function importSelection(): Promise<void> {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await client.invoke('seed:import', { sourcePath, projectIds, threadIds })
      setNotice(`Imported ${result.projectsCreated} new projects, ${result.threadsCreated} thread copies and ${result.messagesCreated} messages. Existing projects were reused.`)
      setProjectIds([])
      setThreadIds([])
      await useProjectStore.getState().fetch()
      await Promise.all(result.projectIds.map((id) => useThreadStore.getState().fetch(id)))
      await useThreadStore.getState().fetchQueue()
    } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }

  return (
    <div className="flex flex-col gap-3 text-xs" style={{ color: 'var(--color-text)' }}>
      <h3 className="text-sm font-semibold">Seed from production DB</h3>
      <p style={{ color: 'var(--color-text-muted)' }}>Copy selected history into your development profile. Production stays open and unchanged.</p>
      <details style={{ color: 'var(--color-text-muted)' }}>
        <summary className="cursor-pointer">What gets copied?</summary>
        <p className="mt-2">Projects include locations and project commands, without threads. Thread copies include their project, sessions and messages. Existing project configuration stays unchanged. Each import creates new thread copies.</p>
        <p className="mt-2">Active copies are stopped. Provider resume IDs, routines, global settings, credentials and attachment files are not imported. New turns start fresh provider sessions. Repository paths still point to the same files. Imported worktrees are ordinary locations and automatic project commands are disabled.</p>
        <p className="mt-2 break-all">Development data: {profile.dataPath}</p>
      </details>
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate" title={sourcePath}>{sourcePath}</span>
        <button className="rounded px-2 py-1 disabled:opacity-50" style={controlStyle} disabled={busy} onClick={() => void chooseSource()}>Choose DB…</button>
        <button className="rounded px-2 py-1 disabled:opacity-50" style={controlStyle} disabled={busy || loading} onClick={() => setRefresh((value) => value + 1)}>Refresh</button>
      </div>
      <div className="flex gap-2" role="tablist" aria-label="Seed selection">
        <button role="tab" aria-selected={mode === 'threads'} className="rounded px-2 py-1" style={controlStyle} onClick={() => setMode('threads')}>Individual threads</button>
        <button role="tab" aria-selected={mode === 'projects'} className="rounded px-2 py-1" style={controlStyle} onClick={() => setMode('projects')}>Projects only</button>
      </div>
      {mode === 'threads' && <div className="flex gap-2">
        <input aria-label="Search production threads" placeholder="Search thread or project…" className="min-w-0 flex-1 rounded px-2 py-1" style={controlStyle} disabled={busy} value={search} onChange={(event) => { setSearch(event.target.value); setOffset(0) }} />
        <select aria-label="Filter by project" className="max-w-36 rounded px-1" style={controlStyle} disabled={busy} value={projectId} onChange={(event) => { setProjectId(event.target.value); setOffset(0) }}>
          <option value="">All projects</option>
          {catalog?.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </div>}
      {loading && <p role="status">Loading production history…</p>}
      {!loading && catalog && <div className="max-h-52 overflow-y-auto rounded" style={controlStyle}>
        {mode === 'projects' ? <>
          {catalog.projects.length === 0 && <p className="p-2">No projects found.</p>}
          {catalog.projects.map((project) => <label key={project.id} className="flex items-center gap-2 p-2 cursor-pointer">
            <input type="checkbox" disabled={busy} checked={projectIds.includes(project.id)} onChange={() => setProjectIds((ids) => toggle(ids, project.id))} />
            {project.name}
          </label>)}
        </> : <>
          {catalog.threads.length === 0 && <p className="p-2">No matching threads.</p>}
          {catalog.threads.map((thread) => <label key={thread.id} className="flex items-start gap-2 p-2 cursor-pointer">
            <input type="checkbox" className="mt-0.5" disabled={busy} checked={threadIds.includes(thread.id)} onChange={() => setThreadIds((ids) => toggle(ids, thread.id))} />
            <span className="min-w-0"><span className="block truncate">{thread.name}</span><span style={{ color: 'var(--color-text-muted)' }}>{thread.projectName} · {thread.status} · {new Date(thread.updatedAt).toLocaleString()}</span></span>
          </label>)}
        </>}
      </div>}
      {mode === 'threads' && <div className="flex items-center justify-between">
        <button disabled={busy || loading || offset === 0} className="disabled:opacity-40" onClick={() => setOffset((value) => Math.max(0, value - 50))}>Previous</button>
        <span>Page {Math.floor(offset / 50) + 1} · Newest first</span>
        <button disabled={busy || loading || !catalog?.hasMore} className="disabled:opacity-40" onClick={() => setOffset((value) => value + 50)}>Next</button>
      </div>}
      <p>{projectIds.length} projects and {threadIds.length} threads selected across all pages.</p>
      <div className="flex gap-3">
        <button disabled={busy || loading || !catalog || (!projectIds.length && !threadIds.length)} className="rounded px-3 py-1.5 disabled:opacity-40" style={controlStyle} onClick={() => void importSelection()}>{busy ? 'Importing…' : 'Import selected'}</button>
        <button disabled={busy} onClick={() => { setProjectIds([]); setThreadIds([]) }}>Clear selection</button>
      </div>
      {error && <p role="alert" className="break-words" style={{ color: 'var(--color-error, #ef4444)' }}>{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </div>
  )
}
