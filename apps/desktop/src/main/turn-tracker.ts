/**
 * How many Turns are running at once, and when each starts and ends.
 *
 * The October freeze audit found main-thread stalls rising sharply with the number of
 * Threads working at the same time, but PolyCode recorded no Turn boundaries, so
 * concurrency had to be inferred from git refresh traffic. Each start and end now logs a
 * `[turn]` line carrying the running count, and `polycode.turns.running` is a gauge.
 */
import { recordGauge } from './observability'
import type { ThreadStatus } from '../shared/types'

const startedAt = new Map<string, number>()
const ENDING: ReadonlySet<string> = new Set(['idle', 'error', 'stopped'])

function shortId(threadId: string): string {
  return threadId.slice(0, 8)
}

function publish(): void {
  recordGauge('polycode.turns.running', startedAt.size, '{turn}')
}

/** Feed every status a Session sets; repeated statuses are no-ops. */
export function noteThreadStatus(threadId: string, status: ThreadStatus): void {
  if (status === 'running' && !startedAt.has(threadId)) {
    startedAt.set(threadId, performance.now())
    console.info(`[turn] start thread=${shortId(threadId)} running=${startedAt.size}`)
    publish()
  } else if (ENDING.has(status)) {
    endTurn(threadId, status)
  }
}

/** End a Turn that will not reach a terminal status (its Session was torn down). */
export function endTurn(threadId: string, reason: string): void {
  const started = startedAt.get(threadId)
  if (started === undefined) return
  startedAt.delete(threadId)
  console.info(`[turn] end thread=${shortId(threadId)} ms=${Math.round(performance.now() - started)} status=${reason} running=${startedAt.size}`)
  publish()
}

export function runningTurnCount(): number {
  return startedAt.size
}

/** Test seam. */
export function resetTurnTrackerForTest(): void {
  startedAt.clear()
}
