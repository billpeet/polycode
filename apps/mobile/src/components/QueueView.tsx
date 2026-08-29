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
import { QUEUE_PAGE_SIZE, useThreadsStore } from '@/stores/threads'
import { useUiStore } from '@/stores/ui'
import { colors } from '@/theme/colors'
import { relativeTime } from '@/lib/time'
import { ThreadStatusIndicator } from './StatusDot'
import { ActionSheet } from './ActionSheet'

/** Debounce for the search box, matching the desktop Queue. */
const SEARCH_DEBOUNCE_MS = 200

type SnoozeTarget = { thread: QueueThread }

/**
 * A single Queue row.
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
  const selectedThreadId = useUiStore((s) => s.selectedThreadId)
  const selected = selectedThreadId === thread.id
  const snoozed = isSnoozed(thread)

  const subtitle = [
    thread.project_name,
    thread.location_is_worktree && thread.location_label ? `⎇ ${thread.location_label}` : thread.location_label,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <Pressable
      onPress={() => props.onPress(thread)}
      onLongPress={() => props.onLongPress(thread)}
      style={({ pressed }) => [
        styles.row,
        woken && styles.rowWoken,
        selected && styles.rowSelected,
        pressed && { opacity: 0.7 },
      ]}
    >
      <ThreadStatusIndicator status={thread.status} unread={thread.unread} size={7} />
      <View style={styles.rowBody}>
        <Text
          style={[styles.rowName, thread.unread && { fontWeight: '700', color: '#ffffff' }]}
          numberOfLines={1}
        >
          {thread.name}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      {snoozed && thread.snoozed_until ? (
        <Text style={styles.rowWhen}>⏰ {timeUntil(thread.snoozed_until)}</Text>
      ) : (
        <Text style={styles.rowWhen}>{relativeTime(thread.last_turn_completed_at ?? thread.updated_at)}</Text>
      )}
    </Pressable>
  )
}

function SectionHeader(props: { label: string; count: number }) {
  if (props.count === 0) return null
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionHeaderText}>{props.label}</Text>
      <Text style={styles.sectionHeaderCount}>{props.count}</Text>
    </View>
  )
}

/**
 * The Queue's collapsed Snoozed and Archived sections.
 *
 * Expansion is deliberately ephemeral (not persisted): these are places you
 * visit to retrieve something, not a view state you want restored on launch.
 * Paging and search both run server-side so the section never lies about what
 * exists beyond the first page.
 */
function CollapsedQueueSection(props: {
  label: string
  variant: 'snoozed' | 'archived'
  search: string
  onSelect: (thread: QueueThread) => void
  onLongPress: (thread: QueueThread) => void
  /** Bumped by the parent whenever a mutation may have changed membership. */
  revision: number
}) {
  const { variant, search, revision } = props
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

  return (
    <View>
      <Pressable style={styles.collapsedHeader} onPress={() => setExpanded((v) => !v)}>
        <Text style={[styles.chevron, open && styles.chevronOpen]}>▸</Text>
        <Text style={styles.collapsedHeaderText}>{props.label}</Text>
        {loading && open ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
      </Pressable>
      {open ? (
        <View>
          {threads.length === 0 && !loading ? (
            <Text style={styles.emptySection}>Nothing here.</Text>
          ) : null}
          {threads.map((thread) => (
            <QueueRow
              key={thread.id}
              thread={thread}
              onPress={props.onSelect}
              onLongPress={props.onLongPress}
            />
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
 * cannot disagree about what needs the user first.
 */
export function QueueView() {
  const queueThreads = useThreadsStore((s) => s.queueThreads)
  const queueLoading = useThreadsStore((s) => s.queueLoading)
  const fetchQueue = useThreadsStore((s) => s.fetchQueue)
  const snooze = useThreadsStore((s) => s.snooze)
  const wake = useThreadsStore((s) => s.wake)
  const archive = useThreadsStore((s) => s.archive)
  const unarchive = useThreadsStore((s) => s.unarchive)
  const selectThread = useUiStore((s) => s.selectThread)

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

  // Live status arrives via SSE and is patched into `queueThreads` in place, so
  // rows stay current without a refetch; bucketing re-runs on every change.
  const buckets = useMemo(() => bucketQueueThreads(queueThreads, {}), [queueThreads])

  const visible = useMemo(() => {
    if (!search) return buckets
    const term = search.toLowerCase()
    const match = (t: QueueThread) =>
      t.name.toLowerCase().includes(term) || t.project_name.toLowerCase().includes(term)
    return {
      woken: buckets.woken.filter(match),
      attention: buckets.attention.filter(match),
      running: buckets.running.filter(match),
      fresh: buckets.fresh.filter(match),
    }
  }, [buckets, search])

  const handleSelect = useCallback(
    (thread: QueueThread) => selectThread(thread.project_id, thread.id),
    [selectThread],
  )

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
            <Text style={styles.emptyText}>Nothing needs your attention.</Text>
          </View>
        ) : null}

        {/*
          Woken threads render bare, above every section header: the user asked
          to be shown them at this moment, which is a stronger claim than any
          bucket membership.
        */}
        {visible.woken.map((thread) => (
          <QueueRow
            key={thread.id}
            thread={thread}
            woken
            onPress={handleSelect}
            onLongPress={setActionTarget}
          />
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
          revision={revision}
          onSelect={handleSelect}
          onLongPress={setActionTarget}
        />
        <CollapsedQueueSection
          label="Archived"
          variant="archived"
          search={search}
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
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: 14,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 24 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
  },
  // The woken marker: desktop paints a 2px accent rail down the left edge.
  rowWoken: { borderLeftColor: colors.claude, backgroundColor: 'rgba(232, 123, 95, 0.06)' },
  rowSelected: { backgroundColor: colors.surface2 },
  rowBody: { flex: 1, gap: 2 },
  rowName: { color: colors.text, fontSize: 14 },
  rowMeta: { color: colors.textMuted, fontSize: 11 },
  rowWhen: { color: colors.textMuted, fontSize: 11 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingTop: 16,
    paddingBottom: 6,
  },
  sectionHeaderText: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  sectionHeaderCount: { color: colors.textMuted, fontSize: 11 },
  collapsedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingTop: 16,
    paddingBottom: 6,
  },
  collapsedHeaderText: { color: colors.textMuted, fontSize: 12, fontWeight: '600', flex: 1 },
  chevron: { color: colors.textMuted, fontSize: 12 },
  chevronOpen: { transform: [{ rotate: '90deg' }] },
  emptySection: { color: colors.textMuted, fontSize: 12, paddingHorizontal: 14, paddingVertical: 8 },
  showMore: { paddingHorizontal: 14, paddingVertical: 10 },
  showMoreText: { color: colors.claude, fontSize: 13 },
  empty: { alignItems: 'center', paddingTop: 64, gap: 10 },
  emptyIcon: { color: colors.textMuted, fontSize: 28 },
  emptyText: { color: colors.textMuted, fontSize: 14 },
})
