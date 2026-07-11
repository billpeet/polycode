/**
 * Git panel for the thread's repo location: branch + ahead/behind, staged and
 * unstaged changes (tap to stage/unstage, long-press to discard), commit with
 * AI-generated message, push (with set-upstream) and pull.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { GitFileChange, GitStatus } from '@polycode/shared'
import { rpc } from '@/api/rpc'
import { useHostsStore } from '@/stores/hosts'
import { colors } from '@/theme/colors'
import { Button } from './ui'

function statusColor(status: GitFileChange['status']): string {
  switch (status) {
    case 'A':
    case '?':
      return colors.success
    case 'D':
      return colors.danger
    case 'R':
      return colors.info
    case 'U':
      return colors.warning
    case 'M':
    default:
      return colors.claude
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function FileRow(props: {
  change: GitFileChange
  onPress: () => void
  onLongPress: () => void
}) {
  const { change } = props
  return (
    <Pressable
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      style={({ pressed }) => [styles.fileRow, pressed && { opacity: 0.7 }]}
    >
      <Text style={[styles.fileStatus, { color: statusColor(change.status) }]}>{change.status}</Text>
      <Text style={styles.filePath} numberOfLines={1}>
        {change.path}
      </Text>
    </Pressable>
  )
}

export function GitPanel(props: { repoPath: string | null; visible: boolean; onClose: () => void }) {
  const { repoPath, visible, onClose } = props
  const insets = useSafeAreaInsets()
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [working, setWorking] = useState<string | null>(null)

  const connection = () => useHostsStore.getState().activeConnection()

  const refresh = useCallback(async () => {
    const conn = connection()
    if (!conn || !repoPath) return
    setLoading(true)
    try {
      setStatus(await rpc(conn, 'git:status', repoPath))
    } catch (error) {
      Alert.alert('Git status failed', errorText(error))
    } finally {
      setLoading(false)
    }
  }, [repoPath])

  useEffect(() => {
    if (visible) void refresh()
  }, [visible, refresh])

  const run = useCallback(
    async (label: string, action: () => Promise<unknown>, options?: { refetch?: boolean }) => {
      setWorking(label)
      try {
        await action()
        if (options?.refetch !== false) await refresh()
      } catch (error) {
        Alert.alert(`${label} failed`, errorText(error))
      } finally {
        setWorking(null)
      }
    },
    [refresh],
  )

  if (!visible) return null

  const staged = status?.files.filter((f) => f.staged) ?? []
  const unstaged = status?.files.filter((f) => !f.staged) ?? []
  const conn = connection()
  const ready = conn && repoPath

  const confirmDiscard = (change: GitFileChange) => {
    if (!ready) return
    Alert.alert('Discard changes?', `Revert "${change.path}" to HEAD? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: () => void run('Discard', () => rpc(conn!, 'git:discardFile', repoPath!, change.path, change.oldPath ?? null)),
      },
    ])
  }

  const doPush = () => {
    if (!ready || !status) return
    void run('Push', async () => {
      if (status.hasUpstream) {
        await rpc(conn!, 'git:push', repoPath!)
      } else {
        await rpc(conn!, 'git:pushSetUpstream', repoPath!, status.branch)
      }
    })
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        {/* Header */}
        <View style={styles.header}>
          <Pressable onPress={onClose} hitSlop={10}>
            <Text style={styles.closeIcon}>✕</Text>
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={styles.title} numberOfLines={1}>
              ⎇ {status?.branch ?? 'git'}
            </Text>
            {status ? (
              <Text style={styles.subtitle}>
                {status.ahead > 0 ? `↑${status.ahead} ` : ''}
                {status.behind > 0 ? `↓${status.behind} ` : ''}
                +{status.additions} −{status.deletions}
                {!status.hasUpstream ? ' · no upstream' : ''}
              </Text>
            ) : null}
          </View>
          {working ? <ActivityIndicator size="small" color={colors.claude} /> : null}
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 14, gap: 14 }}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={colors.claude} />}
        >
          {/* Staged */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Staged ({staged.length})</Text>
            {staged.length > 0 && ready ? (
              <Pressable onPress={() => void run('Unstage all', () => rpc(conn!, 'git:unstageAll', repoPath!))} hitSlop={6}>
                <Text style={styles.sectionAction}>Unstage all</Text>
              </Pressable>
            ) : null}
          </View>
          {staged.map((change) => (
            <FileRow
              key={`s-${change.path}`}
              change={change}
              onPress={() => ready && void run('Unstage', () => rpc(conn!, 'git:unstage', repoPath!, change.path))}
              onLongPress={() => confirmDiscard(change)}
            />
          ))}

          {/* Unstaged */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Changes ({unstaged.length})</Text>
            {unstaged.length > 0 && ready ? (
              <Pressable onPress={() => void run('Stage all', () => rpc(conn!, 'git:stageAll', repoPath!))} hitSlop={6}>
                <Text style={styles.sectionAction}>Stage all</Text>
              </Pressable>
            ) : null}
          </View>
          {unstaged.map((change) => (
            <FileRow
              key={`u-${change.path}`}
              change={change}
              onPress={() => ready && void run('Stage', () => rpc(conn!, 'git:stage', repoPath!, change.path))}
              onLongPress={() => confirmDiscard(change)}
            />
          ))}

          {status && status.files.length === 0 ? <Text style={styles.clean}>Working tree clean ✓</Text> : null}
        </ScrollView>

        {/* Commit + sync actions */}
        <View style={styles.footer}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput
              style={styles.commitInput}
              placeholder="Commit message…"
              placeholderTextColor={colors.textMuted}
              value={message}
              onChangeText={setMessage}
              multiline
            />
            <Button
              small
              title="✨"
              variant="secondary"
              onPress={() =>
                ready &&
                void run(
                  'Generate message',
                  async () => setMessage(await rpc(conn!, 'git:generateCommitMessage', repoPath!)),
                  { refetch: false },
                )
              }
            />
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button
              small
              title="Pull"
              variant="secondary"
              onPress={() => ready && void run('Pull', () => rpc(conn!, 'git:pull', repoPath!, true))}
              style={{ flex: 1 }}
            />
            <Button
              small
              title={status?.hasUpstream ? 'Push' : 'Push (set upstream)'}
              variant="secondary"
              onPress={doPush}
              style={{ flex: 1 }}
            />
            <Button
              small
              title={`Commit${staged.length > 0 ? ` (${staged.length})` : ''}`}
              onPress={() => {
                if (!ready || !message.trim()) return
                void run('Commit', async () => {
                  await rpc(conn!, 'git:commit', repoPath!, message.trim())
                  setMessage('')
                })
              }}
              disabled={!message.trim() || staged.length === 0}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  closeIcon: { color: colors.text, fontSize: 18 },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  sectionAction: { color: colors.claude, fontSize: 12, fontWeight: '600' },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  fileStatus: { fontFamily: 'monospace', fontSize: 13, fontWeight: '700', width: 14 },
  filePath: { color: colors.text, fontSize: 13, fontFamily: 'monospace', flex: 1 },
  clean: { color: colors.success, fontSize: 13.5, textAlign: 'center', paddingVertical: 18 },
  footer: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    padding: 12,
    gap: 10,
  },
  commitInput: {
    flex: 1,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: colors.text,
    fontSize: 14,
    maxHeight: 90,
  },
})
