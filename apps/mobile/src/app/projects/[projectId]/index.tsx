import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import type { RepoLocation, Thread } from '@polycode/shared'
import { sseManager } from '@/api/sse'
import { StatusDot } from '@/components/StatusDot'
import { Button, Card, Chip, EmptyState, Field } from '@/components/ui'
import { useProjectsStore } from '@/stores/projects'
import { useThreadsStore } from '@/stores/threads'
import { colors, statusLabel } from '@/theme/colors'

const EMPTY_THREADS: Thread[] = []

function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function ThreadRow(props: { thread: Thread; projectId: string; onRename: (thread: Thread) => void }) {
  const router = useRouter()
  const { thread, projectId, onRename } = props
  const archive = useThreadsStore((s) => s.archive)

  const showActions = () => {
    Alert.alert(thread.name, undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Rename', onPress: () => onRename(thread) },
      {
        text: 'Archive',
        style: 'destructive',
        onPress: () => void archive(projectId, thread.id),
      },
    ])
  }

  return (
    <Pressable
      onPress={() => router.push({ pathname: '/threads/[threadId]', params: { threadId: thread.id, projectId } })}
      onLongPress={showActions}
    >
      <Card style={styles.threadCard}>
        <StatusDot status={thread.status} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text
              style={[styles.threadName, thread.unread && { fontWeight: '700', color: '#ffffff' }]}
              numberOfLines={1}
            >
              {thread.name}
            </Text>
            {thread.unread ? <View style={styles.unreadDot} /> : null}
          </View>
          <Text style={styles.threadMeta} numberOfLines={1}>
            {statusLabel(thread.status)} · {thread.model || thread.provider}
            {thread.git_branch ? ` · ${thread.git_branch}` : ''}
          </Text>
        </View>
        <Text style={styles.threadTime}>{formatTimestamp(thread.updated_at)}</Text>
      </Card>
    </Pressable>
  )
}

function NewThreadModal(props: {
  projectId: string
  visible: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const { projectId, visible, onClose } = props
  const fetchLocations = useProjectsStore((s) => s.fetchLocations)
  const create = useThreadsStore((s) => s.create)
  const [name, setName] = useState('')
  const [locations, setLocations] = useState<RepoLocation[]>([])
  const [locationId, setLocationId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!visible) return
    setName('')
    void fetchLocations(projectId)
      .then((locs) => {
        setLocations(locs)
        const preferred = locs.find((l) => l.checked_out) ?? locs[0]
        setLocationId(preferred?.id ?? null)
      })
      .catch((error: unknown) => {
        Alert.alert('Could not load locations', error instanceof Error ? error.message : String(error))
      })
  }, [visible, projectId, fetchLocations])

  const submit = async () => {
    if (!locationId) return
    setCreating(true)
    try {
      const thread = await create(projectId, name.trim() || 'New thread', locationId)
      onClose()
      router.push({ pathname: '/threads/[threadId]', params: { threadId: thread.id, projectId } })
    } catch (error) {
      Alert.alert('Could not create thread', error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => undefined}>
          <Text style={styles.modalTitle}>New Thread</Text>
          <Field label="Name" placeholder="New thread" value={name} onChangeText={setName} autoFocus />
          {locations.length > 1 ? (
            <View style={{ gap: 6 }}>
              <Text style={styles.modalLabel}>Location</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {locations.map((location) => (
                  <Chip
                    key={location.id}
                    label={location.label || location.path}
                    active={locationId === location.id}
                    onPress={() => setLocationId(location.id)}
                  />
                ))}
              </View>
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button title="Cancel" variant="secondary" onPress={onClose} style={{ flex: 1 }} />
            <Button title="Create" onPress={submit} loading={creating} disabled={!locationId} style={{ flex: 1 }} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

function RenameThreadModal(props: {
  projectId: string
  thread: Thread | null
  onClose: () => void
}) {
  const { projectId, thread, onClose } = props
  const rename = useThreadsStore((s) => s.rename)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (thread) setName(thread.name)
  }, [thread])

  const submit = async () => {
    if (!thread || !name.trim()) return
    setSaving(true)
    try {
      await rename(projectId, thread.id, name.trim())
      onClose()
    } catch (error) {
      Alert.alert('Could not rename thread', error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal visible={thread !== null} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => undefined}>
          <Text style={styles.modalTitle}>Rename Thread</Text>
          <Field label="Name" value={name} onChangeText={setName} autoFocus />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button title="Cancel" variant="secondary" onPress={onClose} style={{ flex: 1 }} />
            <Button title="Rename" onPress={submit} loading={saving} disabled={!name.trim()} style={{ flex: 1 }} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

export default function ThreadsScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>()
  const threads = useThreadsStore((s) => (projectId ? (s.threadsByProject[projectId] ?? EMPTY_THREADS) : EMPTY_THREADS))
  const loading = useThreadsStore((s) => s.loading)
  const error = useThreadsStore((s) => s.error)
  const fetch = useThreadsStore((s) => s.fetch)
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId))
  const [refreshing, setRefreshing] = useState(false)
  const [showNewThread, setShowNewThread] = useState(false)
  const [renameTarget, setRenameTarget] = useState<Thread | null>(null)

  const refresh = useCallback(async () => {
    if (!projectId) return
    setRefreshing(true)
    try {
      await fetch(projectId)
    } finally {
      setRefreshing(false)
    }
  }, [projectId, fetch])

  useEffect(() => {
    if (projectId) void fetch(projectId)
  }, [projectId, fetch])

  useEffect(
    () =>
      sseManager.onConnect(() => {
        if (projectId) void fetch(projectId)
      }),
    [projectId, fetch],
  )

  if (!projectId) return <View style={styles.screen} />

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: project?.name ?? 'Threads' }} />
      <FlatList
        data={threads}
        keyExtractor={(t) => t.id}
        renderItem={({ item }) => <ThreadRow thread={item} projectId={projectId} onRename={setRenameTarget} />}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.claude} />}
        ListEmptyComponent={
          loading ? null : (
            <EmptyState
              title="No threads"
              subtitle={error ?? 'Start a new thread to begin working with an agent on this host.'}
            />
          )
        }
      />
      <View style={styles.footer}>
        <Button title="New Thread" onPress={() => setShowNewThread(true)} />
      </View>
      <NewThreadModal projectId={projectId} visible={showNewThread} onClose={() => setShowNewThread(false)} />
      <RenameThreadModal projectId={projectId} thread={renameTarget} onClose={() => setRenameTarget(null)} />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  threadCard: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  threadName: { color: colors.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  unreadDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.claude },
  threadMeta: { color: colors.textMuted, fontSize: 12 },
  threadTime: { color: colors.textMuted, fontSize: 11 },
  footer: {
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 18,
    gap: 14,
  },
  modalTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  modalLabel: { color: colors.textMuted, fontSize: 13, fontWeight: '500' },
})
