import { useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  Animated,
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { Project, RepoLocation, Thread } from '@polycode/shared'
import { sseManager, type ConnectionState } from '@/api/sse'
import { useHostsStore } from '@/stores/hosts'
import { useProjectsStore } from '@/stores/projects'
import { useThreadsStore } from '@/stores/threads'
import { useUiStore } from '@/stores/ui'
import { colors } from '@/theme/colors'
import { ThreadStatusIndicator } from './StatusDot'
import { ActionSheet } from './ActionSheet'
import { CommandsPanel } from './CommandsPanel'
import { RenameThreadModal } from './ThreadModals'

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

/** Modal listing a project's archived threads with unarchive/delete actions. */
function ArchivedThreadsModal(props: { projectId: string | null; onClose: () => void }) {
  const { projectId, onClose } = props
  const [archived, setArchived] = useState<Thread[]>([])
  const listArchived = useThreadsStore((s) => s.listArchived)
  const unarchive = useThreadsStore((s) => s.unarchive)
  const remove = useThreadsStore((s) => s.remove)

  const reload = useCallback(() => {
    if (!projectId) return
    listArchived(projectId)
      .then(setArchived)
      .catch((error: unknown) => Alert.alert('Could not load archived threads', String(error)))
  }, [projectId, listArchived])

  useEffect(() => {
    setArchived([])
    reload()
  }, [reload])

  return (
    <Modal visible={projectId !== null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalSheet} onPress={() => undefined}>
          <Text style={styles.modalTitle}>Archived Threads</Text>
          <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: 10 }}>
            {archived.length === 0 ? <Text style={styles.emptyText}>No archived threads.</Text> : null}
            {archived.map((thread) => (
              <View key={thread.id} style={styles.archivedRow}>
                <Text style={styles.archivedName} numberOfLines={1}>
                  {thread.name}
                </Text>
                <Pressable
                  hitSlop={6}
                  onPress={() => {
                    if (!projectId) return
                    void unarchive(projectId, thread.id).then(reload)
                  }}
                >
                  <Text style={styles.archivedAction}>Restore</Text>
                </Pressable>
                <Pressable
                  hitSlop={6}
                  onPress={() => {
                    if (!projectId) return
                    Alert.alert('Delete thread?', `Permanently delete "${thread.name}"?`, [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Delete',
                        style: 'destructive',
                        onPress: () => void remove(projectId, thread.id).then(reload),
                      },
                    ])
                  }}
                >
                  <Text style={[styles.archivedAction, { color: colors.danger }]}>Delete</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

function ProjectSection(props: {
  project: Project
  onNewThread: (projectId: string) => void
  onThreadLongPress: (projectId: string, thread: Thread) => void
  onShowArchived: (projectId: string) => void
  onShowCommands: (projectId: string) => void
}) {
  const { project } = props
  const expanded = useUiStore((s) => s.expandedProjectIds.includes(project.id))
  const toggleProject = useUiStore((s) => s.toggleProject)
  const threads = useThreadsStore((s) => s.threadsByProject[project.id] ?? EMPTY_THREADS)
  const fetchThreads = useThreadsStore((s) => s.fetch)
  const archivedCount = useThreadsStore((s) => s.archivedCount)
  const locations = useProjectsStore((s) => s.locationsByProject[project.id])
  const fetchLocations = useProjectsStore((s) => s.fetchLocations)
  const [archivedTotal, setArchivedTotal] = useState(0)

  useEffect(() => {
    if (expanded) {
      void fetchThreads(project.id)
      void fetchLocations(project.id).catch(() => undefined)
      archivedCount(project.id)
        .then(setArchivedTotal)
        .catch(() => setArchivedTotal(0))
    }
  }, [expanded, project.id, fetchThreads, fetchLocations, archivedCount])

  // Desktop parity: with multiple locations (e.g. worktrees), group threads
  // under muted location headers instead of one flat list.
  const grouped = (() => {
    if (!locations || locations.length <= 1) return null
    const byLocation = new Map<string, Thread[]>()
    const orphans: Thread[] = []
    for (const thread of threads) {
      if (thread.location_id && locations.some((l) => l.id === thread.location_id)) {
        const list = byLocation.get(thread.location_id) ?? []
        list.push(thread)
        byLocation.set(thread.location_id, list)
      } else {
        orphans.push(thread)
      }
    }
    const sections: { location: RepoLocation | null; threads: Thread[] }[] = []
    for (const location of locations) {
      const list = byLocation.get(location.id)
      if (list && list.length > 0) sections.push({ location, threads: list })
    }
    if (orphans.length > 0) sections.push({ location: null, threads: orphans })
    return sections
  })()

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
          {grouped
            ? grouped.map((section, index) => (
                <View key={section.location?.id ?? `other-${index}`}>
                  <View style={styles.locationHeader}>
                    <Text style={styles.locationLabel} numberOfLines={1}>
                      {section.location
                        ? `${section.location.is_worktree ? '⎇ ' : ''}${section.location.label || section.location.path}`
                        : 'Other'}
                    </Text>
                  </View>
                  {section.threads.map((thread) => (
                    <ThreadRow
                      key={thread.id}
                      projectId={project.id}
                      thread={thread}
                      onLongPress={props.onThreadLongPress}
                    />
                  ))}
                </View>
              ))
            : threads.map((thread) => (
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
          <Pressable
            onPress={() => props.onShowCommands(project.id)}
            style={({ pressed }) => [styles.newThreadRow, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.archivedLink}>▶ Commands</Text>
          </Pressable>
          {archivedTotal > 0 ? (
            <Pressable
              onPress={() => props.onShowArchived(project.id)}
              style={({ pressed }) => [styles.newThreadRow, pressed && { opacity: 0.7 }]}
            >
              <Text style={styles.archivedLink}>Archived ({archivedTotal})</Text>
            </Pressable>
          ) : null}
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

  const [renameTarget, setRenameTarget] = useState<{ projectId: string; thread: Thread } | null>(null)
  const [actionTarget, setActionTarget] = useState<{ projectId: string; thread: Thread } | null>(null)
  const [locationPicker, setLocationPicker] = useState<{ projectId: string; locations: RepoLocation[] } | null>(null)
  const [archivedProjectId, setArchivedProjectId] = useState<string | null>(null)
  const [commandsProjectId, setCommandsProjectId] = useState<string | null>(null)

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

  const handleThreadLongPress = useCallback((projectId: string, thread: Thread) => {
    setActionTarget({ projectId, thread })
  }, [])

  // Desktop parity: create instantly (auto-titled after the first message).
  const quickCreateThread = useCallback(async (projectId: string, locationId?: string) => {
    try {
      let locs = useProjectsStore.getState().locationsByProject[projectId]
      if (!locs || locs.length === 0) locs = await useProjectsStore.getState().fetchLocations(projectId)
      const location = locationId
        ? locs.find((l) => l.id === locationId)
        : (locs.find((l) => l.checked_out) ?? locs[0])
      if (!location) {
        Alert.alert('No location', 'This project has no repo locations yet — add one on the desktop.')
        return
      }
      const thread = await useThreadsStore.getState().create(projectId, 'New thread', location.id)
      useUiStore.getState().selectThread(projectId, thread.id)
    } catch (error) {
      Alert.alert('Could not create thread', error instanceof Error ? error.message : String(error))
    }
  }, [])

  const pickLocationForNewThread = useCallback((projectId: string) => {
    const locations = useProjectsStore.getState().locationsByProject[projectId] ?? []
    if (locations.length > 1) {
      setLocationPicker({ projectId, locations })
    } else {
      void quickCreateThread(projectId)
    }
  }, [quickCreateThread])

  if (!rendered && !open) {
    return (
      <>
        <RenameThreadModal target={renameTarget} onClose={() => setRenameTarget(null)} />
        <ActionSheet
          visible={actionTarget !== null}
          title={actionTarget?.thread.name}
          onClose={() => setActionTarget(null)}
          options={
            actionTarget
              ? [
                  { label: 'Rename', onPress: () => setRenameTarget(actionTarget) },
                  {
                    label: 'Reset session',
                    onPress: () =>
                      Alert.alert('Reset session?', 'Clears the agent context for this thread (messages are kept).', [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Reset',
                          style: 'destructive',
                          onPress: () => void useThreadsStore.getState().reset(actionTarget.thread.id),
                        },
                      ]),
                  },
                  {
                    label: 'Archive',
                    onPress: () => {
                      const { selectedThreadId, clearSelection } = useUiStore.getState()
                      void archive(actionTarget.projectId, actionTarget.thread.id).then(() => {
                        if (selectedThreadId === actionTarget.thread.id) clearSelection()
                      })
                    },
                  },
                  {
                    label: 'Delete',
                    destructive: true,
                    onPress: () =>
                      Alert.alert('Delete thread?', `Permanently delete "${actionTarget.thread.name}" and its messages?`, [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Delete',
                          style: 'destructive',
                          onPress: () => {
                            const { selectedThreadId, clearSelection } = useUiStore.getState()
                            void useThreadsStore
                              .getState()
                              .remove(actionTarget.projectId, actionTarget.thread.id)
                              .then(() => {
                                if (selectedThreadId === actionTarget.thread.id) clearSelection()
                              })
                          },
                        },
                      ]),
                  },
                ]
              : []
          }
        />
        <ActionSheet
          visible={locationPicker !== null}
          title="New thread location"
          onClose={() => setLocationPicker(null)}
          options={
            locationPicker
              ? locationPicker.locations.map((location) => ({
                  label: `${location.is_worktree ? '⎇ ' : ''}${location.label || location.path}`,
                  onPress: () => void quickCreateThread(locationPicker.projectId, location.id),
                }))
              : []
          }
        />
      <ArchivedThreadsModal projectId={archivedProjectId} onClose={() => setArchivedProjectId(null)} />
      <CommandsPanel projectId={commandsProjectId} onClose={() => setCommandsProjectId(null)} />
        <CommandsPanel projectId={commandsProjectId} onClose={() => setCommandsProjectId(null)} />
        <ArchivedThreadsModal projectId={archivedProjectId} onClose={() => setArchivedProjectId(null)} />
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
                onNewThread={pickLocationForNewThread}
                onThreadLongPress={handleThreadLongPress}
                onShowArchived={setArchivedProjectId}
                onShowCommands={setCommandsProjectId}
              />
            ))}
            {projects.length === 0 ? (
              <Text style={styles.emptyText}>No projects on this host.</Text>
            ) : null}
          </ScrollView>
        </Animated.View>
      </View>
      <RenameThreadModal target={renameTarget} onClose={() => setRenameTarget(null)} />
      <ActionSheet
        visible={actionTarget !== null}
        title={actionTarget?.thread.name}
        onClose={() => setActionTarget(null)}
        options={
          actionTarget
            ? [
                { label: 'Rename', onPress: () => setRenameTarget(actionTarget) },
                {
                  label: 'Reset session',
                  onPress: () =>
                    Alert.alert('Reset session?', 'Clears the agent context for this thread (messages are kept).', [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Reset',
                        style: 'destructive',
                        onPress: () => void useThreadsStore.getState().reset(actionTarget.thread.id),
                      },
                    ]),
                },
                {
                  label: 'Archive',
                  onPress: () => {
                    const { selectedThreadId, clearSelection } = useUiStore.getState()
                    void archive(actionTarget.projectId, actionTarget.thread.id).then(() => {
                      if (selectedThreadId === actionTarget.thread.id) clearSelection()
                    })
                  },
                },
                {
                  label: 'Delete',
                  destructive: true,
                  onPress: () =>
                    Alert.alert('Delete thread?', `Permanently delete "${actionTarget.thread.name}" and its messages?`, [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Delete',
                        style: 'destructive',
                        onPress: () => {
                          const { selectedThreadId, clearSelection } = useUiStore.getState()
                          void useThreadsStore
                            .getState()
                            .remove(actionTarget.projectId, actionTarget.thread.id)
                            .then(() => {
                              if (selectedThreadId === actionTarget.thread.id) clearSelection()
                            })
                        },
                      },
                    ]),
                },
              ]
            : []
        }
      />
      <ActionSheet
        visible={locationPicker !== null}
        title="New thread location"
        onClose={() => setLocationPicker(null)}
        options={
          locationPicker
            ? locationPicker.locations.map((location) => ({
                label: `${location.is_worktree ? '⎇ ' : ''}${location.label || location.path}`,
                onPress: () => void quickCreateThread(locationPicker.projectId, location.id),
              }))
            : []
        }
      />
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
  archivedLink: { color: colors.textMuted, fontSize: 12.5, fontWeight: '500' },
  locationHeader: { paddingLeft: 26, paddingTop: 7, paddingBottom: 2 },
  locationLabel: {
    color: colors.textMuted,
    fontSize: 10.5,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    opacity: 0.8,
  },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 18,
    paddingBottom: 28,
    gap: 12,
  },
  modalTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  archivedRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  archivedName: { color: colors.text, fontSize: 13.5, flex: 1 },
  archivedAction: { color: colors.claude, fontSize: 13, fontWeight: '600' },
})
