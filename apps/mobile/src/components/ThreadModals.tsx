import { useState } from 'react'
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import type { Thread } from '@polycode/shared'
import { useThreadsStore } from '@/stores/threads'
import { colors } from '@/theme/colors'
import { Button, Field } from './ui'

function RenameThreadModalContent(props: {
  target: { projectId: string; thread: Thread }
  onClose: () => void
}) {
  const { target, onClose } = props
  const rename = useThreadsStore((s) => s.rename)
  const [name, setName] = useState(target.thread.name)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      await rename(target.projectId, target.thread.id, name.trim())
      onClose()
    } catch (error) {
      Alert.alert('Could not rename thread', error instanceof Error ? error.message : String(error))
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

export function RenameThreadModal(props: {
  target: { projectId: string; thread: Thread } | null
  onClose: () => void
}) {
  if (!props.target) return null
  return (
    <RenameThreadModalContent
      key={`${props.target.projectId}:${props.target.thread.id}`}
      target={props.target}
      onClose={props.onClose}
    />
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
})
