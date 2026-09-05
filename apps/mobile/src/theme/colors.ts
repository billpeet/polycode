import type { PermissionMode, ThreadStatus } from '@polycode/shared'
import type { TextStyle } from 'react-native'

/** Dark palette lifted from the desktop renderer (index.css :root). */
export const colors = {
  claude: '#e87b5f',
  /** The one accent colour: primary actions, active chips, the woken rail. Alias of `claude`. */
  accent: '#e87b5f',
  accentTint: 'rgba(232, 123, 95, 0.12)',
  /** Text on an accent-filled surface. */
  onAccent: '#1a1a1a',
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

/** Corner radii, so cards/sheets/inputs agree with each other across screens. */
export const radii = { card: 12, sheet: 18, pill: 999, input: 12 } as const

/** Small uppercase label above a section (Queue sections, sheet sections). */
export const sectionLabel: TextStyle = {
  color: colors.textMuted,
  fontSize: 10,
  fontWeight: '700',
  textTransform: 'uppercase',
  letterSpacing: 0.8,
}

/** Queue row badges: what the thread is waiting on. */
export type QueueBadgeKind = 'permission' | 'question' | 'plan' | 'escalated'

export const badge: Record<QueueBadgeKind, { bg: string; fg: string }> = {
  permission: { bg: 'rgba(251, 191, 36, 0.15)', fg: colors.warning },
  question: { bg: 'rgba(96, 165, 250, 0.15)', fg: colors.info },
  plan: { bg: 'rgba(232, 123, 95, 0.15)', fg: colors.claude },
  escalated: { bg: 'rgba(248, 113, 113, 0.15)', fg: colors.danger },
}

/** Copy of the desktop composer's `PERMISSION_MODE_ACCENTS`. */
export const permissionAccent: Record<PermissionMode, { background: string; color: string }> = {
  ask: { background: 'rgba(34, 197, 94, 0.12)', color: '#22c55e' },
  auto: { background: 'rgba(167, 139, 250, 0.15)', color: '#a78bfa' },
  workspace: { background: 'rgba(59, 130, 246, 0.14)', color: '#60a5fa' },
  yolo: { background: 'rgba(249, 115, 22, 0.15)', color: '#f97316' },
}

/** Status dot colors matching desktop semantics: green = running, grey = idle. */
export function statusColor(status: ThreadStatus): string {
  switch (status) {
    case 'running':
      return '#4ade80'
    case 'stopping':
      return '#fb923c'
    case 'error':
      return colors.danger
    case 'stopped':
      return '#facc15'
    case 'plan_pending':
    case 'question_pending':
    case 'permission_pending':
      return colors.info
    case 'idle':
    default:
      return colors.textMuted
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
