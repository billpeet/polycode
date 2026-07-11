import { Stack, useRouter } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import type { Project } from '@polycode/shared'
import { sseManager, type ConnectionState } from '@/api/sse'
import { Card, EmptyState } from '@/components/ui'
import { useHostsStore } from '@/stores/hosts'
import { useProjectsStore } from '@/stores/projects'
import { colors } from '@/theme/colors'

function ConnectionBadge() {
  const [state, setState] = useState<ConnectionState>(sseManager.state)
  useEffect(() => sseManager.onStateChange(setState), [])
  const color = state === 'connected' ? colors.success : state === 'connecting' ? colors.warning : colors.danger
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <Text style={{ color: colors.textMuted, fontSize: 12 }}>{state}</Text>
    </View>
  )
}

export default function ProjectsScreen() {
  const router = useRouter()
  const projects = useProjectsStore((s) => s.projects)
  const loading = useProjectsStore((s) => s.loading)
  const error = useProjectsStore((s) => s.error)
  const fetch = useProjectsStore((s) => s.fetch)
  const activeHostId = useHostsStore((s) => s.activeHostId)
  const activeHost = useHostsStore((s) => s.hosts.find((h) => h.id === s.activeHostId))
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await fetch()
    } finally {
      setRefreshing(false)
    }
  }, [fetch])

  useEffect(() => {
    if (activeHostId) void fetch()
  }, [activeHostId, fetch])

  // Refetch whenever the SSE stream (re)connects — missed events are not replayed.
  useEffect(
    () =>
      sseManager.onConnect(() => {
        void fetch()
      }),
    [fetch],
  )

  const renderProject = ({ item }: { item: Project }) => (
    <Pressable onPress={() => router.push({ pathname: '/projects/[projectId]', params: { projectId: item.id } })}>
      <Card style={styles.projectCard}>
        <Text style={styles.projectName} numberOfLines={1}>
          {item.name}
        </Text>
        {item.git_url ? (
          <Text style={styles.projectUrl} numberOfLines={1}>
            {item.git_url}
          </Text>
        ) : null}
      </Card>
    </Pressable>
  )

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          title: activeHost?.label ?? 'Projects',
          headerRight: () => (
            <Pressable onPress={() => router.push('/hosts')} hitSlop={8}>
              <Text style={{ color: colors.claude, fontSize: 14, fontWeight: '500' }}>Hosts</Text>
            </Pressable>
          ),
        }}
      />
      <View style={styles.statusRow}>
        <ConnectionBadge />
        {error ? (
          <Text style={{ color: colors.danger, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>
            {error}
          </Text>
        ) : null}
      </View>
      <FlatList
        data={projects}
        keyExtractor={(p) => p.id}
        renderItem={renderProject}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.claude} />}
        ListEmptyComponent={
          loading ? null : (
            <EmptyState
              title="No projects"
              subtitle={error ? 'Could not reach the host. Pull to retry.' : 'Create a project in the desktop app first.'}
            />
          )
        }
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  projectCard: { gap: 4 },
  projectName: { color: colors.text, fontSize: 16, fontWeight: '600' },
  projectUrl: { color: colors.textMuted, fontSize: 12 },
})
