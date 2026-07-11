import { useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  Animated,
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { Project, Thread } from '@polycode/shared'
import { sseManager, type ConnectionState } from '@/api/sse'
import { useHostsStore } from '@/stores/hosts'
import { useProjectsStore } from '@/stores/projects'
import { useThreadsStore } from '@/stores/threads'
import { useUiStore } from '@/stores/ui'
import { colors } from '@/theme/colors'
import { ThreadStatusIndicator } from './StatusDot'
import { NewThreadModal, RenameThreadModal } from './ThreadModals'

const SIDEBAR_WIDTH = Math.min(320, Dimensions.get('window').width * 0.85)
const EMPTY_THREADS: Thread[] = []

function ConnectionBadge() {
  const [state, setState] = useState<ConnectionState>(sseManager.state)
  useEffect(() => sseManager.onStateChange(setState), [])
  const color = state === 'connected' ? colors.success : state === 'connecting' ? colors.warning : colors.danger
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
}

function ThreadRow(props: {
  projectId: string
  thread: Thread
  onLongPress: (projectId: string, thread: Thread) => void
}) {
  const { projectId, thread } = props
  const selectedThreadId = useUiStore((s) => s.selectedThreadId)
  const selectThread = useUiStore((s) => s.selectThread)
  const selected = selectedThreadId === thread.id

  return (
    <Pressable
      onPress={() => selectThread(projectId, thread.id)}
      onLongPress={() => props.onLongPress(projectId, thread)}
      style={({ pressed }) => [
        styles.threadRow,
        selected && styles.threadRowSelected,
        pressed && { opacity: 0.7 },
      ]}
    >
      <ThreadStatusIndicator status={thread.status} unread={thread.unread} size={7} />
      <Text
        style={[
          styles.threadName,
          selected && { color: colors.text },
          thread.unread && { fontWeight: '700', color: '#ffffff' },
        ]}
        numberOfLines={1}
      >
        {thread.name}
      </Text>
      {thread.unread ? <View style={styles.unreadDot} /> : null}
    </Pressable>
  )
}

function ProjectSection(props: {
  project: Project
  onNewThread: (projectId: string) => void
  onThreadLongPress: (projectId: string, thread: Thread) => void
}) {
  const { project } = props
  const expanded = useUiStore((s) => s.expandedProjectIds.includes(project.id))
  const toggleProject = useUiStore((s) => s.toggleProject)
  const threads = useThreadsStore((s) => s.threadsByProject[project.id] ?? EMPTY_THREADS)
  const fetchThreads = useThreadsStore((s) => s.fetch)

  useEffect(() => {
    if (expanded) void fetchThreads(project.id)
  }, [expanded, project.id, fetchThreads])

  return (
    <View>
      <Pressable
        onPress={() => toggleProject(project.id)}
        style={({ pressed }) => [styles.projectRow, pressed && { opacity: 0.7 }]}
      >
        <Text style={[styles.projectChevron, expanded && { transform: [{ rotate: '90deg' }] }]}>▸</Text>
        <Text style={styles.projectName} numberOfLines={1}>
          {project.name}
        </Text>
        {threads.some((t) => t.status === 'running') ? (
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.claude }} />
        ) : null}
      </Pressable>
      {expanded ? (
        <View style={styles.threadList}>
          {threads.map((thread) => (
            <ThreadRow
              key={thread.id}
              projectId={project.id}
              thread={thread}
              onLongPress={props.onThreadLongPress}
            />
          ))}
          <Pressable
            onPress={() => props.onNewThread(project.id)}
            style={({ pressed }) => [styles.newThreadRow, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.newThreadText}>＋ New thread</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  )
}

export function Sidebar() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const open = useUiStore((s) => s.sidebarOpen)
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen)
  const projects = useProjectsStore((s) => s.projects)
  const fetchProjects = useProjectsStore((s) => s.fetch)
  const activeHost = useHostsStore((s) => s.hosts.find((h) => h.id === s.activeHostId))
  const archive = useThreadsStore((s) => s.archive)

  const [newThreadProjectId, setNewThreadProjectId] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ projectId: string; thread: Thread } | null>(null)

  const translateX = useRef(new Animated.Value(-SIDEBAR_WIDTH)).current
  const [rendered, setRendered] = useState(open)

  useEffect(() => {
    if (open) {
      setRendered(true)
      void fetchProjects()
      Animated.timing(translateX, { toValue: 0, duration: 200, useNativeDriver: true }).start()
    } else {
      Animated.timing(translateX, { toValue: -SIDEBAR_WIDTH, duration: 180, useNativeDriver: true }).start(
        ({ finished }) => {
          if (finished) setRendered(false)
        },
      )
    }
  }, [open, translateX, fetchProjects])

  const handleThreadLongPress = useCallback(
    (projectId: string, thread: Thread) => {
      Alert.alert(thread.name, undefined, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Rename', onPress: () => setRenameTarget({ projectId, thread }) },
        {
          text: 'Archive',
          style: 'destructive',
          onPress: () => {
            const { selectedThreadId, clearSelection } = useUiStore.getState()
            void archive(projectId, thread.id).then(() => {
              if (selectedThreadId === thread.id) clearSelection()
            })
          },
        },
      ])
    },
    [archive],
  )

  if (!rendered && !open) {
    return (
      <>
        <NewThreadModal projectId={newThreadProjectId} onClose={() => setNewThreadProjectId(null)} />
        <RenameThreadModal target={renameTarget} onClose={() => setRenameTarget(null)} />
      </>
    )
  }

  return (
    <>
      <View style={StyleSheet.absoluteFill} pointerEvents={open ? 'auto' : 'none'}>
        {/* Backdrop */}
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)', opacity: open ? 1 : 0 }]}
          onPress={() => setSidebarOpen(false)}
        />
        {/* Panel */}
        <Animated.View
          style={[
            styles.panel,
            { width: SIDEBAR_WIDTH, paddingTop: insets.top, paddingBottom: insets.bottom, transform: [{ translateX }] },
          ]}
        >
          <View style={styles.header}>
            <ConnectionBadge />
            <Text style={styles.hostLabel} numberOfLines={1}>
              {activeHost?.label ?? 'PolyCode'}
            </Text>
            <Pressable onPress={() => router.push('/hosts')} hitSlop={8}>
              <Text style={styles.hostsLink}>Hosts</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ paddingVertical: 6 }}>
            {projects.map((project) => (
              <ProjectSection
                key={project.id}
                project={project}
                onNewThread={setNewThreadProjectId}
                onThreadLongPress={handleThreadLongPress}
              />
            ))}
            {projects.length === 0 ? (
              <Text style={styles.emptyText}>No projects on this host.</Text>
            ) : null}
          </ScrollView>
        </Animated.View>
      </View>
      <NewThreadModal projectId={newThreadProjectId} onClose={() => setNewThreadProjectId(null)} />
      <RenameThreadModal target={renameTarget} onClose={() => setRenameTarget(null)} />
    </>
  )
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.surface,
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  hostLabel: { color: colors.text, fontSize: 15, fontWeight: '700', flex: 1 },
  hostsLink: { color: colors.claude, fontSize: 13, fontWeight: '500' },
  projectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  projectChevron: { color: colors.textMuted, fontSize: 11, width: 12 },
  projectName: { color: colors.text, fontSize: 14, fontWeight: '600', flex: 1 },
  threadList: { paddingBottom: 4 },
  threadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 34,
    paddingRight: 12,
    paddingVertical: 8,
  },
  threadRowSelected: {
    backgroundColor: 'rgba(232, 123, 95, 0.10)',
    borderRightWidth: 2,
    borderRightColor: colors.claude,
  },
  threadName: { color: colors.textMuted, fontSize: 13, flex: 1 },
  unreadDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.claude },
  newThreadRow: { paddingLeft: 34, paddingVertical: 7 },
  newThreadText: { color: colors.claude, fontSize: 12.5, fontWeight: '500' },
  emptyText: { color: colors.textMuted, fontSize: 13, padding: 16 },
})
