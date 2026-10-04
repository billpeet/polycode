import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { RepoLocation, Thread, UnifiedProject, UnifiedProjectMember } from '@polycode/shared'
import { worktreeParent } from '@/lib/locations'
import { openNewThread, openSourceThread } from '@/lib/navigation'
import { activateHost } from '@/lib/sources'
import { useUnifiedStore } from '@/stores/unified'
import { colors } from '@/theme/colors'
import { ActionSheet } from './ActionSheet'
import { CommandsPanel } from './CommandsPanel'
import { NewWorktreeSheet } from './ProjectAdmin'
import { SourcePill, UnreachableSources } from './SourceBadge'
import {
  snoozedDetail,
  ThreadActionSheets,
  ThreadListModal,
  type ThreadActionOps,
  type ThreadListAction,
} from './ThreadModals'
import { ThreadSections, TreeLink, treeStyles } from './TreeParts'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A Thread on a particular host. */
interface ThreadTarget {
  key: string
  sourceId: string
  thread: Thread
}

/** One host's copy of a Project. */
interface MemberTarget {
  sourceId: string
  projectId: string
}

/** The long-press menu's operations, sent to whichever host owns the Thread. */
const THREAD_OPS: ThreadActionOps<ThreadTarget> = {
  rename: (target, name) => useUnifiedStore.getState().renameThread(target.sourceId, target.thread.id, name),
  reset: (target) => useUnifiedStore.getState().resetThread(target.sourceId, target.thread.id),
  snooze: (target, untilIso) => useUnifiedStore.getState().snoozeThread(target.sourceId, target.thread.id, untilIso),
  archive: (target) => useUnifiedStore.getState().archiveThread(target.sourceId, target.thread.id),
  remove: (target) => useUnifiedStore.getState().deleteThread(target.sourceId, target.thread.id),
}

const loadArchived = (target: MemberTarget): Promise<Thread[]> =>
  useUnifiedStore.getState().invokeOn(target.sourceId, 'threads:listArchived', target.projectId)
const loadSnoozed = (target: MemberTarget): Promise<Thread[]> =>
  useUnifiedStore.getState().invokeOn(target.sourceId, 'threads:listSnoozed', target.projectId)

const ARCHIVED_ACTIONS: ThreadListAction<MemberTarget>[] = [
  { label: 'Restore', run: (target, thread) => useUnifiedStore.getState().unarchiveThread(target.sourceId, thread.id) },
  {
    label: 'Delete',
    confirm: {
      title: 'Delete thread?',
      message: (thread) => `Permanently delete "${thread.name}"?`,
      button: 'Delete',
    },
    run: (target, thread) => useUnifiedStore.getState().deleteThread(target.sourceId, thread.id),
  },
]

const SNOOZED_ACTIONS: ThreadListAction<MemberTarget>[] = [
  { label: 'Wake', run: (target, thread) => useUnifiedStore.getState().wakeThread(target.sourceId, thread.id) },
  { label: 'Archive', run: (target, thread) => useUnifiedStore.getState().archiveThread(target.sourceId, thread.id) },
]

interface MemberHandlers {
  onThreadLongPress: (member: UnifiedProjectMember, thread: Thread) => void
  onLocationLongPress: (member: UnifiedProjectMember, location: RepoLocation) => void
  onNewThread: (member: UnifiedProjectMember) => void
  onShowCommands: (member: UnifiedProjectMember) => void
  onShowSnoozed: (member: UnifiedProjectMember) => void
  onShowArchived: (member: UnifiedProjectMember) => void
  onMemberLongPress: (member: UnifiedProjectMember) => void
}

/** One host's Threads for a Project, and the links that act on that host's copy of it. */
function MemberSection(props: { member: UnifiedProjectMember; showHeader: boolean } & MemberHandlers) {
  const { member } = props
  const router = useRouter()
  return (
    <View>
      {props.showHeader ? (
        <Pressable
          style={({ pressed }) => [styles.memberHeader, pressed && { opacity: 0.7 }]}
          onLongPress={() => props.onMemberLongPress(member)}
        >
          <SourcePill sourceId={member.sourceId} label={member.sourceLabel} />
          <Text style={styles.memberCount}>
            {member.threads.length} {member.threads.length === 1 ? 'thread' : 'threads'}
          </Text>
        </Pressable>
      ) : null}
      <ThreadSections
        locations={member.locations}
        threads={member.threads}
        onThreadPress={(thread) =>
          openSourceThread(router, member.sourceId, { id: thread.id, project_id: member.project.id })
        }
        onThreadLongPress={(thread) => props.onThreadLongPress(member, thread)}
        onLocationLongPress={(location) => props.onLocationLongPress(member, location)}
      />
      <TreeLink label="＋ New thread" accent onPress={() => props.onNewThread(member)} />
      <TreeLink label="▶ Commands" onPress={() => props.onShowCommands(member)} />
      {/* Snoozed above Archived: temporary and returning vs terminal. */}
      {member.snoozedCount > 0 ? (
        <TreeLink label={`Snoozed (${member.snoozedCount})`} onPress={() => props.onShowSnoozed(member)} />
      ) : null}
      {member.archivedCount > 0 ? (
        <TreeLink label={`Archived (${member.archivedCount})`} onPress={() => props.onShowArchived(member)} />
      ) : null}
    </View>
  )
}

function ProjectSection(props: { project: UnifiedProject } & MemberHandlers) {
  const { project, ...handlers } = props
  const expanded = useUnifiedStore((s) => s.expandedProjects[project.key] === true)
  const toggleProject = useUnifiedStore((s) => s.toggleProject)
  const [only] = project.members
  const single = project.members.length === 1
  const running = project.members.some((member) => member.threads.some((t) => t.status === 'running'))

  return (
    <View style={treeStyles.projectCard}>
      <Pressable
        onPress={() => toggleProject(project.key)}
        // With one copy the Project row stands for it; with several, each host's
        // header carries its own menu, since the actions apply to one copy.
        onLongPress={single ? () => handlers.onMemberLongPress(only) : undefined}
        style={({ pressed }) => [treeStyles.projectRow, pressed && { opacity: 0.7 }]}
      >
        <Text style={[treeStyles.projectChevron, expanded && treeStyles.projectChevronOpen]}>▸</Text>
        <Text style={treeStyles.projectName} numberOfLines={1}>
          {project.name}
        </Text>
        {running ? <View style={treeStyles.runningDot} /> : null}
        {project.members.map((member) => (
          <SourcePill
            key={`${member.sourceId}:${member.project.id}`}
            sourceId={member.sourceId}
            label={member.sourceLabel}
          />
        ))}
      </Pressable>
      {expanded ? (
        <View style={treeStyles.threadList}>
          {project.members.map((member) => (
            <MemberSection
              key={`${member.sourceId}:${member.project.id}`}
              member={member}
              showHeader={!single}
              {...handlers}
            />
          ))}
        </View>
      ) : null}
    </View>
  )
}

/**
 * The unified ("All") tree: every host's Projects in one list, with Projects checked out
 * from the same repository merged into one card that has a section per host.
 *
 * Reading and tidying — rename, snooze, archive, delete, the Snoozed and Archived sheets —
 * go straight to the host that owns the Thread. Whatever needs the workspace (opening a
 * Thread, the New-thread sheet, commands, a new worktree) makes that host the active one
 * first, then takes the same path the single-host tree does.
 */
export function UnifiedProjectTree() {
  const router = useRouter()
  const projects = useUnifiedStore((s) => s.projects)
  const loading = useUnifiedStore((s) => s.loading)
  const loaded = useUnifiedStore((s) => s.snapshot !== null)
  const refresh = useUnifiedStore((s) => s.refresh)

  const [actionTarget, setActionTarget] = useState<ThreadTarget | null>(null)
  const [archivedTarget, setArchivedTarget] = useState<MemberTarget | null>(null)
  const [snoozedTarget, setSnoozedTarget] = useState<MemberTarget | null>(null)
  const [commandsProjectId, setCommandsProjectId] = useState<string | null>(null)
  const [memberAction, setMemberAction] = useState<UnifiedProjectMember | null>(null)
  const [worktreeTarget, setWorktreeTarget] = useState<{ projectId: string; parentLocationId: string } | null>(null)
  /** The host a workspace sheet (commands, new worktree) was opened against, to refresh it on close. */
  const [sheetSourceId, setSheetSourceId] = useState<string | null>(null)

  const memberTarget = (member: UnifiedProjectMember): MemberTarget => ({
    sourceId: member.sourceId,
    projectId: member.project.id,
  })

  /** Run a host mutation, then reload that host; failures surface as an alert. */
  const mutate = (sourceId: string, failure: string, action: Promise<unknown>): void => {
    action
      .then(() => useUnifiedStore.getState().refresh([sourceId]))
      .catch((error: unknown) => Alert.alert(failure, errorText(error)))
  }

  const closeSheet = (): void => {
    if (sheetSourceId) useUnifiedStore.getState().scheduleRefresh(sheetSourceId)
    setSheetSourceId(null)
    setCommandsProjectId(null)
    setWorktreeTarget(null)
  }

  const handlers: MemberHandlers = {
    onThreadLongPress: (member, thread) =>
      setActionTarget({ key: `${member.sourceId}:${thread.id}`, sourceId: member.sourceId, thread }),
    onLocationLongPress: (member, location) => {
      if (!location.is_worktree) return
      Alert.alert(
        'Remove worktree?',
        `Remove "${location.label || location.path}" on ${member.sourceLabel}? Threads are archived; the worktree directory is deleted.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: () =>
              mutate(
                member.sourceId,
                'Remove failed',
                useUnifiedStore.getState().invokeOn(member.sourceId, 'locations:removeWorktree', location.id),
              ),
          },
        ],
      )
    },
    onNewThread: (member) => {
      activateHost(member.sourceId)
      openNewThread(router, member.project.id)
    },
    onShowCommands: (member) => {
      // The panel talks to the active host, so this Project's host has to be it.
      activateHost(member.sourceId)
      setSheetSourceId(member.sourceId)
      setCommandsProjectId(member.project.id)
    },
    onShowSnoozed: (member) => setSnoozedTarget(memberTarget(member)),
    onShowArchived: (member) => setArchivedTarget(memberTarget(member)),
    onMemberLongPress: setMemberAction,
  }

  return (
    <>
      <ScrollView
        contentContainerStyle={treeStyles.list}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={colors.textMuted} />}
      >
        <UnreachableSources />
        {projects.map((project) => (
          <ProjectSection key={project.key} project={project} {...handlers} />
        ))}
        {projects.length === 0 && loaded && !loading ? (
          <Text style={treeStyles.emptyText}>No projects on any host.</Text>
        ) : null}
      </ScrollView>

      <ThreadActionSheets target={actionTarget} ops={THREAD_OPS} onClose={() => setActionTarget(null)} />
      <ThreadListModal
        target={snoozedTarget}
        title="Snoozed Threads"
        emptyText="No snoozed threads."
        load={loadSnoozed}
        detail={snoozedDetail}
        actions={SNOOZED_ACTIONS}
        onClose={() => setSnoozedTarget(null)}
      />
      <ThreadListModal
        target={archivedTarget}
        title="Archived Threads"
        emptyText="No archived threads."
        load={loadArchived}
        actions={ARCHIVED_ACTIONS}
        onClose={() => setArchivedTarget(null)}
      />
      <CommandsPanel projectId={commandsProjectId} onClose={closeSheet} />
      <NewWorktreeSheet target={worktreeTarget} onClose={closeSheet} />
      <ActionSheet
        visible={memberAction !== null}
        title={memberAction ? `${memberAction.project.name} · ${memberAction.sourceLabel}` : undefined}
        onClose={() => setMemberAction(null)}
        options={
          memberAction
            ? [
                {
                  label: 'New worktree',
                  onPress: () => {
                    const parent = worktreeParent(memberAction.locations)
                    if (!parent) {
                      Alert.alert('No local checkout', 'Worktrees are created from a local, non-worktree location.')
                      return
                    }
                    // The sheet creates the worktree through the active host.
                    activateHost(memberAction.sourceId)
                    setSheetSourceId(memberAction.sourceId)
                    setWorktreeTarget({ projectId: memberAction.project.id, parentLocationId: parent.id })
                  },
                },
                {
                  label: 'Archive project',
                  onPress: () =>
                    mutate(
                      memberAction.sourceId,
                      'Archive failed',
                      useUnifiedStore.getState().invokeOn(memberAction.sourceId, 'projects:archive', memberAction.project.id),
                    ),
                },
                {
                  label: 'Delete project',
                  destructive: true,
                  onPress: () =>
                    Alert.alert(
                      'Delete project?',
                      `Permanently delete "${memberAction.project.name}" and all its threads on ${memberAction.sourceLabel}?`,
                      [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Delete',
                          style: 'destructive',
                          onPress: () =>
                            mutate(
                              memberAction.sourceId,
                              'Delete failed',
                              useUnifiedStore.getState().invokeOn(memberAction.sourceId, 'projects:delete', memberAction.project.id),
                            ),
                        },
                      ],
                    ),
                },
              ]
            : []
        }
      />
    </>
  )
}

const styles = StyleSheet.create({
  memberHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 12,
    paddingRight: 12,
    paddingTop: 10,
    paddingBottom: 2,
  },
  memberCount: { color: colors.textMuted, fontSize: 11 },
})
