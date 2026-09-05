import { useRouter } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { Alert, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { Project, RepoLocation, Thread } from '@polycode/shared'
import { formatWakeTime, resolveSnoozePreset, SNOOZE_PRESETS, timeUntil } from '@polycode/shared'
import { rpc } from '@/api/rpc'
import { locationLabel, worktreeParent } from '@/lib/locations'
import { openNewThread, openThread } from '@/lib/navigation'
import { useHostsStore } from '@/stores/hosts'
import { useProjectsStore } from '@/stores/projects'
import { useThreadsStore } from '@/stores/threads'
import { useUiStore } from '@/stores/ui'
import { colors, radii, sectionLabel } from '@/theme/colors'
import { ThreadStatusIndicator } from './StatusDot'
import { ActionSheet } from './ActionSheet'
import { CommandsPanel } from './CommandsPanel'
import { NewWorktreeSheet } from './ProjectAdmin'
import { RenameThreadModal } from './ThreadModals'

const EMPTY_THREADS: Thread[] = []

function ThreadRow(props: {
  projectId: string
  thread: Thread
  onLongPress: (projectId: string, thread: Thread) => void
}) {
  const { projectId, thread } = props
  const router = useRouter()

  return (
    <Pressable
      onPress={() => openThread(router, { id: thread.id, project_id: projectId })}
      onLongPress={() => props.onLongPress(projectId, thread)}
      style={({ pressed }) => [styles.threadRow, pressed && { opacity: 0.7 }]}
    >
      <ThreadStatusIndicator status={thread.status} unread={thread.unread} size={7} />
      <Text style={[styles.threadName, thread.unread && { fontWeight: '700', color: '#ffffff' }]} numberOfLines={1}>
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
    const timeoutId = setTimeout(() => {
      setArchived([])
      reload()
    }, 0)
    return () => clearTimeout(timeoutId)
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

/**
 * Modal listing a project's snoozed threads, with wake/archive actions.
 *
 * Mobile shares `threads:list` with the desktop, so a snoozed thread drops out
 * of the project list here too. Without this modal it would simply vanish with
 * no affordance to get it back. The Queue's Snoozed section covers this across
 * all projects; this one answers it for a single project, from the tree. Rows
 * show the wake time, since "when does this come back" is the only thing worth
 * knowing about deferred work.
 */
function SnoozedThreadsModal(props: { projectId: string | null; onClose: () => void }) {
  const { projectId, onClose } = props
  const [snoozed, setSnoozed] = useState<Thread[]>([])
  const listSnoozed = useThreadsStore((s) => s.listSnoozed)
  const wake = useThreadsStore((s) => s.wake)
  const archive = useThreadsStore((s) => s.archive)

  const reload = useCallback(() => {
    if (!projectId) return
    listSnoozed(projectId)
      .then(setSnoozed)
      .catch((error: unknown) => Alert.alert('Could not load snoozed threads', String(error)))
  }, [projectId, listSnoozed])

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      setSnoozed([])
      reload()
    }, 0)
    return () => clearTimeout(timeoutId)
  }, [reload])

  return (
    <Modal visible={projectId !== null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalSheet} onPress={() => undefined}>
          <Text style={styles.modalTitle}>Snoozed Threads</Text>
          <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: 10 }}>
            {snoozed.length === 0 ? <Text style={styles.emptyText}>No snoozed threads.</Text> : null}
            {snoozed.map((thread) => (
              <View key={thread.id} style={styles.archivedRow}>
                <Text style={styles.archivedName} numberOfLines={1}>
                  {thread.name}
                  {thread.snoozed_until ? ` · ${timeUntil(thread.snoozed_until)}` : ''}
                </Text>
                <Pressable
                  hitSlop={6}
                  onPress={() => {
                    if (!projectId) return
                    void wake(projectId, thread.id).then(reload)
                  }}
                >
                  <Text style={styles.archivedAction}>Wake</Text>
                </Pressable>
                <Pressable
                  hitSlop={6}
                  onPress={() => {
                    if (!projectId) return
                    void archive(projectId, thread.id).then(reload)
                  }}
                >
                  <Text style={styles.archivedAction}>Archive</Text>
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
  onShowSnoozed: (projectId: string) => void
  onShowCommands: (projectId: string) => void
  onProjectLongPress: (project: Project) => void
  onLocationLongPress: (projectId: string, location: RepoLocation) => void
}) {
  const { project } = props
  const expanded = useUiStore((s) => s.expandedProjectIds.includes(project.id))
  const toggleProject = useUiStore((s) => s.toggleProject)
  const threads = useThreadsStore((s) => s.threadsByProject[project.id] ?? EMPTY_THREADS)
  const fetchThreads = useThreadsStore((s) => s.fetch)
  const archivedCount = useThreadsStore((s) => s.archivedCount)
  const snoozedCount = useThreadsStore((s) => s.snoozedCount)
  const locations = useProjectsStore((s) => s.locationsByProject[project.id])
  const fetchLocations = useProjectsStore((s) => s.fetchLocations)
  const [archivedTotal, setArchivedTotal] = useState(0)
  const [snoozedTotal, setSnoozedTotal] = useState(0)

  useEffect(() => {
    if (expanded) {
      void fetchThreads(project.id)
      void fetchLocations(project.id).catch(() => undefined)
      archivedCount(project.id)
        .then(setArchivedTotal)
        .catch(() => setArchivedTotal(0))
      snoozedCount(project.id)
        .then(setSnoozedTotal)
        .catch(() => setSnoozedTotal(0))
    }
  }, [expanded, project.id, fetchThreads, fetchLocations, archivedCount, snoozedCount])

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
    <View style={styles.projectCard}>
      <Pressable
        onPress={() => toggleProject(project.id)}
        onLongPress={() => props.onProjectLongPress(project)}
        style={({ pressed }) => [styles.projectRow, pressed && { opacity: 0.7 }]}
      >
        <Text style={[styles.projectChevron, expanded && { transform: [{ rotate: '90deg' }] }]}>▸</Text>
        <Text style={styles.projectName} numberOfLines={1}>
          {project.name}
        </Text>
        {threads.some((t) => t.status === 'running') ? (
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent }} />
        ) : null}
      </Pressable>
      {expanded ? (
        <View style={styles.threadList}>
          {grouped
            ? grouped.map((section, index) => (
                <View key={section.location?.id ?? `other-${index}`}>
                  <Pressable
                    style={styles.locationHeader}
                    onLongPress={() => section.location && props.onLocationLongPress(project.id, section.location)}
                  >
                    <Text style={styles.locationLabel} numberOfLines={1}>
                      {section.location ? locationLabel(section.location) : 'Other'}
                    </Text>
                  </Pressable>
                  {section.threads.map((thread) => (
                    <ThreadRow key={thread.id} projectId={project.id} thread={thread} onLongPress={props.onThreadLongPress} />
                  ))}
                </View>
              ))
            : threads.map((thread) => (
                <ThreadRow key={thread.id} projectId={project.id} thread={thread} onLongPress={props.onThreadLongPress} />
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
          {/* Snoozed above Archived: temporary and returning vs terminal. */}
          {snoozedTotal > 0 ? (
            <Pressable
              onPress={() => props.onShowSnoozed(project.id)}
              style={({ pressed }) => [styles.newThreadRow, pressed && { opacity: 0.7 }]}
            >
              <Text style={styles.archivedLink}>Snoozed ({snoozedTotal})</Text>
            </Pressable>
          ) : null}
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

/**
 * The project → location → thread tree (the desktop sidebar's Tree mode),
 * now a full tab rather than a drawer. Every overlay is mounted exactly once
 * at the bottom, so a modal opened from any row has something to render it.
 */
export function ProjectTree() {
  const router = useRouter()
  const projects = useProjectsStore((s) => s.projects)
  const projectsLoading = useProjectsStore((s) => s.loading)
  const fetchProjects = useProjectsStore((s) => s.fetch)
  const archive = useThreadsStore((s) => s.archive)
  const snooze = useThreadsStore((s) => s.snooze)

  const [renameTarget, setRenameTarget] = useState<{ projectId: string; thread: Thread } | null>(null)
  const [actionTarget, setActionTarget] = useState<{ projectId: string; thread: Thread } | null>(null)
  const [archivedProjectId, setArchivedProjectId] = useState<string | null>(null)
  const [snoozedProjectId, setSnoozedProjectId] = useState<string | null>(null)
  const [snoozeTarget, setSnoozeTarget] = useState<{ projectId: string; thread: Thread } | null>(null)
  const [commandsProjectId, setCommandsProjectId] = useState<string | null>(null)
  const [projectAction, setProjectAction] = useState<Project | null>(null)
  const [worktreeTarget, setWorktreeTarget] = useState<{ projectId: string; parentLocationId: string } | null>(null)

  const handleThreadLongPress = useCallback((projectId: string, thread: Thread) => {
    setActionTarget({ projectId, thread })
  }, [])

  const handleNewThread = useCallback((projectId: string) => openNewThread(router, projectId), [router])

  const handleProjectLongPress = useCallback((project: Project) => {
    setProjectAction(project)
  }, [])

  const handleLocationLongPress = useCallback((projectId: string, location: RepoLocation) => {
    if (!location.is_worktree) return
    Alert.alert('Remove worktree?', `Remove "${location.label || location.path}"? Threads are archived; the worktree directory is deleted.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          const conn = useHostsStore.getState().activeConnection()
          if (!conn) return
          rpc(conn, 'locations:removeWorktree', location.id)
            .then(() => Promise.all([
              useProjectsStore.getState().fetchLocations(projectId),
              useThreadsStore.getState().fetch(projectId),
              useThreadsStore.getState().fetchQueue(),
            ]))
            .catch((error: unknown) => Alert.alert('Remove failed', error instanceof Error ? error.message : String(error)))
        },
      },
    ])
  }, [])

  return (
    <>
      <ScrollView
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={projectsLoading} onRefresh={() => void fetchProjects()} tintColor={colors.textMuted} />
        }
      >
        {projects.map((project) => (
          <ProjectSection
            key={project.id}
            project={project}
            onNewThread={handleNewThread}
            onThreadLongPress={handleThreadLongPress}
            onShowArchived={setArchivedProjectId}
            onShowSnoozed={setSnoozedProjectId}
            onShowCommands={setCommandsProjectId}
            onProjectLongPress={handleProjectLongPress}
            onLocationLongPress={handleLocationLongPress}
          />
        ))}
        {projects.length === 0 && !projectsLoading ? (
          <Text style={styles.emptyText}>No projects on this host.</Text>
        ) : null}
      </ScrollView>

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
                { label: 'Snooze', onPress: () => setSnoozeTarget(actionTarget) },
                {
                  label: 'Archive',
                  onPress: () => void archive(actionTarget.projectId, actionTarget.thread.id),
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
                        onPress: () => void useThreadsStore.getState().remove(actionTarget.projectId, actionTarget.thread.id),
                      },
                    ]),
                },
              ]
            : []
        }
      />
      {/*
        Presets only on mobile: resolution still happens client-side, so
        "tomorrow morning" means morning in the phone's timezone, not the
        host's. Labels show the resolved absolute time so a roll-forward is
        visible rather than inferred.
      */}
      <ActionSheet
        visible={snoozeTarget !== null}
        title="Snooze until"
        onClose={() => setSnoozeTarget(null)}
        options={
          snoozeTarget
            ? SNOOZE_PRESETS.map((preset) => {
                const at = resolveSnoozePreset(preset.id)
                return {
                  label: `${preset.label} · ${formatWakeTime(at)}`,
                  onPress: () => void snooze(snoozeTarget.projectId, snoozeTarget.thread.id, at.toISOString()),
                }
              })
            : []
        }
      />
      <SnoozedThreadsModal projectId={snoozedProjectId} onClose={() => setSnoozedProjectId(null)} />
      <ArchivedThreadsModal projectId={archivedProjectId} onClose={() => setArchivedProjectId(null)} />
      <CommandsPanel projectId={commandsProjectId} onClose={() => setCommandsProjectId(null)} />
      <NewWorktreeSheet target={worktreeTarget} onClose={() => setWorktreeTarget(null)} />
      <ActionSheet
        visible={projectAction !== null}
        title={projectAction?.name}
        onClose={() => setProjectAction(null)}
        options={
          projectAction
            ? [
                {
                  label: 'New worktree',
                  onPress: () => {
                    const proj = projectAction
                    void (async () => {
                      let locs = useProjectsStore.getState().locationsByProject[proj.id]
                      if (!locs) locs = await useProjectsStore.getState().fetchLocations(proj.id)
                      const parent = worktreeParent(locs)
                      if (!parent) {
                        Alert.alert('No local checkout', 'Worktrees are created from a local, non-worktree location.')
                        return
                      }
                      setWorktreeTarget({ projectId: proj.id, parentLocationId: parent.id })
                    })().catch((error: unknown) => Alert.alert('Failed', error instanceof Error ? error.message : String(error)))
                  },
                },
                {
                  label: 'Archive project',
                  onPress: () => {
                    const conn = useHostsStore.getState().activeConnection()
                    if (!conn) return
                    void rpc(conn, 'projects:archive', projectAction.id)
                      .then(() => Promise.all([useProjectsStore.getState().fetch(), useThreadsStore.getState().fetchQueue()]))
                      .catch((error: unknown) => Alert.alert('Archive failed', error instanceof Error ? error.message : String(error)))
                  },
                },
                {
                  label: 'Delete project',
                  destructive: true,
                  onPress: () =>
                    Alert.alert('Delete project?', `Permanently delete "${projectAction.name}" and all its threads?`, [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Delete',
                        style: 'destructive',
                        onPress: () => {
                          const conn = useHostsStore.getState().activeConnection()
                          if (!conn) return
                          void rpc(conn, 'projects:delete', projectAction.id)
                            .then(() => Promise.all([useProjectsStore.getState().fetch(), useThreadsStore.getState().fetchQueue()]))
                            .catch((error: unknown) => Alert.alert('Delete failed', error instanceof Error ? error.message : String(error)))
                        },
                      },
                    ]),
                },
              ]
            : []
        }
      />
    </>
  )
}

const styles = StyleSheet.create({
  // Room for the floating New-thread button over the last row.
  list: { padding: 12, paddingBottom: 96, gap: 8 },
  projectCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  projectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  projectChevron: { color: colors.textMuted, fontSize: 11, width: 12 },
  projectName: { color: colors.text, fontSize: 14, fontWeight: '600', flex: 1 },
  threadList: { paddingBottom: 6, borderTopWidth: 1, borderTopColor: colors.border },
  threadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 30,
    paddingRight: 12,
    paddingVertical: 9,
  },
  threadName: { color: colors.textMuted, fontSize: 13, flex: 1 },
  unreadDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
  newThreadRow: { paddingLeft: 30, paddingVertical: 7 },
  newThreadText: { color: colors.accent, fontSize: 12.5, fontWeight: '500' },
  emptyText: { color: colors.textMuted, fontSize: 13, padding: 16 },
  archivedLink: { color: colors.textMuted, fontSize: 12.5, fontWeight: '500' },
  locationHeader: { paddingLeft: 24, paddingTop: 8, paddingBottom: 2 },
  locationLabel: { ...sectionLabel, opacity: 0.8 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 18,
    paddingBottom: 28,
    gap: 12,
  },
  modalTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  archivedRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  archivedName: { color: colors.text, fontSize: 13.5, flex: 1 },
  archivedAction: { color: colors.accent, fontSize: 13, fontWeight: '600' },
})
