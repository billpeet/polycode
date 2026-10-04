import { useRouter } from 'expo-router'
import { useEffect, useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { sseManager, type ConnectionState } from '@/api/sse'
import { selectSource } from '@/lib/sources'
import { useHostsStore } from '@/stores/hosts'
import { unifiedConnectionState, useUnifiedStore } from '@/stores/unified'
import { colors } from '@/theme/colors'
import { ActionSheet } from './ActionSheet'

function connectionColor(state: ConnectionState): string {
  return state === 'connected' ? colors.success : state === 'connecting' ? colors.warning : colors.danger
}

/**
 * Live connection state as a dot: green connected, amber connecting, red down. For one
 * host that is its SSE stream; in the unified view it summarises every host, amber
 * meaning some but not all of them are reachable.
 */
export function ConnectionBadge() {
  const [activeState, setActiveState] = useState<ConnectionState>(sseManager.state)
  useEffect(() => sseManager.onStateChange(setActiveState), [])
  const unified = useUnifiedStore((s) => s.enabled)
  const unifiedState = useUnifiedStore(unifiedConnectionState)
  const color = connectionColor(unified ? unifiedState : activeState)
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
}

/**
 * The tab screens' header: `● {source}` on the left, `Hosts` on the right, plus an
 * optional slot. With more than one saved host the source is a switcher between each
 * host and "All hosts" — the mobile counterpart of the desktop title bar's.
 */
export function TopBar(props: { right?: ReactNode }) {
  const router = useRouter()
  const hosts = useHostsStore((s) => s.hosts)
  const activeHostId = useHostsStore((s) => s.activeHostId)
  const unified = useUnifiedStore((s) => s.enabled)
  const [switching, setSwitching] = useState(false)

  const activeHost = hosts.find((h) => h.id === activeHostId)
  // Also offered with a single host left while "All" is on, so it can be switched off.
  const canSwitch = hosts.length > 1 || unified
  const label = unified ? 'All hosts' : (activeHost?.label ?? 'PolyCode')
  const mark = (selected: boolean, text: string): string => (selected ? `✓ ${text}` : text)

  return (
    <View style={styles.bar}>
      <Pressable
        style={({ pressed }) => [styles.source, pressed && canSwitch && { opacity: 0.7 }]}
        onPress={() => setSwitching(true)}
        disabled={!canSwitch}
        hitSlop={8}
        accessibilityRole={canSwitch ? 'button' : undefined}
        accessibilityLabel={canSwitch ? `Source: ${label}. Switch source` : undefined}
      >
        <ConnectionBadge />
        <Text style={styles.host} numberOfLines={1}>
          {label}
        </Text>
        {canSwitch ? <Text style={styles.caret}>▾</Text> : null}
      </Pressable>
      {props.right}
      <Pressable onPress={() => router.push('/hosts')} hitSlop={8}>
        <Text style={styles.link}>Hosts</Text>
      </Pressable>
      <ActionSheet
        visible={switching}
        title="Show threads from"
        onClose={() => setSwitching(false)}
        options={[
          { label: mark(unified, 'All hosts'), onPress: () => selectSource('all') },
          ...hosts.map((host) => ({
            label: mark(!unified && host.id === activeHostId, host.label),
            onPress: () => selectSource({ hostId: host.id }),
          })),
        ]}
      />
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
  source: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  host: { color: colors.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  caret: { color: colors.textMuted, fontSize: 12 },
  link: { color: colors.accent, fontSize: 13, fontWeight: '500' },
})
