import { View } from 'react-native'
import type { ThreadStatus } from '@polycode/shared'
import { statusColor } from '@/theme/colors'

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
