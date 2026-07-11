import { useEffect, useState } from 'react'
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import type { Thread } from '@polycode/shared'
import { useThreadsStore } from '@/stores/threads'
import { colors } from '@/theme/colors'
import { Button, Field } from './ui'

export function RenameThreadModal(props: {
  target: { projectId: string; thread: Thread } | null
  onClose: () => void
}) {
  const { target, onClose } = props
  const rename = useThreadsStore((s) => s.rename)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (target) setName(target.thread.name)
  }, [target])

  const submit = async () => {
    if (!target || !name.trim()) return
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
    <Modal visible={target !== null} transparent animationType="fade" onRequestClose={onClose}>
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
