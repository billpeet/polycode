/**
 * RunStore adapter over the SQLite queries. The only place a `Run` is
 * constructed from a Thread row, and the only place run-state transitions are
 * validated — illegal orderings throw instead of writing.
 */
import { Thread } from '../../../shared/types'
import {
  createThread,
  getRoutine,
  getThreadById,
  listActiveRuns,
  listAllRoutines,
  listRuns,
  markRoutineFired,
  setRoutineEnabled,
  setRunState,
  updateThreadLocationId,
} from '../../db/queries'
import { parseSchedule } from '../schedule'
import { LEGAL_RUN_TRANSITIONS, Run, RunStore, ScheduledRoutine } from '../types'

function toRun(thread: Thread): Run | null {
  if (!thread.routine_id || !thread.run_state) return null
  return {
    id: thread.id,
    routineId: thread.routine_id,
    state: thread.run_state,
    detail: thread.run_detail,
    locationId: thread.location_id,
  }
}

function getRun(threadId: string): Run | null {
  const thread = getThreadById(threadId)
  return thread ? toRun(thread) : null
}

export const sqliteRunStore: RunStore = {
  loadRoutines(): ScheduledRoutine[] {
    return listAllRoutines().map((routine) => ({ routine, schedule: parseSchedule(routine) }))
  },

  getRoutine,

  recordFired(routineId, at) {
    markRoutineFired(routineId, at.toISOString())
  },

  disableRoutine(routineId) {
    setRoutineEnabled(routineId, false)
  },

  spawnRun(routine, name) {
    const thread = createThread(routine.project_id, name, routine.location_id, routine.provider, routine.model, null, {
      routineId: routine.id,
      permissionMode: routine.permission_mode,
    })
    const run = toRun(thread)
    if (!run) throw new Error('Spawned thread is not a run.')
    return run
  },

  attachWorktree(runId, locationId) {
    updateThreadLocationId(runId, locationId)
  },

  getRun,

  listActiveRuns(): Run[] {
    return listActiveRuns()
      .map(toRun)
      .filter((run): run is Run => run !== null)
  },

  activeRun(routineId) {
    const active = listRuns(routineId).find((thread) => thread.run_state === 'active')
    return active ? toRun(active) : null
  },

  transition(runId, to, detail = null) {
    const run = getRun(runId)
    if (!run) throw new Error(`Thread ${runId} is not a run.`)
    if (!LEGAL_RUN_TRANSITIONS[run.state].includes(to)) {
      throw new Error(`Illegal run transition ${run.state} → ${to} for run ${runId}.`)
    }
    setRunState(runId, to, detail)
  },
}
