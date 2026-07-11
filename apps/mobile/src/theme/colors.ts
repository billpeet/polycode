import type { ThreadStatus } from '@polycode/shared'

/** Dark palette lifted from the desktop renderer (index.css :root). */
export const colors = {
  claude: '#e87b5f',
  bg: '#0f0f0f',
  surface: '#1a1a1a',
  surface2: '#222222',
  border: '#2a2a2a',
  text: '#e8e8e8',
  textMuted: '#888888',
  codeBg: '#0d1117',
  danger: '#f87171',
  success: '#4ade80',
  warning: '#fbbf24',
  info: '#60a5fa',
  toolCallTint: 'rgba(232, 123, 95, 0.06)',
  toolCallAccent: 'rgba(232, 123, 95, 0.5)',
  toolResultTint: 'rgba(74, 222, 128, 0.05)',
  toolResultAccent: 'rgba(74, 222, 128, 0.45)',
} as const

/** Status dot colors matching desktop semantics. */
export function statusColor(status: ThreadStatus): string {
  switch (status) {
    case 'running':
      return colors.claude
    case 'stopping':
      return colors.warning
    case 'error':
      return colors.danger
    case 'stopped':
      return colors.textMuted
    case 'plan_pending':
    case 'question_pending':
    case 'permission_pending':
      return colors.info
    case 'idle':
    default:
      return colors.success
  }
}

export function statusLabel(status: ThreadStatus): string {
  switch (status) {
    case 'running':
      return 'Running'
    case 'stopping':
      return 'Stopping…'
    case 'error':
      return 'Error'
    case 'stopped':
      return 'Stopped'
    case 'plan_pending':
      return 'Plan ready'
    case 'question_pending':
      return 'Question'
    case 'permission_pending':
      return 'Permission'
    case 'idle':
    default:
      return 'Idle'
  }
}
