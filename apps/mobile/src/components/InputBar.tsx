import { useState, type ReactNode } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import type { SlashCommand, ThreadStatus } from '@polycode/shared'
import type { PendingImage } from '@/lib/attachments'
import { colors, radii } from '@/theme/colors'

export type { PendingImage }

export function InputBar(props: {
  status: ThreadStatus
  onSend: (content: string, planMode: boolean) => void
  onStop: () => void
  /** Extra parameter chips rendered beside the Plan mode toggle. */
  accessories?: ReactNode
  /** Available slash commands — typing "/" filters and inserts them. */
  slashCommands?: SlashCommand[]
  /** Pending image attachments (chips above the input). */
  attachments?: PendingImage[]
  onAddAttachment?: () => void
  onRemoveAttachment?: (id: string) => void
}) {
  const [text, setText] = useState('')
  const [planMode, setPlanMode] = useState(false)
  const busy = props.status === 'running' || props.status === 'stopping'
  const attachments = props.attachments ?? []

  // "/" at the start (before any space) opens the command popup.
  const slashQuery = text.startsWith('/') && !/\s/.test(text) ? text.slice(1).toLowerCase() : null
  const slashMatches =
    slashQuery !== null
      ? (props.slashCommands ?? []).filter((cmd) => cmd.name.toLowerCase().startsWith(slashQuery)).slice(0, 8)
      : []

  const submit = () => {
    const content = text.trim()
    if (!content && attachments.length === 0) return
    props.onSend(content, planMode)
    setText('')
  }
  const canSend = text.trim().length > 0 || attachments.length > 0

  return (
    <View style={styles.container}>
      {slashMatches.length > 0 ? (
        <ScrollView style={styles.slashPopup} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
          {slashMatches.map((cmd) => (
            <Pressable
              key={cmd.id}
              onPress={() => setText(`/${cmd.invocation ?? cmd.name} `)}
              style={({ pressed }) => [styles.slashRow, pressed && { opacity: 0.7 }]}
            >
              <Text style={styles.slashName}>/{cmd.name}</Text>
              {cmd.description ? (
                <Text style={styles.slashDescription} numberOfLines={1}>
                  {cmd.description}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {attachments.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.attachmentRow}>
          {attachments.map((attachment) => (
            <View key={attachment.id} style={styles.attachmentChip}>
              <Text style={styles.attachmentName} numberOfLines={1}>
                🖼 {attachment.name}
              </Text>
              <Pressable onPress={() => props.onRemoveAttachment?.(attachment.id)} hitSlop={8}>
                <Text style={styles.attachmentRemove}>✕</Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}
      <View style={styles.row}>
        {props.onAddAttachment ? (
          <Pressable style={styles.attachButton} onPress={props.onAddAttachment} hitSlop={6}>
            <Text style={styles.attachIcon}>＋</Text>
          </Pressable>
        ) : null}
        <TextInput
          style={styles.input}
          placeholder={busy ? 'Agent is working… (message will queue)' : 'Message the agent…'}
          placeholderTextColor={colors.textMuted}
          value={text}
          onChangeText={setText}
          multiline
          submitBehavior="newline"
        />
        {busy ? (
          <Pressable style={[styles.sendButton, styles.stopButton]} onPress={props.onStop}>
            <Text style={styles.stopIcon}>■</Text>
          </Pressable>
        ) : null}
        <Pressable style={[styles.sendButton, !canSend && { opacity: 0.4 }]} onPress={submit} disabled={!canSend}>
          <Text style={styles.sendIcon}>➤</Text>
        </Pressable>
      </View>
      {/* Parameter chips sit under the composer, as on the desktop toolbar. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0 }}
        contentContainerStyle={styles.chipRow}
        keyboardShouldPersistTaps="handled"
      >
        <Pressable onPress={() => setPlanMode((v) => !v)} hitSlop={6}>
          <View style={[styles.planChip, planMode && styles.planChipActive]}>
            <Text style={[styles.planChipText, planMode && { color: colors.accent }]}>Plan mode</Text>
          </View>
        </Pressable>
        {props.accessories}
        {props.status === 'stopping' ? <Text style={styles.statusHint}>Stopping…</Text> : null}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 10,
    gap: 8,
  },
  chipRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 8 },
  slashPopup: {
    maxHeight: 220,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: colors.surface2,
    marginBottom: 4,
  },
  slashRow: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: 2,
  },
  slashName: { color: colors.claude, fontSize: 13.5, fontWeight: '600', fontFamily: 'monospace' },
  slashDescription: { color: colors.textMuted, fontSize: 12 },
  planChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    paddingVertical: 5,
    paddingHorizontal: 11,
  },
  planChipActive: { borderColor: colors.accent, backgroundColor: colors.accentTint },
  planChipText: { color: colors.textMuted, fontSize: 12, fontWeight: '500' },
  statusHint: { color: colors.warning, fontSize: 12 },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  attachmentRow: { flexDirection: 'row', gap: 8, paddingBottom: 2 },
  attachmentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: 220,
  },
  attachmentName: { color: colors.text, fontSize: 12.5, flexShrink: 1 },
  attachmentRemove: { color: colors.textMuted, fontSize: 13 },
  attachButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachIcon: { color: colors.textMuted, fontSize: 20, marginTop: -2 },
  input: {
    flex: 1,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.input,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: colors.text,
    fontSize: 15,
    maxHeight: 130,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.claude,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopButton: { backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.danger },
  sendIcon: { color: '#1a1a1a', fontSize: 16, fontWeight: '700' },
  stopIcon: { color: colors.danger, fontSize: 14 },
})
