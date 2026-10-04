import { useRouter } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { Alert, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import type { Project, RepoLocation, Thread } from '@polycode/shared'
import { rpc } from '@/api/rpc'
import { worktreeParent } from '@/lib/locations'
import { openNewThread, openThread } from '@/lib/navigation'
import { useHostsStore } from '@/stores/hosts'
import { useProjectsStore } from '@/stores/projects'
import { useThreadsStore } from '@/stores/threads'
import { useUiStore } from '@/stores/ui'
import { colors } from '@/theme/colors'
import { ActionSheet } from './ActionSheet'
import { CommandsPanel } from './CommandsPanel'
import { NewWorktreeSheet } from './ProjectAdmin'
import {
  snoozedDetail,
  ThreadActionSheets,
  ThreadListModal,
  type ThreadActionOps,
  type ThreadListAction,
} from './ThreadModals'
import { ThreadSections, TreeLink, treeStyles as styles } from './TreeParts'

const EMPTY_THREADS: Thread[] = []

interface ThreadTarget {
  key: string
  projectId: string
  thread: Thread
}

/** The long-press menu's operations, against the active host's stores. */
const THREAD_OPS: ThreadActionOps<ThreadTarget> = {
  rename: (target, name) => useThreadsStore.getState().rename(target.projectId, target.thread.id, name),
  reset: (target) => useThreadsStore.getState().reset(target.thread.id),
  snooze: (target, untilIso) => useThreadsStore.getState().snooze(target.projectId, target.thread.id, untilIso),
  archive: (target) => useThreadsStore.getState().archive(target.projectId, target.thread.id),
  remove: (target) => useThreadsStore.getState().remove(target.projectId, target.thread.id),
}

const loadArchived = (projectId: string): Promise<Thread[]> => useThreadsStore.getState().listArchived(projectId)
const loadSnoozed = (projectId: string): Promise<Thread[]> => useThreadsStore.getState().listSnoozed(projectId)

const ARCHIVED_ACTIONS: ThreadListAction<string>[] = [
  { label: 'Restore', run: (projectId, thread) => useThreadsStore.getState().unarchive(projectId, thread.id) },
  {
    label: 'Delete',
    confirm: {
      title: 'Delete thread?',
      message: (thread) => `Permanently delete "${thread.name}"?`,
      button: 'Delete',
    },
    run: (projectId, thread) => useThreadsStore.getState().remove(projectId, thread.id),
  },
]

const SNOOZED_ACTIONS: ThreadListAction<string>[] = [
  { label: 'Wake', run: (projectId, thread) => useThreadsStore.getState().wake(projectId, thread.id) },
  { label: 'Archive', run: (projectId, thread) => useThreadsStore.getState().archive(projectId, thread.id) },
]

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
  const router = useRouter()
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

  return (
    <View style={styles.projectCard}>
      <Pressable
        onPress={() => toggleProject(project.id)}
        onLongPress={() => props.onProjectLongPress(project)}
        style={({ pressed }) => [styles.projectRow, pressed && { opacity: 0.7 }]}
      >
        <Text style={[styles.projectChevron, expanded && styles.projectChevronOpen]}>▸</Text>
        <Text style={styles.projectName} numberOfLines={1}>
          {project.name}
        </Text>
        {threads.some((t) => t.status === 'running') ? <View style={styles.runningDot} /> : null}
      </Pressable>
      {expanded ? (
        <View style={styles.threadList}>
          <ThreadSections
            locations={locations}
            threads={threads}
            onThreadPress={(thread) => openThread(router, { id: thread.id, project_id: project.id })}
            onThreadLongPress={(thread) => props.onThreadLongPress(project.id, thread)}
            onLocationLongPress={(location) => props.onLocationLongPress(project.id, location)}
          />
          <TreeLink label="＋ New thread" accent onPress={() => props.onNewThread(project.id)} />
          <TreeLink label="▶ Commands" onPress={() => props.onShowCommands(project.id)} />
          {/* Snoozed above Archived: temporary and returning vs terminal. */}
          {snoozedTotal > 0 ? (
            <TreeLink label={`Snoozed (${snoozedTotal})`} onPress={() => props.onShowSnoozed(project.id)} />
          ) : null}
          {archivedTotal > 0 ? (
            <TreeLink label={`Archived (${archivedTotal})`} onPress={() => props.onShowArchived(project.id)} />
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

  const [actionTarget, setActionTarget] = useState<ThreadTarget | null>(null)
  const [archivedProjectId, setArchivedProjectId] = useState<string | null>(null)
  const [snoozedProjectId, setSnoozedProjectId] = useState<string | null>(null)
  const [commandsProjectId, setCommandsProjectId] = useState<string | null>(null)
  const [projectAction, setProjectAction] = useState<Project | null>(null)
  const [worktreeTarget, setWorktreeTarget] = useState<{ projectId: string; parentLocationId: string } | null>(null)

  const handleThreadLongPress = useCallback((projectId: string, thread: Thread) => {
    setActionTarget({ key: `${projectId}:${thread.id}`, projectId, thread })
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

      <ThreadActionSheets target={actionTarget} ops={THREAD_OPS} onClose={() => setActionTarget(null)} />
      {/*
        Mobile shares `threads:list` with the desktop, so a snoozed thread drops out of
        the project list here too; without this sheet it would simply vanish with no
        affordance to get it back. The Queue's Snoozed section covers this across all
        projects; this one answers it for a single project, from the tree.
      */}
      <ThreadListModal
        target={snoozedProjectId}
        title="Snoozed Threads"
        emptyText="No snoozed threads."
        load={loadSnoozed}
        detail={snoozedDetail}
        actions={SNOOZED_ACTIONS}
        onClose={() => setSnoozedProjectId(null)}
      />
      <ThreadListModal
        target={archivedProjectId}
        title="Archived Threads"
        emptyText="No archived threads."
        load={loadArchived}
        actions={ARCHIVED_ACTIONS}
        onClose={() => setArchivedProjectId(null)}
      />
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
