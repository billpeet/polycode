import { useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import type { QueueThread } from '@polycode/shared'
import {
  bucketQueueThreads,
  formatWakeTime,
  isSnoozed,
  resolveSnoozePreset,
  SNOOZE_PRESETS,
  timeUntil,
} from '@polycode/shared'
import { openThread } from '@/lib/navigation'
import { QUEUE_BADGE_LABEL, queueBadgeKind } from '@/lib/queue-badge'
import { relativeTime } from '@/lib/time'
import { QUEUE_PAGE_SIZE, useThreadsStore } from '@/stores/threads'
import { useUiStore, type QueueFilter } from '@/stores/ui'
import { badge, colors, radii, sectionLabel } from '@/theme/colors'
import { ThreadStatusIndicator } from './StatusDot'
import { ActionSheet } from './ActionSheet'

/** Debounce for the search box, matching the desktop Queue. */
const SEARCH_DEBOUNCE_MS = 200

type SnoozeTarget = { thread: QueueThread }

/** Desktop tree rule: a running thread's unread flag is not yet a claim on attention. */
function isUnreadForAttention(thread: QueueThread): boolean {
  return thread.unread && thread.status !== 'running' && thread.status !== 'stopping'
}

function matchesFilter(thread: QueueThread, filter: QueueFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'unread') return isUnreadForAttention(thread)
  return thread.project_id === filter.projectId
}

function matchesSearch(thread: QueueThread, term: string): boolean {
  if (!term) return true
  return thread.name.toLowerCase().includes(term) || thread.project_name.toLowerCase().includes(term)
}

/**
 * A single Queue row: status, title, `project · location · when`, a preview
 * line, and a badge naming what the thread is waiting on.
 *
 * Rows carry their project name because the Queue is cross-project — without
 * it "fix the parser" is ambiguous across three repos. Actions live behind a
 * long-press ActionSheet rather than the desktop's hover buttons, since there
 * is no hover on a phone and Android's Alert.alert silently drops options past
 * the third.
 */
function QueueRow(props: {
  thread: QueueThread
  woken?: boolean
  onLongPress: (thread: QueueThread) => void
  onPress: (thread: QueueThread) => void
}) {
  const { thread, woken } = props
  const snoozed = isSnoozed(thread)
  const badgeKind = queueBadgeKind(thread)

  const when =
    snoozed && thread.snoozed_until
      ? `⏰ ${timeUntil(thread.snoozed_until)}`
      : relativeTime(thread.last_turn_completed_at ?? thread.updated_at)
  const location = thread.location_label ?? thread.git_branch
  const meta = [
    thread.project_name,
    location ? `${thread.location_is_worktree ? '⎇ ' : ''}${location}` : null,
    when,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <Pressable
      onPress={() => props.onPress(thread)}
      onLongPress={() => props.onLongPress(thread)}
      style={({ pressed }) => [styles.row, woken && styles.rowWoken, pressed && { opacity: 0.7 }]}
    >
      <View style={styles.rowStatus}>
        <ThreadStatusIndicator status={thread.status} unread={thread.unread} size={8} />
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowTitleLine}>
          <Text style={[styles.rowName, thread.unread && styles.rowNameUnread]} numberOfLines={1}>
            {thread.name}
          </Text>
          {badgeKind ? (
            <View style={[styles.badge, { backgroundColor: badge[badgeKind].bg }]}>
              <Text style={[styles.badgeText, { color: badge[badgeKind].fg }]}>{QUEUE_BADGE_LABEL[badgeKind]}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {meta}
        </Text>
        {thread.preview ? (
          <Text style={[styles.rowPreview, thread.preview_is_error && { color: colors.danger }]} numberOfLines={1}>
            {thread.preview.replace(/\s+/g, ' ').trim()}
          </Text>
        ) : null}
      </View>
    </Pressable>
  )
}

function SectionHeader(props: { label: string; count: number }) {
  if (props.count === 0) return null
  return (
    <View style={styles.sectionHeader}>
      <Text style={sectionLabel}>{props.label}</Text>
      <Text style={styles.sectionHeaderCount}>{props.count}</Text>
    </View>
  )
}

function FilterChip(props: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={props.onPress}
      style={({ pressed }) => [styles.filterChip, props.active && styles.filterChipActive, pressed && { opacity: 0.7 }]}
    >
      <Text style={[styles.filterChipText, props.active && { color: colors.accent }]} numberOfLines={1}>
        {props.label}
      </Text>
    </Pressable>
  )
}

/**
 * The Queue's collapsed Snoozed and Archived sections.
 *
 * Expansion is deliberately ephemeral (not persisted): these are places you
 * visit to retrieve something, not a view state you want restored on launch.
 * Paging and search both run server-side so the section never lies about what
 * exists beyond the first page. The filter chips, by contrast, are applied
 * client-side over each page — so a filtered page can look short, and "Show
 * more" may be needed to reach matching rows further down.
 */
function CollapsedQueueSection(props: {
  label: string
  variant: 'snoozed' | 'archived'
  search: string
  filter: QueueFilter
  onSelect: (thread: QueueThread) => void
  onLongPress: (thread: QueueThread) => void
  /** Bumped by the parent whenever a mutation may have changed membership. */
  revision: number
}) {
  const { variant, search, filter, revision } = props
  const [expanded, setExpanded] = useState(false)
  const [threads, setThreads] = useState<QueueThread[]>([])
  const [offset, setOffset] = useState(0)
  const [exhausted, setExhausted] = useState(false)
  const [loading, setLoading] = useState(false)
  const listQueueSnoozed = useThreadsStore((s) => s.listQueueSnoozed)
  const listQueueArchived = useThreadsStore((s) => s.listQueueArchived)

  const fetchPage = useCallback(
    async (nextOffset: number, signal?: { cancelled: boolean }) => {
      const list = variant === 'snoozed' ? listQueueSnoozed : listQueueArchived
      setLoading(true)
      try {
        const page = await list(search || null, nextOffset)
        // A superseded fetch must not overwrite the current one: search and
        // expansion both retrigger this, and responses can land out of order.
        if (signal?.cancelled) return
        setThreads((prev) => (nextOffset === 0 ? page : [...prev, ...page]))
        setOffset(nextOffset)
        setExhausted(page.length < QUEUE_PAGE_SIZE)
      } catch (error) {
        if (signal?.cancelled) return
        Alert.alert(`Could not load ${props.label.toLowerCase()} threads`, String(error))
      } finally {
        if (!signal?.cancelled) setLoading(false)
      }
    },
    [variant, search, listQueueSnoozed, listQueueArchived, props.label],
  )

  // A search term forces the section open, so a match can never hide behind a
  // collapsed header — that would make the search look like it found nothing.
  const open = expanded || search.length > 0

  // Fetching is synchronisation with an external system (the host), so it
  // belongs in an effect — but the first setState must not run synchronously
  // in the effect body, hence the microtask hop and the cancellation flag.
  useEffect(() => {
    if (!open) return undefined
    const signal = { cancelled: false }
    void Promise.resolve().then(() => {
      if (!signal.cancelled) void fetchPage(0, signal)
    })
    return () => {
      signal.cancelled = true
    }
  }, [open, fetchPage, revision])

  const visible = threads.filter((t) => matchesFilter(t, filter))

  return (
    <View>
      <Pressable style={styles.collapsedHeader} onPress={() => setExpanded((v) => !v)}>
        <Text style={[styles.chevron, open && styles.chevronOpen]}>▸</Text>
        <Text style={styles.collapsedHeaderText}>{props.label}</Text>
        {loading && open ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
      </Pressable>
      {open ? (
        <View>
          {visible.length === 0 && !loading ? <Text style={styles.emptySection}>Nothing here.</Text> : null}
          {visible.map((thread) => (
            <QueueRow key={thread.id} thread={thread} onPress={props.onSelect} onLongPress={props.onLongPress} />
          ))}
          {!exhausted && threads.length > 0 ? (
            <Pressable style={styles.showMore} onPress={() => void fetchPage(offset + QUEUE_PAGE_SIZE)}>
              <Text style={styles.showMoreText}>Show more</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

/**
 * The Queue: the cross-project list of Threads ordered by need for attention.
 *
 * Ordering is not decided here — `bucketQueueThreads` in @polycode/shared is
 * the single source of that truth, shared with the desktop so the two clients
 * cannot disagree about what needs the user first. Filter chips and search
 * narrow the *input* to bucketing, so there is only one bucketing pass.
 */
export function QueueView() {
  const router = useRouter()
  const queueThreads = useThreadsStore((s) => s.queueThreads)
  const queueLoading = useThreadsStore((s) => s.queueLoading)
  const fetchQueue = useThreadsStore((s) => s.fetchQueue)
  const snooze = useThreadsStore((s) => s.snooze)
  const wake = useThreadsStore((s) => s.wake)
  const archive = useThreadsStore((s) => s.archive)
  const unarchive = useThreadsStore((s) => s.unarchive)
  const filter = useUiStore((s) => s.queueFilter)
  const setFilter = useUiStore((s) => s.setQueueFilter)

  const [rawSearch, setRawSearch] = useState('')
  const [search, setSearch] = useState('')
  const [actionTarget, setActionTarget] = useState<QueueThread | null>(null)
  const [snoozeTarget, setSnoozeTarget] = useState<SnoozeTarget | null>(null)
  const [revision, setRevision] = useState(0)
  const bumpRevision = useCallback(() => setRevision((r) => r + 1), [])

  useEffect(() => {
    const id = setTimeout(() => setSearch(rawSearch.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [rawSearch])

  useEffect(() => {
    void fetchQueue()
  }, [fetchQueue])

  // Project chips come from the Queue rows themselves rather than the
  // Projects store, so they work before that store has loaded and never list
  // a project with nothing in the Queue.
  const projectChips = useMemo(() => {
    const byId = new Map<string, string>()
    for (const t of queueThreads) byId.set(t.project_id, t.project_name)
    return [...byId.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [queueThreads])

  const unreadCount = useMemo(() => queueThreads.filter(isUnreadForAttention).length, [queueThreads])

  // Live status arrives via SSE and is patched into `queueThreads` in place, so
  // rows stay current without a refetch; bucketing re-runs on every change.
  const visible = useMemo(() => {
    const term = search.toLowerCase()
    const input = queueThreads.filter((t) => matchesFilter(t, filter) && matchesSearch(t, term))
    return bucketQueueThreads(input, {})
  }, [queueThreads, filter, search])

  const handleSelect = useCallback((thread: QueueThread) => openThread(router, thread), [router])

  const runAction = useCallback(
    async (label: string, action: () => Promise<void>) => {
      try {
        await action()
        bumpRevision()
      } catch (error) {
        Alert.alert(`Could not ${label}`, String(error))
      }
    },
    [bumpRevision],
  )

  const actionOptions = useMemo(() => {
    if (!actionTarget) return []
    const thread = actionTarget
    const options: { label: string; destructive?: boolean; onPress: () => void }[] = []

    if (thread.archived) {
      options.push({
        label: 'Unarchive',
        onPress: () => void runAction('unarchive thread', () => unarchive(thread.project_id, thread.id)),
      })
      return options
    }

    if (isSnoozed(thread)) {
      options.push({
        label: 'Wake now',
        onPress: () => void runAction('wake thread', () => wake(thread.project_id, thread.id)),
      })
    } else {
      options.push({ label: 'Snooze', onPress: () => setSnoozeTarget({ thread }) })
    }

    options.push({
      label: 'Archive',
      onPress: () => void runAction('archive thread', () => archive(thread.project_id, thread.id)),
    })
    return options
  }, [actionTarget, runAction, wake, archive, unarchive])

  const isEmpty =
    visible.woken.length === 0 &&
    visible.attention.length === 0 &&
    visible.running.length === 0 &&
    visible.fresh.length === 0

  const activeProjectId = typeof filter === 'object' ? filter.projectId : null

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.search}
        value={rawSearch}
        onChangeText={setRawSearch}
        placeholder="Search threads"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        clearButtonMode="while-editing"
      />

      {/* flexGrow: 0 — a ScrollView otherwise claims a share of the column alongside the list. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0 }}
        contentContainerStyle={styles.filterRow}
        keyboardShouldPersistTaps="handled"
      >
        <FilterChip label="All" active={filter === 'all'} onPress={() => setFilter('all')} />
        <FilterChip
          label={unreadCount > 0 ? `Unread ${unreadCount}` : 'Unread'}
          active={filter === 'unread'}
          onPress={() => setFilter('unread')}
        />
        {projectChips.map((project) => (
          <FilterChip
            key={project.id}
            label={project.name}
            active={activeProjectId === project.id}
            onPress={() => setFilter({ projectId: project.id })}
          />
        ))}
      </ScrollView>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={queueLoading}
            onRefresh={() => {
              void fetchQueue()
              bumpRevision()
            }}
            tintColor={colors.textMuted}
          />
        }
      >
        {isEmpty && !search ? (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>▤</Text>
            <Text style={styles.emptyText}>
              {filter === 'all' ? 'Nothing needs your attention.' : 'Nothing matches this filter.'}
            </Text>
          </View>
        ) : null}

        {/*
          Woken threads render bare, above every section header: the user asked
          to be shown them at this moment, which is a stronger claim than any
          bucket membership.
        */}
        {visible.woken.map((thread) => (
          <QueueRow key={thread.id} thread={thread} woken onPress={handleSelect} onLongPress={setActionTarget} />
        ))}

        <SectionHeader label="Needs attention" count={visible.attention.length} />
        {visible.attention.map((thread) => (
          <QueueRow key={thread.id} thread={thread} onPress={handleSelect} onLongPress={setActionTarget} />
        ))}

        <SectionHeader label="Running" count={visible.running.length} />
        {visible.running.map((thread) => (
          <QueueRow key={thread.id} thread={thread} onPress={handleSelect} onLongPress={setActionTarget} />
        ))}

        <SectionHeader label="New" count={visible.fresh.length} />
        {visible.fresh.map((thread) => (
          <QueueRow key={thread.id} thread={thread} onPress={handleSelect} onLongPress={setActionTarget} />
        ))}

        {/* Snoozed above Archived: temporary and returning vs terminal. */}
        <CollapsedQueueSection
          label="Snoozed"
          variant="snoozed"
          search={search}
          filter={filter}
          revision={revision}
          onSelect={handleSelect}
          onLongPress={setActionTarget}
        />
        <CollapsedQueueSection
          label="Archived"
          variant="archived"
          search={search}
          filter={filter}
          revision={revision}
          onSelect={handleSelect}
          onLongPress={setActionTarget}
        />
      </ScrollView>

      <ActionSheet
        visible={actionTarget !== null}
        title={actionTarget?.name}
        onClose={() => setActionTarget(null)}
        options={actionOptions}
      />

      {/*
        Presets resolve on the device, so "tomorrow morning" means morning where
        the user is. Each is labelled with the absolute instant it resolves to,
        so a roll-forward is visible rather than inferred.
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
                  onPress: () =>
                    void runAction('snooze thread', () =>
                      snooze(snoozeTarget.thread.project_id, snoozeTarget.thread.id, at.toISOString()),
                    ),
                }
              })
            : []
        }
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  search: {
    marginHorizontal: 12,
    marginTop: 10,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radii.input,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: 14,
  },
  filterRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  filterChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    paddingVertical: 5,
    paddingHorizontal: 12,
    backgroundColor: colors.surface,
    maxWidth: 160,
  },
  filterChipActive: { borderColor: colors.accent, backgroundColor: colors.accentTint },
  filterChipText: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  scroll: { flex: 1 },
  // Room for the floating New-thread button over the last row.
  scrollContent: { paddingBottom: 96 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginHorizontal: 12,
    marginVertical: 6,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
  },
  // The woken marker: desktop paints a 2px accent rail down the left edge.
  rowWoken: { borderLeftColor: colors.accent, backgroundColor: 'rgba(232, 123, 95, 0.06)' },
  rowStatus: { paddingTop: 4, width: 14, alignItems: 'center' },
  rowBody: { flex: 1, gap: 3 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowName: { color: colors.text, fontSize: 14, flex: 1 },
  rowNameUnread: { fontWeight: '700', color: '#ffffff' },
  rowMeta: { color: colors.textMuted, fontSize: 11 },
  rowPreview: { color: colors.textMuted, fontSize: 12.5, opacity: 0.9 },
  badge: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  badgeText: { fontSize: 9.5, fontWeight: '800', letterSpacing: 0.6 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 2,
  },
  sectionHeaderCount: { color: colors.textMuted, fontSize: 10, fontWeight: '600' },
  collapsedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 4,
  },
  collapsedHeaderText: { ...sectionLabel, flex: 1 },
  chevron: { color: colors.textMuted, fontSize: 12 },
  chevronOpen: { transform: [{ rotate: '90deg' }] },
  emptySection: { color: colors.textMuted, fontSize: 12, paddingHorizontal: 16, paddingVertical: 8 },
  showMore: { paddingHorizontal: 16, paddingVertical: 10 },
  showMoreText: { color: colors.accent, fontSize: 13 },
  empty: { alignItems: 'center', paddingTop: 64, gap: 10 },
  emptyIcon: { color: colors.textMuted, fontSize: 28 },
  emptyText: { color: colors.textMuted, fontSize: 14 },
})
