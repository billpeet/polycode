import { ActivityIndicator, View } from 'react-native'
import type { ThreadStatus } from '@polycode/shared'
import { colors, statusColor } from '@/theme/colors'

export function StatusDot(props: { status: ThreadStatus; size?: number }) {
  const size = props.size ?? 8
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: statusColor(props.status),
      }}
    />
  )
}

/**
 * Sidebar thread indicator with desktop semantics (sidebar/shared.tsx):
 * spinner while running/stopping (dimmed when stopping), then dot colored
 * unread-green → error-red → stopped-yellow → muted grey for idle/read.
 */
export function ThreadStatusIndicator(props: { status: ThreadStatus; unread: boolean; size?: number }) {
  const size = props.size ?? 7
  const { status, unread } = props

  if (status === 'running' || status === 'stopping') {
    return (
      <View style={{ width: size + 4, height: size + 4, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator
          size="small"
          color={colors.claude}
          style={{ transform: [{ scale: 0.55 }], opacity: status === 'stopping' ? 0.5 : 1 }}
        />
      </View>
    )
  }

  const color = unread
    ? '#22c55e'
    : status === 'error'
      ? '#f87171'
      : status === 'stopped'
        ? '#facc15'
        : colors.textMuted

  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
}
