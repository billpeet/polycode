import type { QueueThread } from '@polycode/shared'
import type { QueueBadgeKind } from '@/theme/colors'

/**
 * What a Queue row is waiting on, for its right-aligned badge. Escalated Runs
 * win over any pending prompt: the user must deal with the Run as a whole
 * before answering whatever it paused on.
 */
export function queueBadgeKind(thread: Pick<QueueThread, 'status' | 'run_state'>): QueueBadgeKind | null {
  if (thread.run_state === 'escalated') return 'escalated'
  if (thread.status === 'permission_pending') return 'permission'
  if (thread.status === 'question_pending') return 'question'
  if (thread.status === 'plan_pending') return 'plan'
  return null
}

export const QUEUE_BADGE_LABEL: Record<QueueBadgeKind, string> = {
  permission: 'PERMISSION',
  question: 'QUESTION',
  plan: 'PLAN',
  escalated: 'ESCALATED',
}
