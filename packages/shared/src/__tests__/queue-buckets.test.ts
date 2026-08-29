import { describe, expect, it } from 'vitest'
import { bucketQueueThreads } from '../queue-buckets'
import type { QueueThread } from '../types'

let counter = 0
function makeThread(overrides: Partial<QueueThread>): QueueThread {
  counter += 1
  return {
    id: `thread-${counter}`,
    project_id: 'p1',
    location_id: 'loc-1',
    name: `Thread ${counter}`,
    provider: 'claude-code',
    model: 'claude-opus-4-8',
    reasoning_level: 'off',
    codex_personality: 'none',
    codex_reasoning_summary: 'auto',
    cursor_thinking: null,
    cursor_context: null,
    status: 'idle',
    archived: false,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    total_cost_usd: null,
    context_window: 0,
    unread: false,
    has_messages: true,
    permission_mode: 'ask',
    yolo_mode: false,
    use_wsl: false,
    wsl_distro: null,
    git_branch: null,
    routine_id: null,
    run_state: null,
    run_detail: null,
    last_turn_started_at: null,
    last_turn_completed_at: null,
    snoozed_until: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    project_name: 'Project',
    location_label: 'Local',
    location_is_worktree: false,
    ...overrides,
  }
}

describe('bucketQueueThreads', () => {
  it('splits attention, running, and fresh threads', () => {
    const completed = makeThread({ status: 'idle', last_turn_completed_at: '2026-08-10T10:00:00Z' })
    const runningThread = makeThread({ status: 'running', last_turn_started_at: '2026-08-10T11:00:00Z' })
    const neverRun = makeThread({ status: 'idle', has_messages: false })

    const buckets = bucketQueueThreads([completed, runningThread, neverRun], {})

    expect(buckets.attention.map((t) => t.id)).toEqual([completed.id])
    expect(buckets.running.map((t) => t.id)).toEqual([runningThread.id])
    expect(buckets.fresh.map((t) => t.id)).toEqual([neverRun.id])
  })

  describe('woken threads', () => {
    const NOW = new Date('2026-08-10T12:00:00Z')

    it('lifts woken threads out of every status bucket', () => {
      // A woken thread with no messages would otherwise land in `fresh` and be
      // rendered below two whole section headers — the case that makes
      // sorting-within-a-bucket the wrong design.
      const wokenFresh = makeThread({
        status: 'idle',
        has_messages: false,
        snoozed_until: '2026-08-10T09:00:00Z',
      })
      const wokenRunning = makeThread({ status: 'running', snoozed_until: '2026-08-10T10:00:00Z' })
      const ordinary = makeThread({ status: 'idle', last_turn_completed_at: '2026-08-10T11:00:00Z' })

      const buckets = bucketQueueThreads([wokenFresh, wokenRunning, ordinary], {}, NOW)

      expect(buckets.woken.map((t) => t.id)).toEqual([wokenFresh.id, wokenRunning.id])
      expect(buckets.attention.map((t) => t.id)).toEqual([ordinary.id])
      expect(buckets.running).toHaveLength(0)
      expect(buckets.fresh).toHaveLength(0)
    })

    it('orders woken by wake time ascending, longest-awake first', () => {
      const justWoke = makeThread({ snoozed_until: '2026-08-10T11:59:00Z' })
      const wokeEarlier = makeThread({ snoozed_until: '2026-08-10T08:00:00Z' })

      const buckets = bucketQueueThreads([justWoke, wokeEarlier], {}, NOW)

      expect(buckets.woken.map((t) => t.id)).toEqual([wokeEarlier.id, justWoke.id])
    })

    it('does not treat a future wake time as woken', () => {
      // The Queue query already excludes actively-snoozed threads, but the
      // boundary must hold here too rather than relying on that alone.
      const stillSnoozed = makeThread({ snoozed_until: '2026-08-10T18:00:00Z' })

      const buckets = bucketQueueThreads([stillSnoozed], {}, NOW)

      expect(buckets.woken).toHaveLength(0)
      expect(buckets.attention.map((t) => t.id)).toEqual([stillSnoozed.id])
    })

    it('leaves never-snoozed threads alone', () => {
      const plain = makeThread({ snoozed_until: null })

      const buckets = bucketQueueThreads([plain], {}, NOW)

      expect(buckets.woken).toHaveLength(0)
    })
  })

  it('orders attention by last turn completed, newest first', () => {
    const older = makeThread({ last_turn_completed_at: '2026-08-10T09:00:00Z' })
    const newer = makeThread({ last_turn_completed_at: '2026-08-10T10:00:00Z' })

    const buckets = bucketQueueThreads([older, newer], {})

    expect(buckets.attention.map((t) => t.id)).toEqual([newer.id, older.id])
  })

  it('orders running by last turn started, newest first', () => {
    const older = makeThread({ status: 'running', last_turn_started_at: '2026-08-10T09:00:00Z' })
    const newer = makeThread({ status: 'running', last_turn_started_at: '2026-08-10T10:00:00Z' })

    const buckets = bucketQueueThreads([older, newer], {})

    expect(buckets.running.map((t) => t.id)).toEqual([newer.id, older.id])
  })

  it('treats paused, errored, and stopped threads as needing attention', () => {
    const statuses = ['plan_pending', 'question_pending', 'permission_pending', 'error', 'stopped'] as const
    const threads = statuses.map((status) => makeThread({ status }))

    const buckets = bucketQueueThreads(threads, {})

    expect(buckets.attention).toHaveLength(statuses.length)
    expect(buckets.running).toHaveLength(0)
    expect(buckets.fresh).toHaveLength(0)
  })

  it('keeps escalated runs in attention even without messages', () => {
    const escalated = makeThread({ has_messages: false, routine_id: 'r1', run_state: 'escalated' })

    const buckets = bucketQueueThreads([escalated], {})

    expect(buckets.attention.map((t) => t.id)).toEqual([escalated.id])
  })

  it('lets live statusMap override the persisted status', () => {
    const thread = makeThread({ status: 'idle', last_turn_completed_at: '2026-08-10T10:00:00Z' })

    const buckets = bucketQueueThreads([thread], { [thread.id]: 'running' })

    expect(buckets.running.map((t) => t.id)).toEqual([thread.id])
    expect(buckets.attention).toHaveLength(0)
  })

  it('falls back to updated_at when turn timestamps are missing', () => {
    const legacyNewer = makeThread({ updated_at: '2026-08-12T00:00:00Z' })
    const stamped = makeThread({ last_turn_completed_at: '2026-08-11T00:00:00Z' })

    const buckets = bucketQueueThreads([legacyNewer, stamped], {})

    expect(buckets.attention.map((t) => t.id)).toEqual([legacyNewer.id, stamped.id])
  })
})
