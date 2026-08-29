import { isWoken } from './snooze'
import type { QueueThread, ThreadStatus } from './types'

/**
 * The Queue's display groups, in render order:
 * - `woken` — threads whose snooze has elapsed and which the user has not
 *   engaged since. They lead the Queue *above every section header*, because
 *   the user asked to be shown them at this moment — a stronger claim than any
 *   bucket membership. Soonest-woken first, so the longest-waiting is on top.
 * - `attention` — threads awaiting the user: last Turn completed, paused for
 *   input (plan/question/permission), errored, stopped, or an escalated Run.
 *   Newest completed Turn first.
 * - `running` — threads mid-Turn (running/stopping). Newest started Turn first.
 * - `fresh` — threads that have never run (no messages). They sink to the
 *   bottom; create-on-send makes them rare.
 *
 * Woken threads are lifted out *before* status bucketing rather than sorted to
 * the front of whichever bucket they land in. Sorting inside a bucket would bury
 * a woken thread with no messages below two whole sections, and forcing it into
 * `attention` would make that header lie about the thread's status.
 */
export interface QueueBuckets {
  woken: QueueThread[]
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
 *
 * `now` is injectable so tests can pin the woken/snoozed boundary. Actively
 * snoozed threads never reach here — the Queue query already excludes them —
 * so anything with a `snoozed_until` in this list is woken by definition.
 */
export function bucketQueueThreads(
  threads: QueueThread[],
  statusMap: Record<string, ThreadStatus | undefined>,
  now: Date = new Date()
): QueueBuckets {
  const woken: QueueThread[] = []
  const attention: QueueThread[] = []
  const running: QueueThread[] = []
  const fresh: QueueThread[] = []

  for (const thread of threads) {
    if (isWoken(thread, now)) {
      woken.push(thread)
      continue
    }
    const status = statusMap[thread.id] ?? thread.status
    if (status === 'running' || status === 'stopping') {
      running.push(thread)
    } else if (status === 'idle' && !thread.has_messages && thread.run_state !== 'escalated') {
      fresh.push(thread)
    } else {
      attention.push(thread)
    }
  }

  // Ascending: the thread that woke longest ago has waited on the user most.
  woken.sort((a, b) => safeTime(a.snoozed_until) - safeTime(b.snoozed_until))
  attention.sort(byDesc((t) => safeTime(t.last_turn_completed_at ?? t.updated_at)))
  running.sort(byDesc((t) => safeTime(t.last_turn_started_at ?? t.updated_at)))
  fresh.sort(byDesc((t) => safeTime(t.created_at)))

  return { woken, attention, running, fresh }
}
