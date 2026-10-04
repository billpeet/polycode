import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { Thread } from '@polycode/shared'
import { formatWakeTime, resolveSnoozePreset, SNOOZE_PRESETS, timeUntil } from '@polycode/shared'
import { colors, radii } from '@/theme/colors'
import { ActionSheet } from './ActionSheet'
import { Button, Field } from './ui'

/**
 * Thread overlays shared by the single-host tree and the unified ("All") tree. Neither
 * knows which host a Thread lives on: each takes a `target` (whatever the caller needs to
 * find the Thread again — a project id, or a host and a project id) and a set of
 * operations on it, so the same sheet drives the active host's stores or any host's.
 */

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function RenameThreadModalContent(props: {
  thread: Thread
  onRename: (name: string) => Promise<void>
  onClose: () => void
}) {
  const { thread, onRename, onClose } = props
  const [name, setName] = useState(thread.name)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      await onRename(name.trim())
      onClose()
    } catch (error) {
      Alert.alert('Could not rename thread', errorText(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => undefined}>
          <Text style={styles.title}>Rename Thread</Text>
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

export interface ThreadActionOps<T> {
  rename: (target: T, name: string) => Promise<void>
  reset: (target: T) => Promise<void>
  snooze: (target: T, untilIso: string) => Promise<void>
  archive: (target: T) => Promise<void>
  remove: (target: T) => Promise<void>
}

/**
 * A tree row's long-press menu — rename, reset, snooze, archive, delete — with the
 * rename dialog and snooze presets it leads to.
 *
 * An ActionSheet rather than Alert.alert because Android silently drops options past the
 * third. Snooze offers presets only: they resolve on the device, so "tomorrow morning"
 * means morning in the phone's timezone, not the host's, and each is labelled with the
 * absolute instant it resolves to so a roll-forward is visible rather than inferred.
 */
export function ThreadActionSheets<T extends { key: string; thread: Thread }>(props: {
  target: T | null
  ops: ThreadActionOps<T>
  onClose: () => void
}) {
  const { target, ops } = props
  // The menu closes before its option runs, so follow-up dialogs keep their own target.
  const [renaming, setRenaming] = useState<T | null>(null)
  const [snoozing, setSnoozing] = useState<T | null>(null)

  const run = (label: string, action: Promise<void>): void => {
    action.catch((error: unknown) => Alert.alert(`Could not ${label}`, errorText(error)))
  }

  return (
    <>
      <ActionSheet
        visible={target !== null}
        title={target?.thread.name}
        onClose={props.onClose}
        options={
          target
            ? [
                { label: 'Rename', onPress: () => setRenaming(target) },
                {
                  label: 'Reset session',
                  onPress: () =>
                    Alert.alert('Reset session?', 'Clears the agent context for this thread (messages are kept).', [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Reset', style: 'destructive', onPress: () => run('reset session', ops.reset(target)) },
                    ]),
                },
                { label: 'Snooze', onPress: () => setSnoozing(target) },
                { label: 'Archive', onPress: () => run('archive thread', ops.archive(target)) },
                {
                  label: 'Delete',
                  destructive: true,
                  onPress: () =>
                    Alert.alert('Delete thread?', `Permanently delete "${target.thread.name}" and its messages?`, [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Delete', style: 'destructive', onPress: () => run('delete thread', ops.remove(target)) },
                    ]),
                },
              ]
            : []
        }
      />
      <ActionSheet
        visible={snoozing !== null}
        title="Snooze until"
        onClose={() => setSnoozing(null)}
        options={
          snoozing
            ? SNOOZE_PRESETS.map((preset) => {
                const at = resolveSnoozePreset(preset.id)
                return {
                  label: `${preset.label} · ${formatWakeTime(at)}`,
                  onPress: () => run('snooze thread', ops.snooze(snoozing, at.toISOString())),
                }
              })
            : []
        }
      />
      {renaming ? (
        <RenameThreadModalContent
          key={renaming.key}
          thread={renaming.thread}
          onRename={(name) => ops.rename(renaming, name)}
          onClose={() => setRenaming(null)}
        />
      ) : null}
    </>
  )
}

/** A snoozed row's wake time: "when does this come back" is all that matters about deferred work. */
export function snoozedDetail(thread: Thread): string | null {
  return thread.snoozed_until ? timeUntil(thread.snoozed_until) : null
}

export interface ThreadListAction<T> {
  label: string
  /** Asks before running; marks the action as destructive. */
  confirm?: { title: string; message: (thread: Thread) => string; button: string }
  run: (target: T, thread: Thread) => Promise<void>
}

/**
 * A bottom sheet listing one Project's snoozed or archived Threads, with a pair of
 * actions per row. `load` and `actions` must be stable across renders: `load` sits in
 * the fetch effect's dependencies.
 */
export function ThreadListModal<T>(props: {
  target: T | null
  title: string
  emptyText: string
  load: (target: T) => Promise<Thread[]>
  /** Extra text after a row's name (a snoozed Thread's wake time). */
  detail?: (thread: Thread) => string | null
  actions: ThreadListAction<T>[]
  onClose: () => void
}) {
  const { target, load, onClose, title } = props
  const [threads, setThreads] = useState<Thread[]>([])

  // Bumped per load; an answer for an earlier target (another host can be seconds
  // slower) or an earlier reload is dropped.
  const loadSeq = useRef(0)
  const reload = useCallback(() => {
    const seq = ++loadSeq.current
    if (target === null) return
    load(target)
      .then((loaded) => {
        if (loadSeq.current === seq) setThreads(loaded)
      })
      .catch((error: unknown) => {
        if (loadSeq.current === seq) Alert.alert(`Could not load ${title.toLowerCase()}`, errorText(error))
      })
  }, [target, load, title])

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      setThreads([])
      reload()
    }, 0)
    return () => clearTimeout(timeoutId)
  }, [reload])

  const runAction = (action: ThreadListAction<T>, thread: Thread): void => {
    if (target === null) return
    const go = (): void => {
      action
        .run(target, thread)
        .catch((error: unknown) => Alert.alert(`${action.label} failed`, errorText(error)))
        .finally(reload)
    }
    if (!action.confirm) {
      go()
      return
    }
    Alert.alert(action.confirm.title, action.confirm.message(thread), [
      { text: 'Cancel', style: 'cancel' },
      { text: action.confirm.button, style: 'destructive', onPress: go },
    ])
  }

  return (
    <Modal visible={target !== null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <Text style={styles.sheetTitle}>{props.title}</Text>
          <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: 10 }}>
            {threads.length === 0 ? <Text style={styles.emptyText}>{props.emptyText}</Text> : null}
            {threads.map((thread) => {
              const detail = props.detail?.(thread)
              return (
                <View key={thread.id} style={styles.listRow}>
                  <Text style={styles.listName} numberOfLines={1}>
                    {thread.name}
                    {detail ? ` · ${detail}` : ''}
                  </Text>
                  {props.actions.map((action) => (
                    <Pressable key={action.label} hitSlop={6} onPress={() => runAction(action, thread)}>
                      <Text style={[styles.listAction, action.confirm && { color: colors.danger }]}>{action.label}</Text>
                    </Pressable>
                  ))}
                </View>
              )
            })}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 18,
    gap: 14,
  },
  title: { color: colors.text, fontSize: 17, fontWeight: '700' },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 18,
    paddingBottom: 28,
    gap: 12,
  },
  sheetTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  emptyText: { color: colors.textMuted, fontSize: 13, padding: 16 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  listName: { color: colors.text, fontSize: 13.5, flex: 1 },
  listAction: { color: colors.accent, fontSize: 13, fontWeight: '600' },
})
