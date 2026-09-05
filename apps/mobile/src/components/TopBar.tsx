import { useRouter } from 'expo-router'
import { useEffect, useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { sseManager, type ConnectionState } from '@/api/sse'
import { useHostsStore } from '@/stores/hosts'
import { colors } from '@/theme/colors'

/** Live SSE state as a dot: green connected, amber connecting, red down. */
export function ConnectionBadge() {
  const [state, setState] = useState<ConnectionState>(sseManager.state)
  useEffect(() => sseManager.onStateChange(setState), [])
  const color = state === 'connected' ? colors.success : state === 'connecting' ? colors.warning : colors.danger
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
}

/** The tab screens' header: `● {host}` on the left, `Hosts` on the right, plus an optional slot. */
export function TopBar(props: { right?: ReactNode }) {
  const router = useRouter()
  const activeHost = useHostsStore((s) => s.hosts.find((h) => h.id === s.activeHostId))
  return (
    <View style={styles.bar}>
      <ConnectionBadge />
      <Text style={styles.host} numberOfLines={1}>
        {activeHost?.label ?? 'PolyCode'}
      </Text>
      {props.right}
      <Pressable onPress={() => router.push('/hosts')} hitSlop={8}>
        <Text style={styles.link}>Hosts</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  host: { color: colors.text, fontSize: 15, fontWeight: '700', flex: 1 },
  link: { color: colors.accent, fontSize: 13, fontWeight: '500' },
})
