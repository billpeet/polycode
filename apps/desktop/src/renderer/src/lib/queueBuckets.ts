import { QueueThread, ThreadStatus } from '../types/ipc'

/**
 * The Queue's three display groups, in render order:
 * - `attention` — threads awaiting the user: last Turn completed, paused for
 *   input (plan/question/permission), errored, stopped, or an escalated Run.
 *   Newest completed Turn first.
 * - `running` — threads mid-Turn (running/stopping). Newest started Turn first.
 * - `fresh` — threads that have never run (no messages). They sink to the
 *   bottom; create-on-send makes them rare.
 */
export interface QueueBuckets {
  attention: QueueThread[]
  running: QueueThread[]
  fresh: QueueThread[]
}

function safeTime(iso: string | null | undefined): number {
  if (!iso) return 0
  const time = new Date(iso).getTime()
  return Number.isNaN(time) ? 0 : time
}

function byDesc(pick: (t: QueueThread) => number) {
  return (a: QueueThread, b: QueueThread) => pick(b) - pick(a)
}

/**
 * Buckets and orders Queue threads. `statusMap` supplies live push-driven
 * status which overrides the persisted snapshot from the DB query.
 */
export function bucketQueueThreads(
  threads: QueueThread[],
  statusMap: Record<string, ThreadStatus | undefined>
): QueueBuckets {
  const attention: QueueThread[] = []
  const running: QueueThread[] = []
  const fresh: QueueThread[] = []

  for (const thread of threads) {
    const status = statusMap[thread.id] ?? thread.status
    if (status === 'running' || status === 'stopping') {
      running.push(thread)
    } else if (status === 'idle' && !thread.has_messages && thread.run_state !== 'escalated') {
      fresh.push(thread)
    } else {
      attention.push(thread)
    }
  }

  attention.sort(byDesc((t) => safeTime(t.last_turn_completed_at ?? t.updated_at)))
  running.sort(byDesc((t) => safeTime(t.last_turn_started_at ?? t.updated_at)))
  fresh.sort(byDesc((t) => safeTime(t.created_at)))

  return { attention, running, fresh }
}
