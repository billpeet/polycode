import { useState, useRef, useEffect, KeyboardEvent } from 'react'
import { useThreadStore } from '../stores/threads'
import { useProjectStore } from '../stores/projects'
import { useTodoStore, Todo } from '../stores/todos'
import { useUiStore } from '../stores/ui'
import { useGitStore } from '../stores/git'
import { useToastStore } from '../stores/toast'
import { PROVIDERS, getModelsForProvider, getDefaultModelForProvider, MODEL_CONTEXT_LIMITS, DEFAULT_CONTEXT_LIMIT, Provider } from '../types/ipc'

const EMPTY_DISTROS: string[] = []

const EMPTY_TODOS: Todo[] = []

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

interface Props {
  threadId: string
}

export default function ThreadHeader({ threadId }: Props) {
  const byProject = useThreadStore((s) => s.byProject)
  const statusMap = useThreadStore((s) => s.statusMap)
  const rename = useThreadStore((s) => s.rename)
  const setModel = useThreadStore((s) => s.setModel)
  const setProviderAndModel = useThreadStore((s) => s.setProviderAndModel)
  const setWsl = useThreadStore((s) => s.setWsl)

  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const projects = useProjectStore((s) => s.projects)

  const project = projects.find((p) => p.id === selectedProjectId)
  const threads = selectedProjectId ? (byProject[selectedProjectId] ?? []) : []
  const thread = threads.find((t) => t.id === threadId)
  const status = statusMap[threadId] ?? 'idle'

  const todos = useTodoStore((s) => s.todosByThread[threadId] ?? EMPTY_TODOS)
  const todoTotal = todos.length
  const todoCompleted = todos.filter((t) => t.status === 'completed').length
  const hasInProgress = todos.some((t) => t.status === 'in_progress')
  const isPanelOpen = useUiStore((s) => s.todoPanelOpenByThread[threadId] ?? false)
  const togglePanel = useUiStore((s) => s.toggleTodoPanel)

  const usage = useThreadStore((s) => s.usageByThread[threadId])

  const fetchGit = useGitStore((s) => s.fetch)
  const gitStatus = useGitStore((s) =>
    project?.path ? (s.statusByPath[project.path] ?? null) : null
  )
  const pushGit = useGitStore((s) => s.push)
  const pullGit = useGitStore((s) => s.pull)
  const isPushing = useGitStore((s) => project?.path ? (s.pushingByPath[project.path] ?? false) : false)
  const isPulling = useGitStore((s) => project?.path ? (s.pullingByPath[project.path] ?? false) : false)
  const addToast = useToastStore((s) => s.add)

  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const [availableDistros, setAvailableDistros] = useState<string[]>(EMPTY_DISTROS)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.select()
    }
  }, [editing])

  // Poll git status when a project is selected
  useEffect(() => {
    if (!project?.path) return
    fetchGit(project.path)
    const interval = setInterval(() => fetchGit(project.path), 10_000)
    return () => clearInterval(interval)
  }, [project?.path, fetchGit])

  // Fetch available WSL distros when this thread has WSL enabled
  useEffect(() => {
    if (!thread?.use_wsl) return
    window.api.invoke('wsl:list-distros').then((distros) => {
      setAvailableDistros(distros.length > 0 ? distros : EMPTY_DISTROS)
    })
  }, [thread?.use_wsl])

  const statusColor =
    status === 'running'
      ? '#4ade80'
      : status === 'error'
        ? '#f87171'
        : status === 'stopped'
          ? '#facc15'
          : 'var(--color-text-muted)'

  function startEditing(): void {
    setEditValue(thread?.name ?? '')
    setEditing(true)
  }

  async function commitRename(): Promise<void> {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== thread?.name) {
      await rename(threadId, trimmed)
    }
    setEditing(false)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename()
    } else if (e.key === 'Escape') {
      setEditing(false)
    }
  }

  return (
    <div
      className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
    >
      <div className="flex items-center gap-3 min-w-0">
        {status === 'running' ? (
          <span className="h-2.5 w-2.5 flex-shrink-0 status-spinner" />
        ) : (
          <span
            className="h-2.5 w-2.5 rounded-full flex-shrink-0"
            style={{ background: statusColor }}
          />
        )}
        {editing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={commitRename}
            className="text-sm font-medium bg-transparent border-b outline-none min-w-0"
            style={{
              color: 'var(--color-text)',
              borderColor: 'var(--color-claude)',
              width: `${Math.max(editValue.length, 8)}ch`
            }}
          />
        ) : (
          <button
            onClick={startEditing}
            className="text-sm font-medium truncate text-left hover:opacity-70 transition-opacity"
            style={{ color: 'var(--color-text)' }}
            title="Click to rename"
          >
            {thread?.name ?? 'New thread'}
          </button>
        )}
        <select
          value={thread?.provider ?? 'claude-code'}
          onChange={(e) => {
            const provider = e.target.value as Provider
            const defaultModel = getDefaultModelForProvider(provider)
            setProviderAndModel(threadId, provider, defaultModel)
          }}
          disabled={status === 'running'}
          className="text-xs flex-shrink-0 bg-transparent border rounded px-1.5 py-0.5 outline-none cursor-pointer"
          style={{
            color: 'var(--color-text-muted)',
            borderColor: 'var(--color-border)',
            background: 'var(--color-surface)',
            opacity: status === 'running' ? 0.4 : 1,
          }}
          title="Select provider"
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id} style={{ background: 'var(--color-surface)', color: 'var(--color-text)' }}>
              {p.label}
            </option>
          ))}
        </select>
        <select
          value={thread?.model ?? getDefaultModelForProvider((thread?.provider ?? 'claude-code') as Provider)}
          onChange={(e) => setModel(threadId, e.target.value)}
          disabled={status === 'running'}
          className="text-xs flex-shrink-0 bg-transparent border rounded px-1.5 py-0.5 outline-none cursor-pointer"
          style={{
            color: 'var(--color-text-muted)',
            borderColor: 'var(--color-border)',
            background: 'var(--color-surface)',
            opacity: status === 'running' ? 0.4 : 1,
          }}
          title="Select model"
        >
          {getModelsForProvider((thread?.provider ?? 'claude-code') as Provider).map((m) => (
            <option key={m.id} value={m.id} style={{ background: 'var(--color-surface)', color: 'var(--color-text)' }}>
              {m.label}
            </option>
          ))}
        </select>

        {/* WSL toggle (editable before first message) or badge (after first message) */}
        {/* Only shown for local projects — SSH and project-level WSL projects handle transport differently */}
        {project && !project.ssh && !project.wsl && thread && (() => {
          if (thread.has_messages) {
            // Thread has been started — show a read-only badge if WSL was enabled
            if (!thread.use_wsl) return null
            return (
              <span
                className="text-xs px-1.5 py-0.5 rounded flex-shrink-0"
                style={{
                  background: 'rgba(99, 179, 237, 0.1)',
                  color: '#63b3ed',
                  border: '1px solid rgba(99, 179, 237, 0.3)',
                  fontFamily: 'monospace',
                }}
                title={`Running on WSL${thread.wsl_distro ? `: ${thread.wsl_distro}` : ''}`}
              >
                WSL{thread.wsl_distro ? `: ${thread.wsl_distro}` : ''}
              </span>
            )
          }

          // New thread — show editable toggle
          const isWslOn = thread.use_wsl
          return (
            <>
              <button
                onClick={async () => {
                  const next = !isWslOn
                  let distro = thread.wsl_distro
                  if (next && !distro) {
                    // Auto-select first available distro
                    const distros = availableDistros.length > 0
                      ? availableDistros
                      : await window.api.invoke('wsl:list-distros').then((d) => {
                          setAvailableDistros(d)
                          return d
                        })
                    distro = distros[0] ?? null
                  }
                  await setWsl(threadId, next, next ? distro : null)
                }}
                disabled={status === 'running'}
                className="text-xs px-1.5 py-0.5 rounded border flex-shrink-0 transition-colors"
                style={{
                  color: isWslOn ? '#63b3ed' : 'var(--color-text-muted)',
                  borderColor: isWslOn ? 'rgba(99, 179, 237, 0.3)' : 'var(--color-border)',
                  background: isWslOn ? 'rgba(99, 179, 237, 0.1)' : 'transparent',
                  opacity: status === 'running' ? 0.4 : 1,
                  cursor: status === 'running' ? 'not-allowed' : 'pointer',
                }}
                title={isWslOn ? 'Disable WSL execution' : 'Run this thread on WSL (path will be converted to /mnt/...)'}
              >
                WSL
              </button>
              {isWslOn && availableDistros.length > 0 && (
                <select
                  value={thread.wsl_distro ?? ''}
                  onChange={(e) => setWsl(threadId, true, e.target.value)}
                  disabled={status === 'running'}
                  className="text-xs flex-shrink-0 bg-transparent border rounded px-1.5 py-0.5 outline-none cursor-pointer"
                  style={{
                    color: '#63b3ed',
                    borderColor: 'rgba(99, 179, 237, 0.3)',
                    background: 'var(--color-surface)',
                    opacity: status === 'running' ? 0.4 : 1,
                  }}
                  title="Select WSL distro"
                >
                  {availableDistros.map((d) => (
                    <option key={d} value={d} style={{ background: 'var(--color-surface)', color: 'var(--color-text)' }}>
                      {d}
                    </option>
                  ))}
                </select>
              )}
            </>
          )
        })()}

        {/* Token usage + context window */}
        {usage && (() => {
          const model = thread?.model ?? 'claude-opus-4-5'
          const contextLimit = MODEL_CONTEXT_LIMITS[model] ?? DEFAULT_CONTEXT_LIMIT
          const contextPct = Math.min(usage.context_window / contextLimit, 1)
          const barColor = contextPct < 0.5 ? '#4ade80' : contextPct < 0.8 ? '#facc15' : '#f87171'
          return (
            <span
              className="flex items-center gap-2 text-xs flex-shrink-0"
              style={{ color: 'var(--color-text-muted)', fontFamily: 'monospace' }}
            >
              <span
                title={`Input: ${usage.input_tokens.toLocaleString()} tokens | Output: ${usage.output_tokens.toLocaleString()} tokens`}
              >
                ↓{formatTokenCount(usage.input_tokens)} ↑{formatTokenCount(usage.output_tokens)}
              </span>
              {usage.context_window > 0 && (
                <span
                  className="flex items-center gap-1"
                  title={`Context: ${usage.context_window.toLocaleString()} / ${contextLimit.toLocaleString()} tokens (${Math.round(contextPct * 100)}%)`}
                >
                  <span
                    style={{
                      width: 60,
                      height: 4,
                      borderRadius: 2,
                      background: 'var(--color-border)',
                      overflow: 'hidden',
                      display: 'inline-block',
                    }}
                  >
                    <span
                      style={{
                        display: 'block',
                        width: `${Math.max(contextPct * 100, 1)}%`,
                        height: '100%',
                        borderRadius: 2,
                        background: barColor,
                        transition: 'width 0.3s, background 0.3s',
                      }}
                    />
                  </span>
                  <span style={{ fontSize: '0.6rem' }}>{Math.round(contextPct * 100)}%</span>
                </span>
              )}
            </span>
          )
        })()}

        {/* Git branch + diff stats */}
        {gitStatus && (
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Branch pill */}
            <span
              className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded"
              style={{
                background: 'var(--color-surface-2)',
                color: 'var(--color-text-muted)',
                border: '1px solid var(--color-border)',
                fontFamily: 'monospace',
              }}
              title={`Branch: ${gitStatus.branch}${gitStatus.ahead > 0 ? ` ↑${gitStatus.ahead}` : ''}${gitStatus.behind > 0 ? ` ↓${gitStatus.behind}` : ''}`}
            >
              {/* Branch icon */}
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                <path d="M11.75 2.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0zm.75 2.25a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5zM4.25 13.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0zM5 15.75a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5zM4.25 2.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0zM5 4.75a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5zM5.75 8.75v-4h-1.5v4a4.25 4.25 0 0 0 3 4.04v-1.55a2.75 2.75 0 0 1-1.5-2.49zm5.5-3.54A4.25 4.25 0 0 0 8 1.16v1.55a2.75 2.75 0 0 1 1.75 2.56v2.32A2.75 2.75 0 0 1 8 10.14v1.55a4.25 4.25 0 0 0 3.25-4.14V5.21z" />
              </svg>
              <span className="max-w-[100px] truncate">{gitStatus.branch}</span>
              {gitStatus.ahead > 0 && (
                <button
                  onClick={async (e) => {
                    e.stopPropagation()
                    if (!project?.path) return
                    try {
                      await pushGit(project.path)
                      addToast({ type: 'success', message: 'Pushed successfully', duration: 3000 })
                    } catch (err) {
                      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Push failed', duration: 0 })
                    }
                  }}
                  disabled={isPushing}
                  className="hover:opacity-70 transition-opacity disabled:opacity-40"
                  style={{ color: '#4ade80', cursor: 'pointer', background: 'none', border: 'none', padding: 0, font: 'inherit', lineHeight: 1 }}
                  title={`Push (${gitStatus.ahead} ahead)`}
                >
                  {isPushing ? (
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="animate-spin" style={{ verticalAlign: 'middle' }}>
                      <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.418A6 6 0 1 1 8 2v1z"/>
                    </svg>
                  ) : (
                    <>↑{gitStatus.ahead}</>
                  )}
                </button>
              )}
              {gitStatus.behind > 0 && (
                <button
                  onClick={async (e) => {
                    e.stopPropagation()
                    if (!project?.path) return
                    try {
                      await pullGit(project.path)
                      addToast({ type: 'success', message: 'Pulled successfully', duration: 3000 })
                    } catch (err) {
                      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Pull failed', duration: 0 })
                    }
                  }}
                  disabled={isPulling}
                  className="hover:opacity-70 transition-opacity disabled:opacity-40"
                  style={{ color: '#f87171', cursor: 'pointer', background: 'none', border: 'none', padding: 0, font: 'inherit', lineHeight: 1 }}
                  title={`Pull (${gitStatus.behind} behind)`}
                >
                  {isPulling ? (
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="animate-spin" style={{ verticalAlign: 'middle' }}>
                      <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.418A6 6 0 1 1 8 2v1z"/>
                    </svg>
                  ) : (
                    <>↓{gitStatus.behind}</>
                  )}
                </button>
              )}
            </span>

            {/* Additions / deletions */}
            {(gitStatus.additions > 0 || gitStatus.deletions > 0) && (
              <span className="flex items-center gap-1 text-xs" style={{ fontFamily: 'monospace' }}>
                {gitStatus.additions > 0 && (
                  <span style={{ color: '#4ade80' }}>+{gitStatus.additions}</span>
                )}
                {gitStatus.deletions > 0 && (
                  <span style={{ color: '#f87171' }}>-{gitStatus.deletions}</span>
                )}
              </span>
            )}
          </div>
        )}
      </div>

      <button
        onClick={() => togglePanel(threadId)}
        className="flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors"
        style={{
          color: isPanelOpen ? 'var(--color-claude)' : 'var(--color-text-muted)',
          background: isPanelOpen ? 'rgba(232, 123, 95, 0.1)' : 'transparent',
          border: '1px solid',
          borderColor: isPanelOpen ? 'rgba(232, 123, 95, 0.3)' : 'var(--color-border)',
        }}
        title={isPanelOpen ? 'Hide panel' : 'Show panel'}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <line x1="2" y1="3" x2="10" y2="3" />
          <line x1="2" y1="6" x2="10" y2="6" />
          <line x1="2" y1="9" x2="10" y2="9" />
        </svg>
        <span>Panel</span>
        {todoTotal > 0 && (
          <span
            style={{
              fontSize: '0.6rem',
              fontWeight: 600,
              padding: '1px 5px',
              borderRadius: 999,
              background: hasInProgress
                ? 'rgba(232, 123, 95, 0.2)'
                : 'rgba(74, 222, 128, 0.12)',
              color: hasInProgress ? 'var(--color-claude)' : '#4ade80',
            }}
          >
            {todoCompleted}/{todoTotal}
          </span>
        )}
      </button>
    </div>
  )
}
