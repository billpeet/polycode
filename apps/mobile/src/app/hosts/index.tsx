import { useRouter } from 'expo-router'
import { useCallback, useEffect } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useState } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button, Card, EmptyState } from '@/components/ui'
import { useHostsStore, type HostMeta } from '@/stores/hosts'
import { useProjectsStore } from '@/stores/projects'
import { useThreadsStore } from '@/stores/threads'
import { useUiStore } from '@/stores/ui'
import { colors } from '@/theme/colors'

function HostCard(props: { host: HostMeta }) {
  const router = useRouter()
  const { host } = props
  const activeHostId = useHostsStore((s) => s.activeHostId)
  const health = useHostsStore((s) => s.health[host.id])
  const setActiveHost = useHostsStore((s) => s.setActiveHost)
  const isActive = activeHostId === host.id

  const healthColor = health === undefined ? colors.textMuted : health.ok ? colors.success : colors.danger

  return (
    <Pressable
      onPress={() => {
        if (activeHostId !== host.id) {
          // Switching hosts: reset everything scoped to the previous host.
          setActiveHost(host.id)
          useUiStore.getState().clearSelection()
          useProjectsStore.getState().clear()
          useThreadsStore.setState({ threadsByProject: {} })
        }
        router.push('/home')
      }}
      onLongPress={() => router.push({ pathname: '/hosts/[hostId]/edit', params: { hostId: host.id } })}
    >
      <Card style={[styles.hostCard, isActive && { borderColor: colors.claude }]}>
        <View style={{ flex: 1, gap: 3 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={[styles.healthDot, { backgroundColor: healthColor }]} />
            <Text style={styles.hostLabel} numberOfLines={1}>
              {host.label}
            </Text>
            {isActive ? <Text style={styles.activeTag}>active</Text> : null}
          </View>
          <Text style={styles.hostUrl} numberOfLines={1}>
            {host.baseUrl}
          </Text>
          {health && !health.ok ? (
            <Text style={styles.hostError} numberOfLines={1}>
              {health.error}
            </Text>
          ) : null}
        </View>
        <Text style={styles.editHint}>hold to edit</Text>
      </Card>
    </Pressable>
  )
}

export default function HostsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const hosts = useHostsStore((s) => s.hosts)
  const hydrated = useHostsStore((s) => s.hydrated)
  const checkHealth = useHostsStore((s) => s.checkHealth)
  const [refreshing, setRefreshing] = useState(false)

  const refreshHealth = useCallback(async () => {
    setRefreshing(true)
    try {
      await Promise.all(useHostsStore.getState().hosts.map((h) => checkHealth(h.id)))
    } finally {
      setRefreshing(false)
    }
  }, [checkHealth])

  useEffect(() => {
    if (hydrated) void refreshHealth()
  }, [hydrated, refreshHealth])

  return (
    <View style={styles.screen}>
      <FlatList
        data={hosts}
        keyExtractor={(h) => h.id}
        renderItem={({ item }) => <HostCard host={item} />}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshHealth} tintColor={colors.claude} />}
        ListEmptyComponent={
          <EmptyState
            title="No hosts yet"
            subtitle="Add a PolyCode desktop instance manually or scan its pairing QR code from the Remote Control panel."
          />
        }
      />
      <View style={[styles.footer, { paddingBottom: 16 + insets.bottom }]}>
        <Button title="Scan QR Code" variant="secondary" onPress={() => router.push('/hosts/scan')} style={{ flex: 1 }} />
        <Button title="Add Host" onPress={() => router.push('/hosts/new')} style={{ flex: 1 }} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  hostCard: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  healthDot: { width: 8, height: 8, borderRadius: 4 },
  hostLabel: { color: colors.text, fontSize: 16, fontWeight: '600', flexShrink: 1 },
  activeTag: { color: colors.claude, fontSize: 11, fontWeight: '600' },
  hostUrl: { color: colors.textMuted, fontSize: 13 },
  hostError: { color: colors.danger, fontSize: 12 },
  editHint: { color: colors.textMuted, fontSize: 10 },
  footer: {
    flexDirection: 'row',
    gap: 10,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
})
