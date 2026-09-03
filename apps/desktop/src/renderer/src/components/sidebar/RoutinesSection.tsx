import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Pencil, Play, Plus, X } from 'lucide-react'
import { Routine, Thread } from '../../types/ipc'
import RoutineEditModal from '../RoutineEditModal'
import { formatDateTime } from '../../lib/locale'

const RUNS_SHOWN = 10

interface RoutinesSectionProps {
  projectId: string
  onSelectThread: (threadId: string) => void
}

function runStateIcon(run: Thread) {
  if (run.run_state === 'active') return <div className="status-spinner h-2.5 w-2.5 flex-shrink-0" />
  if (run.run_state === 'escalated') return <AlertTriangle size={10} className="flex-shrink-0" style={{ color: 'var(--color-warning, #d97706)' }} />
  if (run.run_state === 'success') return <Check size={10} className="flex-shrink-0 opacity-60" />
  return <X size={10} className="flex-shrink-0 opacity-40" />
}

/**
 * Sidebar section listing a project's Routines with their recent Runs —
 * sibling to the Archived section. Self-contained: fetches over IPC and
 * refreshes on `routines:changed` app events.
 */
export default function RoutinesSection({ projectId, onSelectThread }: RoutinesSectionProps) {
  const [expanded, setExpanded] = useState(false)
  const [routines, setRoutines] = useState<Routine[]>([])
  const [runsByRoutine, setRunsByRoutine] = useState<Record<string, Thread[]>>({})
  const [expandedRoutineIds, setExpandedRoutineIds] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<Routine | null>(null)
  const [creating, setCreating] = useState(false)

  const refresh = useCallback(async () => {
    const list = await window.api.invoke('routines:list', projectId)
    setRoutines(list)
    const runs: Record<string, Thread[]> = {}
    await Promise.all(list.map(async (routine) => {
      runs[routine.id] = await window.api.invoke('routines:listRuns', routine.id, RUNS_SHOWN)
    }))
    setRunsByRoutine(runs)
  }, [projectId])

  useEffect(() => {
    let cancelled = false
    void window.api.invoke('routines:list', projectId).then(async (list) => {
      const runs: Record<string, Thread[]> = {}
      await Promise.all(list.map(async (routine) => {
        runs[routine.id] = await window.api.invoke('routines:listRuns', routine.id, RUNS_SHOWN)
      }))
      if (cancelled) return
      setRoutines(list)
      setRunsByRoutine(runs)
    })
    const unsubscribe = window.api.on('routines:changed', () => void refresh())
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [projectId, refresh])

  const toggleRoutine = (id: string) => {
    setExpandedRoutineIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const runNow = async (routine: Routine) => {
    const threadId = await window.api.invoke('routines:runNow', routine.id)
    await refresh()
    if (threadId) onSelectThread(threadId)
  }

  const dismissRun = async (run: Thread) => {
    const unshipped = await window.api.invoke('routines:runHasUnshippedWork', run.id)
    if (unshipped && !window.confirm('This run’s worktree has unshipped changes. Delete it anyway?')) return
    await window.api.invoke('routines:dismissRun', run.id)
    await refresh()
  }

  const deleteRoutine = async (routine: Routine) => {
    if (!window.confirm(`Delete routine "${routine.name}"? Its past runs will move to Archived.`)) return
    try {
      await window.api.invoke('routines:delete', routine.id)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    }
    await refresh()
  }

  if (routines.length === 0 && !expanded) {
    return (
      <>
        <button
          onClick={() => { setExpanded(true); setCreating(true) }}
          className="flex w-full items-center pl-6 pr-4 py-1 text-left text-[10px] opacity-40 transition-opacity hover:opacity-70"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <Plus size={9} className="mr-1" /> Add routine
        </button>
        {creating && (
          <RoutineEditModal projectId={projectId} routine={null} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); void refresh() }} />
        )}
      </>
    )
  }

  return (
    <>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center pl-6 pr-4 py-1 text-left text-[10px] opacity-40 transition-opacity hover:opacity-70"
        style={{ color: 'var(--color-text-muted)' }}
      >
        {expanded
          ? <><ChevronDown size={9} className="mr-1" /> Hide routines</>
          : <><ChevronRight size={9} className="mr-1" /> Routines ({routines.length})</>}
      </button>

      {expanded && (
        <>
          {routines.map((routine) => {
            const runs = runsByRoutine[routine.id] ?? []
            const hasActive = runs.some((run) => run.run_state === 'active')
            const isOpen = expandedRoutineIds.has(routine.id)
            return (
              <div key={routine.id}>
                <div className="group flex w-full items-center gap-1 pl-8 pr-2 py-1 text-xs" style={{ color: 'var(--color-text)' }}>
                  <button onClick={() => toggleRoutine(routine.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                    {isOpen ? <ChevronDown size={9} className="flex-shrink-0" /> : <ChevronRight size={9} className="flex-shrink-0" />}
                    {hasActive && <div className="status-spinner h-2.5 w-2.5 flex-shrink-0" />}
                    <span className={`truncate ${routine.enabled ? '' : 'opacity-40 line-through'}`}>{routine.name}</span>
                  </button>
                  <button
                    title="Run now"
                    onClick={() => void runNow(routine)}
                    className="hidden flex-shrink-0 opacity-50 hover:opacity-100 group-hover:block"
                  >
                    <Play size={11} />
                  </button>
                  <button
                    title="Edit routine"
                    onClick={() => setEditing(routine)}
                    className="hidden flex-shrink-0 opacity-50 hover:opacity-100 group-hover:block"
                  >
                    <Pencil size={11} />
                  </button>
                  <button
                    title="Delete routine"
                    onClick={() => void deleteRoutine(routine)}
                    className="hidden flex-shrink-0 opacity-50 hover:opacity-100 group-hover:block"
                  >
                    <X size={11} />
                  </button>
                </div>

                {isOpen && runs.length === 0 && (
                  <div className="pl-12 pr-4 py-0.5 text-[10px] opacity-40" style={{ color: 'var(--color-text-muted)' }}>
                    No runs yet
                  </div>
                )}
                {isOpen && runs.map((run) => (
                  <div key={run.id} className="group flex w-full items-center gap-1.5 pl-12 pr-2 py-0.5 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                    <button
                      onClick={() => onSelectThread(run.id)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left transition-opacity hover:opacity-80"
                      title={run.run_detail ?? undefined}
                    >
                      {runStateIcon(run)}
                      <span className="truncate">{formatDateTime(run.created_at)}</span>
                    </button>
                    {run.run_state === 'escalated' && (
                      <button
                        title="Dismiss run"
                        onClick={() => void dismissRun(run)}
                        className="hidden flex-shrink-0 opacity-50 hover:opacity-100 group-hover:block"
                      >
                        <X size={10} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )
          })}

          <button
            onClick={() => setCreating(true)}
            className="flex w-full items-center pl-8 pr-4 py-1 text-left text-[10px] opacity-40 transition-opacity hover:opacity-70"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Plus size={9} className="mr-1" /> Add routine
          </button>
        </>
      )}

      {(creating || editing) && (
        <RoutineEditModal
          projectId={projectId}
          routine={editing}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={() => { setCreating(false); setEditing(null); void refresh() }}
        />
      )}
    </>
  )
}
